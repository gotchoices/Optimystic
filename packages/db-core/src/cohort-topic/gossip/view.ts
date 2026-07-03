/**
 * Cohort-topic substrate — the merged per-member gossip view.
 *
 * Each cohort member periodically gossips its willingness vector, load barometer buckets, and exact
 * per-topic summaries (`CohortGossipV1`). The bus folds the latest such contribution per member into
 * this view (last-writer-wins by gossip `timestamp`), which the willingness, barometer, and traffic
 * tickets read. Records replicate into the registration store separately (see {@link createCohortGossipBus}).
 */

import type { CohortTopicSummary } from "../wire/types.js";

/** Latest gossip contribution from a single cohort member. */
export interface MemberContribution {
	/** Cohort epoch this member gossiped under (drift signal). */
	readonly cohortEpoch: Uint8Array;
	/** Willingness vector, 4 bits T0..T3 (0..15) decoded from the hex nibble. */
	readonly willingness: number;
	/** Load barometer buckets, 4 entries 0..7 per tier. */
	readonly loadBuckets: readonly number[];
	/** Observation window for the rate fields in `topicSummaries`. */
	readonly windowSeconds: number;
	/** Exact per-topic summaries this member last reported. */
	readonly topicSummaries: readonly CohortTopicSummary[];
	/**
	 * `topicId` (base64url) → summary, derived from {@link topicSummaries} at {@link MutableCohortView.merge}
	 * so a per-topic reader (traffic `snapshot`) does an O(1) lookup instead of an O(summaries) `.find` per
	 * member per reply. First occurrence wins on a duplicate `topicId` (matching `Array.prototype.find`).
	 * Populated by `merge`; a contribution built without going through `merge` may omit it, in which case
	 * consumers fall back to scanning {@link topicSummaries}.
	 */
	readonly topicIndex?: ReadonlyMap<string, CohortTopicSummary>;
	/** Gossip timestamp (unix ms) — the last-writer-wins key. */
	readonly timestamp: number;
}

/** Read view over the merged per-member contributions, keyed by `fromMember`. */
export interface CohortView {
	/** Latest contribution from `member` (the `fromMember` string), or `undefined`. */
	get(member: string): MemberContribution | undefined;
	/** All current contributions, keyed by `fromMember`. */
	all(): ReadonlyMap<string, MemberContribution>;
}

/** Mutable view the bus writes into; exposes the read {@link CohortView} surface. */
export interface MutableCohortView extends CohortView {
	/** Merge `c` for `member` iff it is at least as recent as the held contribution. Returns true if applied. */
	merge(member: string, c: MemberContribution): boolean;
}

class MapCohortView implements MutableCohortView {
	private readonly byMember = new Map<string, MemberContribution>();

	get(member: string): MemberContribution | undefined {
		return this.byMember.get(member);
	}

	all(): ReadonlyMap<string, MemberContribution> {
		return this.byMember;
	}

	merge(member: string, c: MemberContribution): boolean {
		const held = this.byMember.get(member);
		if (held !== undefined && c.timestamp < held.timestamp) {
			return false; // stale; keep the newer contribution
		}
		// Derive the per-topic index once, at write time, so per-topic readers never rescan the flat
		// `topicSummaries` array per reply. A writer pays O(summaries) once per merge (gossip round).
		this.byMember.set(member, { ...c, topicIndex: indexTopics(c.topicSummaries) });
		return true;
	}
}

/**
 * Index a member's flat topic summaries by `topicId` (base64url). First occurrence wins on a duplicate
 * `topicId`, exactly matching the `Array.prototype.find` scan this replaces — so a snapshot over the index
 * returns identical numbers to one over the array.
 */
function indexTopics(summaries: readonly CohortTopicSummary[]): ReadonlyMap<string, CohortTopicSummary> {
	const index = new Map<string, CohortTopicSummary>();
	for (const s of summaries) {
		if (!index.has(s.topicId)) {
			index.set(s.topicId, s);
		}
	}
	return index;
}

/** Construct an empty {@link MutableCohortView}. */
export function createCohortView(): MutableCohortView {
	return new MapCohortView();
}
