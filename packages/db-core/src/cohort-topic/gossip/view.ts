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
		this.byMember.set(member, c);
		return true;
	}
}

/** Construct an empty {@link MutableCohortView}. */
export function createCohortView(): MutableCohortView {
	return new MapCohortView();
}
