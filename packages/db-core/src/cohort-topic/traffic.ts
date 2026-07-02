/**
 * Cohort-topic substrate — topic-traffic signal.
 *
 * Transcribed from `docs/cohort-topic.md` §Topic traffic signal. A cohort tracks per-topic flow
 * rates alongside the stock `directParticipants` count and returns them on registration replies so
 * applications can decide whether the current tier is dense enough to settle on.
 *
 * Shape (`TopicTrafficV1` from the wire ticket):
 * - `arrivalsPerMin` — **combines** fresh registrations and renewals into one scalar (the seeker
 *   uses renewals as a proxy for active matchable supply); the caller invokes {@link recordArrival}
 *   for both.
 * - `queriesPerMin` — application-level query rate.
 * - counts are **exact integers** over `windowSeconds` (default 60), *not* log-bucketed like the
 *   load barometer — the consumer-side matchmaking formulas are numeric.
 *
 * Pipeline: each member counts arrivals/queries locally ({@link recordArrival} / {@link recordQuery})
 * over a sliding window; {@link TrafficCounters.publish} freezes the windowed counts into the
 * member's gossiped per-topic summary each gossip round; {@link TrafficCounters.snapshot} returns the
 * **gossip-derived** view (own last-published summary + siblings' last-gossiped summaries from the
 * {@link CohortView}), so the reply lags by at most one round and never recomputes from raw counters
 * at reply time.
 *
 * Resolved open question (GROUNDING): the signal is returned **only** on `accepted` and `promoted`
 * replies (see {@link attachTopicTraffic}); a participant getting `Promoted(d+1)` still receives the
 * outgoing cohort's traffic so it can estimate whether the redirect target is hot.
 *
 * Counters reset to zero on `cohortEpoch` change ({@link TrafficCounters.reset}); the first round
 * after a rotation may under-report, and consumers tolerate a single zero reading.
 */

import { bytesKey } from "./registration/bytes.js";
import type { CohortView } from "./gossip/view.js";
import type { RegistrationStore } from "./registration/types.js";
import { bytesToB64url } from "./wire/codec.js";
import type { CohortTopicSummary, RegisterReplyV1, TopicTrafficV1 } from "./wire/types.js";

/** Default observation window for the rate fields (seconds). */
export const DEFAULT_TRAFFIC_WINDOW_SECONDS = 60;

/** Frozen per-topic counts the member last published to gossip. */
interface PublishedTopic {
	readonly arrivals: number;
	readonly queries: number;
}

/** Local windowed event timestamps (unix ms) for one topic. */
interface TopicWindow {
	arrivals: number[];
	queries: number[];
}

/** Per-topic traffic counters with a gossip-derived snapshot. */
export interface TrafficCounters {
	/** Record a fresh registration **or** a renewal for `topicId` at `now` (combined arrivals). */
	recordArrival(topicId: Uint8Array, now: number): void;
	/** Record an application-level query against `topicId` at `now`. */
	recordQuery(topicId: Uint8Array, now: number): void;
	/**
	 * Freeze the current windowed counts into the member's gossiped summary (call once per gossip
	 * round, at `now`). The frozen values are what {@link snapshot} and the gossip frame read.
	 */
	publish(topicId: Uint8Array, now: number): PublishedTopic;
	/** Own most-recent published `(arrivals, queries)` for `topicId`, or zeros if never published. */
	published(topicId: Uint8Array): PublishedTopic;
	/**
	 * Gossip-derived traffic for `topicId`: own last-published counts plus siblings' last-gossiped
	 * summaries (exact-integer sums), with `directParticipants` from the replicated store. Lags ≤ one
	 * round; never recomputes from raw counters.
	 */
	snapshot(topicId: Uint8Array): TopicTrafficV1;
	/** Reset all counters to zero (call on `cohortEpoch` change). */
	reset(): void;
	/**
	 * Drop all local windowed counts and the last-published summary for `topicId` (the cohort no longer
	 * serves it — budget eviction / teardown). Idempotent; a no-op if never observed. Siblings' gossiped
	 * contributions age out of {@link snapshot} on their own as their summaries stop naming the topic.
	 */
	forget(topicId: Uint8Array): void;
}

export interface TrafficCountersDeps {
	/** Merged per-member gossip view — siblings' last-gossiped per-topic summaries. */
	view: CohortView;
	/** Replicated registration store — supplies the cohort-wide `directParticipants` stock count. */
	store: Pick<RegistrationStore, "directParticipants">;
	/** This member's own id, base64url — excluded from the sibling summary scan (counted via own published). */
	selfMember: string;
	/** Observation window (seconds). Default {@link DEFAULT_TRAFFIC_WINDOW_SECONDS}. */
	windowSeconds?: number;
	/** Tier-(d+1) cohort count for a topic (0 if not promoted); the promotion ticket owns this. */
	childCohortCount?: (topicId: Uint8Array) => number;
}

class WindowedTrafficCounters implements TrafficCounters {
	private readonly windows = new Map<string, TopicWindow>();
	private readonly lastPublished = new Map<string, PublishedTopic>();
	private readonly windowMs: number;

	constructor(private readonly deps: TrafficCountersDeps) {
		const ws = deps.windowSeconds ?? DEFAULT_TRAFFIC_WINDOW_SECONDS;
		if (!(ws > 0)) {
			throw new RangeError(`windowSeconds must be > 0, got ${ws}`);
		}
		this.windowMs = ws * 1000;
	}

	recordArrival(topicId: Uint8Array, now: number): void {
		this.windowFor(topicId).arrivals.push(now);
	}

	recordQuery(topicId: Uint8Array, now: number): void {
		this.windowFor(topicId).queries.push(now);
	}

	publish(topicId: Uint8Array, now: number): PublishedTopic {
		const w = this.windows.get(bytesKey(topicId));
		const frozen: PublishedTopic = {
			arrivals: w === undefined ? 0 : countWithin(w.arrivals, now, this.windowMs),
			queries: w === undefined ? 0 : countWithin(w.queries, now, this.windowMs),
		};
		this.lastPublished.set(bytesKey(topicId), frozen);
		return frozen;
	}

	published(topicId: Uint8Array): PublishedTopic {
		return this.lastPublished.get(bytesKey(topicId)) ?? { arrivals: 0, queries: 0 };
	}

	snapshot(topicId: Uint8Array): TopicTrafficV1 {
		const topicB64 = bytesToB64url(topicId);
		const own = this.published(topicId);
		let arrivals = own.arrivals;
		let queries = own.queries;
		let childCohortCount = 0;
		for (const [member, contribution] of this.deps.view.all()) {
			if (member === this.deps.selfMember) continue; // own contribution comes from lastPublished
			const summary = contribution.topicSummaries.find((s) => s.topicId === topicB64);
			if (summary === undefined) continue;
			arrivals += summary.arrivalsPerMin;
			queries += summary.queriesPerMin;
			if (summary.childCohortCount > childCohortCount) {
				childCohortCount = summary.childCohortCount;
			}
		}
		// NOTE: `childCohortCount` (the max of siblings' gossiped counts above) is dormant whenever the
		// registry override is wired — the override returns a number (0 included), so `?? childCohortCount`
		// never falls through. It becomes the effective value only if the override is unwired; the child-set
		// replication follow-on converges siblings by populating each engine's registry, not via this max.
		const childOverride = this.deps.childCohortCount?.(topicId);
		return {
			windowSeconds: this.windowMs / 1000,
			arrivalsPerMin: arrivals,
			queriesPerMin: queries,
			directParticipants: this.deps.store.directParticipants(topicId),
			childCohortCount: childOverride ?? childCohortCount,
		};
	}

	reset(): void {
		this.windows.clear();
		this.lastPublished.clear();
	}

	forget(topicId: Uint8Array): void {
		// Idempotent: `Map.delete` on an absent key is a safe no-op. Clears both the raw windowed events
		// and the frozen last-published summary so a re-instantiated topic starts from zero.
		const key = bytesKey(topicId);
		this.windows.delete(key);
		this.lastPublished.delete(key);
	}

	private windowFor(topicId: Uint8Array): TopicWindow {
		const key = bytesKey(topicId);
		let w = this.windows.get(key);
		if (w === undefined) {
			w = { arrivals: [], queries: [] };
			this.windows.set(key, w);
		}
		return w;
	}
}

/** Count timestamps within `[now - windowMs, now]`, pruning anything older from `events` in place. */
function countWithin(events: number[], now: number, windowMs: number): number {
	const cutoff = now - windowMs;
	// Events accumulate in arrival order; drop the stale prefix so the array stays bounded.
	let drop = 0;
	while (drop < events.length && events[drop]! < cutoff) {
		drop++;
	}
	if (drop > 0) {
		events.splice(0, drop);
	}
	return events.length;
}

/** Construct empty {@link TrafficCounters}. */
export function createTrafficCounters(deps: TrafficCountersDeps): TrafficCounters {
	return new WindowedTrafficCounters(deps);
}

/**
 * Attach the topic-traffic signal to a reply **only** when the result is `accepted` or `promoted`
 * (GROUNDING-resolved: absent on `no_state`, `unwilling_member`, `unwilling_cohort`). Mutates and
 * returns `reply`. A no-op for non-traffic-bearing results, so callers can pipe every reply through.
 */
export function attachTopicTraffic(reply: RegisterReplyV1, traffic: TopicTrafficV1): RegisterReplyV1 {
	if (reply.result === "accepted" || reply.result === "promoted") {
		reply.topicTraffic = traffic;
	}
	return reply;
}

/** The own published counts as a `CohortTopicSummary` for the gossip frame. Callers supply tier/promotion fields. */
export function toCohortTopicSummary(
	topicId: Uint8Array,
	published: PublishedTopic,
	fields: { tier: number; directParticipants: number; promoted: boolean; childCohortCount: number },
): CohortTopicSummary {
	return {
		topicId: bytesToB64url(topicId),
		tier: fields.tier,
		directParticipants: fields.directParticipants,
		arrivalsPerMin: published.arrivals,
		queriesPerMin: published.queries,
		promoted: fields.promoted,
		childCohortCount: fields.childCohortCount,
	};
}
