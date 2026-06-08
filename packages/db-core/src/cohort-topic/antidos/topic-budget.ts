/**
 * Cohort-topic substrate — per-cohort topic budget (anti-DoS).
 *
 * Transcribed from `docs/cohort-topic.md` §Anti-DoS bullet 2. A cohort holds forwarder state for at
 * most `topics_max` (default 2048) topics. Once the budget is full a request to instantiate a **new**
 * topic is refused (the caller answers `UnwillingCohort`); topics already in the budget continue to
 * serve. To keep room for genuinely active topics, the budget evicts cold ones: eviction order is
 * **LRU by participant count**, with **zero-recent-registration topics dropped first** — a topic that
 * carries no direct participants is the cheapest to shed and is shed before any populated topic.
 *
 * `admit` only ever evicts a *zero-participant* topic. If every resident topic still carries
 * participants the budget is genuinely saturated and the new instantiation is refused — an attacker
 * cannot, by flooding new topic ids, evict a topic that real participants are using. LRU ordering
 * uses a monotonic access counter bumped on every `admit`/`touch`, so it is deterministic and needs
 * no wall clock.
 */

import { bytesKey } from "../registration/bytes.js";
import { createLogger } from "../../logger.js";

const log = createLogger("cohort-topic:antidos");

/** Default per-cohort forwarder-topic ceiling — `topics_max`. */
export const DEFAULT_TOPICS_MAX = 2048;

export interface TopicBudgetConfig {
	/** Max topics with forwarder state. Default {@link DEFAULT_TOPICS_MAX}. */
	topicsMax?: number;
}

/** Per-cohort cap on the number of topics with forwarder state, with LRU eviction of cold topics. */
export interface TopicBudget {
	/**
	 * Admit `topicId` to the forwarder-state budget. Returns `true` if it is already resident or there
	 * is (or can be freed) room; `false` when the budget is full of populated topics, in which case the
	 * caller answers `UnwillingCohort` for the new instantiation. Admitting a *new* topic when full
	 * evicts the coldest zero-participant resident first.
	 */
	admit(topicId: Uint8Array): boolean;
	/**
	 * Record the current direct-participant count for a resident topic (LRU bookkeeping). Updates the
	 * eviction key and bumps the topic's recency; a no-op for a topic that is not resident.
	 */
	touch(topicId: Uint8Array, participantCount: number): void;
	/** Whether `topicId` currently holds forwarder state. */
	has(topicId: Uint8Array): boolean;
	/** Number of resident topics. */
	readonly size: number;
}

/** Per-resident eviction bookkeeping. */
interface ResidentState {
	/** Direct-participant count last reported via `touch` (eviction primary key; ascending = colder). */
	participantCount: number;
	/** Monotonic access sequence (LRU tiebreaker; lower = least-recently used). */
	seq: number;
}

class LruTopicBudget implements TopicBudget {
	private readonly residents = new Map<string, ResidentState>();
	private readonly topicsMax: number;
	private seqCounter = 0;

	constructor(config: TopicBudgetConfig = {}) {
		this.topicsMax = config.topicsMax ?? DEFAULT_TOPICS_MAX;
		if (!Number.isInteger(this.topicsMax) || this.topicsMax <= 0) {
			throw new RangeError(`topicsMax must be a positive integer, got ${this.topicsMax}`);
		}
	}

	get size(): number {
		return this.residents.size;
	}

	has(topicId: Uint8Array): boolean {
		return this.residents.has(bytesKey(topicId));
	}

	admit(topicId: Uint8Array): boolean {
		const key = bytesKey(topicId);
		const existing = this.residents.get(key);
		if (existing !== undefined) {
			existing.seq = ++this.seqCounter; // already resident — refresh recency, always allowed
			return true;
		}
		if (this.residents.size < this.topicsMax) {
			this.residents.set(key, { participantCount: 0, seq: ++this.seqCounter });
			return true;
		}
		// Full: only a zero-participant resident may be evicted to make room for a new topic.
		const victim = this.coldestEvictable();
		if (victim === undefined) {
			log("topic-budget full size=%d max=%d — refuse new topic", this.residents.size, this.topicsMax);
			return false;
		}
		this.residents.delete(victim);
		this.residents.set(key, { participantCount: 0, seq: ++this.seqCounter });
		log("topic-budget evicted cold topic to admit new (size=%d max=%d)", this.residents.size, this.topicsMax);
		return true;
	}

	touch(topicId: Uint8Array, participantCount: number): void {
		const key = bytesKey(topicId);
		const state = this.residents.get(key);
		if (state === undefined) {
			return;
		}
		state.participantCount = participantCount;
		state.seq = ++this.seqCounter;
	}

	/**
	 * The coldest evictable resident key: among zero-participant topics, the least-recently used.
	 * `undefined` when every resident still carries participants (nothing may be evicted for a new topic).
	 */
	private coldestEvictable(): string | undefined {
		let victim: string | undefined;
		let victimSeq = Infinity;
		for (const [key, state] of this.residents) {
			if (state.participantCount > 0) {
				continue; // populated topics continue — never evicted for a new instantiation
			}
			if (state.seq < victimSeq) {
				victim = key;
				victimSeq = state.seq;
			}
		}
		return victim;
	}
}

/** Build a {@link TopicBudget} over the configured `topics_max`. */
export function createTopicBudget(config: TopicBudgetConfig = {}): TopicBudget {
	return new LruTopicBudget(config);
}
