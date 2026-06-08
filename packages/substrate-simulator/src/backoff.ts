import type { EventScheduler, VTime } from './types.js';
import {
	type MemberWillingness,
	type Tier,
	type AdmissionVerdict,
	isWilling,
	willingnessVector
} from './willingness.js';

/**
 * Exponential `UnwillingCohort` back-off and ~1-heartbeat willingness-gossip staleness, modeled
 * against `docs/cohort-topic.md` §Willingness, §Anti-flood properties (claim 4: inward-retry
 * decorrelation), and §Anti-DoS (exponential `retryAfter`). Synchronous; all timing is driven by
 * the injected scheduler.
 */

export interface BackoffConfig {
	/** Initial `retryAfter` for the first rejection (ms). */
	readonly baseMs: VTime;
	/** Geometric growth factor per rejection (cohort-topic.md uses doubling). */
	readonly factor: number;
	/** Hard ceiling on a single back-off delay (ms). */
	readonly maxMs: VTime;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
	baseMs: 1000,
	factor: 2,
	maxMs: 60_000
};

/**
 * `retryAfter` for the `attempt`-th rejection (0-based): `base · factor^attempt`, floored to an
 * integer and capped at `maxMs`. The capped doubling bounds the number of rejections a single
 * participant suffers across an overload window at `O(log(window/base))` rather than the
 * `window/base` a fixed interval would incur.
 */
export function backoffDelay(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF_CONFIG): VTime {
	if (!Number.isInteger(attempt) || attempt < 0) {
		throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
	}
	const raw = cfg.baseMs * Math.pow(cfg.factor, attempt);
	return Math.min(Math.floor(raw), cfg.maxMs);
}

/** A cohort's admission decision at a point in time — `true` admits, `false` returns UnwillingCohort. */
export type AdmissionGate = (now: VTime) => boolean;

export interface BackoffAdmissionOptions {
	readonly scheduler: EventScheduler;
	readonly participantId: string;
	readonly gate: AdmissionGate;
	readonly config?: BackoffConfig;
	/** First attempt time (default: schedule the first attempt now+0 via the scheduler). */
	readonly startAt?: VTime;
}

/**
 * Drives one participant's registration attempts under exponential `UnwillingCohort` back-off.
 * Each attempt consults the `gate`; a rejection schedules the next attempt `backoffDelay(n)` out
 * (decorrelating retries and shedding offered load), an admission stops the loop and records the
 * time-to-admit. The counters are the assertion surface for the back-off-curve test.
 */
export class BackoffAdmission {
	readonly participantId: string;
	rejections = 0;
	attempts = 0;
	admittedAt: VTime | undefined;
	private readonly scheduler: EventScheduler;
	private readonly gate: AdmissionGate;
	private readonly cfg: BackoffConfig;

	constructor(opts: BackoffAdmissionOptions) {
		this.scheduler = opts.scheduler;
		this.participantId = opts.participantId;
		this.gate = opts.gate;
		this.cfg = opts.config ?? DEFAULT_BACKOFF_CONFIG;
		const start = opts.startAt ?? 0;
		this.scheduler.scheduleAfter(start, (ctx) => this.attempt(ctx.now));
	}

	get admitted(): boolean {
		return this.admittedAt !== undefined;
	}

	private attempt(now: VTime): void {
		if (this.admitted) {
			return;
		}
		this.attempts++;
		if (this.gate(now)) {
			this.admittedAt = now;
			return;
		}
		const delay = backoffDelay(this.rejections, this.cfg);
		this.rejections++;
		this.scheduler.scheduleAfter(delay, (ctx) => this.attempt(ctx.now));
	}
}

/**
 * Per-cohort willingness gossip with ~1-heartbeat staleness (cohort-topic.md §Willingness: "the
 * cohort gossips a coarse willingness vector… refreshed every gossip round. Stale gossip is
 * acceptable"). A member's *live* willingness can flip between heartbeats; the gossiped snapshot
 * only catches up on `refresh()`. Admission routes against the stale snapshot to pick candidate
 * servers but verifies the actually-routed member against its *live* willingness — so a member
 * that just became unwilling while a sibling still gossips it as willing yields `UnwillingMember`,
 * the edge case the gossip-lag test exercises.
 */
export class WillingnessGossip {
	private readonly members: readonly MemberWillingness[];
	private gossiped: boolean[][];

	constructor(members: readonly MemberWillingness[]) {
		this.members = members;
		this.gossiped = members.map((m) => willingnessVector(m));
	}

	/** Catch the gossiped snapshot up to live willingness — one heartbeat of staleness resolves. */
	refresh(): void {
		this.gossiped = this.members.map((m) => willingnessVector(m));
	}

	/** Indices the *gossiped* snapshot believes will serve `tier` (may be stale). */
	gossipedCandidates(tier: Tier): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.gossiped.length; i++) {
			if (this.gossiped[i]![tier]) {
				out.push(i);
			}
		}
		return out;
	}

	/**
	 * Classify a registration routed onto `routedIndex` for `tier` using stale gossip for the
	 * candidate set but live willingness for the routed member:
	 *  - fewer than `quorum` gossiped-willing members → `unwilling_cohort`,
	 *  - routed member *live*-willing → `accepted`,
	 *  - else → `unwilling_member`, naming the gossiped-willing siblings to retry.
	 */
	admit(tier: Tier, routedIndex: number, quorum: number): AdmissionVerdict {
		const candidates = this.gossipedCandidates(tier);
		if (candidates.length < quorum) {
			return { result: 'unwilling_cohort' };
		}
		if (isWilling(this.members[routedIndex]!, tier)) {
			return { result: 'accepted' };
		}
		return { result: 'unwilling_member', candidates };
	}
}
