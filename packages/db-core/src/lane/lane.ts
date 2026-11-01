/**
 * The lane of a write: how its conflicts with other machines' CONCURRENT writes are decided
 * (docs/crdt-sync.md §Stage 5 — Tunable per-collection; docs/partition-healing.md §I-Confluence
 * Classification).
 *
 * - `serializable` — the quorum lane. The write needs the collection's cohort to agree before it
 *   is committed, and the revision order decides every conflict: today's behaviour for every write.
 *   The tree entry guards (`TreeEntryGuard` in `packages/db-core/src/collections/tree/struct.ts`)
 *   are this lane's conflict rule, re-making every uniqueness and lost-update decision
 *   deterministically on replay.
 * - `convergent` — the merge lane. The write may be committed by one machine without first agreeing
 *   with the others and merged into their concurrent writes later, because the invariants it is
 *   responsible for survive a merge: an append to an append-only set, an increment of an unbounded
 *   counter, a last-writer-wins field. The collection's merge declaration (`ConvergentMerge` in
 *   `packages/db-core/src/collection/collection.ts`) is this lane's conflict rule.
 *
 * Convergence is a property of an OPERATION, never of a system (the invariant-confluence result of
 * Bailis et al., and Li et al.'s RedBlue consistency). **Idempotence is not the criterion**, and is
 * the mistake a reader makes first: setting a column to a value is idempotent and still needs a
 * tie-break under concurrency, while an increment is not idempotent and merges fine. The question is
 * whether two machines applying the operation concurrently, each over its own view, leave the
 * invariants the operation is responsible for true once the two views are merged.
 *
 * Nothing admits a write by its lane yet: the solo path, the offline queue and the conflict replay
 * behave as they did before the field. The replay stage (backlog
 * `feat-replay-mode-collections-merge-divergent-histories`) is what consumes it.
 */
export type Lane = 'serializable' | 'convergent';

/**
 * The lane of a write made of several parts: `serializable` if any part is. Convergence is a claim
 * each part makes about itself, so a write is convergent only when every part claims it — and a
 * write of NO parts claims nothing, so an empty set answers `serializable`, the lane every write
 * takes without a declaration.
 */
export function stricterLane(lanes: Iterable<Lane>): Lane {
	let seen = false;
	for (const lane of lanes) {
		if (lane === 'serializable') return 'serializable';
		seen = true;
	}
	return seen ? 'convergent' : 'serializable';
}

/**
 * Wraps a request's optional `lane` (`PendRequest.lane`, `CommitRequest.lane`) so the field spreads
 * onto the request only when the sender has one: omitted rather than sent as `undefined`, because the
 * request is hashed verbatim into every cohort signature preimage, so a request that states no lane
 * must serialize exactly as it did before the field existed. Every producer of the field goes
 * through here, as `refuseSoloField` does for its field.
 */
export function laneField(lane: Lane | undefined): { lane?: Lane } {
	return lane === undefined ? {} : { lane };
}
