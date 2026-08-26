import type { ActionRev, BlockId, IBlock, IRepo } from "@optimystic/db-core";
import type { BlockArchive } from "./struct.js";

/**
 * The archive shape every block-repair path exchanges: ONE revision — the one being served —
 * carrying its action and, when the serving repo materialized it, the block itself.
 *
 * One function rather than the shape re-typed at each site, because three sites had already drifted
 * while each claimed to mirror the others: the sync service served `block: undefined` for a block
 * with no materialized content, the mesh test harness served no archive at all for that same repo
 * state (turning a corroborable revision claim into a phantom non-holder), and the reconcile unit
 * spec's stand-in emitted a third shape again. `createReconcileBlock` reads
 * `revisions[rev].action.actionId` and `revisions[rev].block`, and the difference between "absent
 * block" and "absent archive" decides whether a peer votes in the revision quorum at all — so the
 * shape is a contract, not a detail.
 *
 * `block` stays optional on purpose: a revision whose content the serving repo cannot materialize
 * (a deleted block — see `GetBlockResult.block`) is still a revision that peer legitimately claims.
 * It votes on `(rev, actionId)` and abstains from the content quorum, which is exactly the evidence
 * it holds.
 */
export function singleRevisionArchive(blockId: BlockId, source: ActionRev, block: IBlock | undefined): BlockArchive {
	return {
		blockId,
		revisions: {
			[source.rev]: {
				action: { actionId: source.actionId, transform: { insert: block } },
				...(block ? { block } : {})
			}
		},
		range: [source.rev, source.rev + 1]
	};
}

/**
 * Serve `blockId` out of a local repo as a {@link singleRevisionArchive} — what a peer answers a
 * block-repair fetch with. `undefined` when the repo holds no revision of the block at all, which
 * callers report as "holds nothing" (`ReconcileBlockDeps.fetchArchive`'s contract folds
 * "unreachable" into that same answer).
 *
 * `rev` pins the read to a specific revision; omitted, the repo's own latest is served. The read
 * skips the cluster deliberately: a peer answering a repair fetch reports what IT holds, and one
 * that re-asked its own cohort would launder another peer's claim as its own.
 */
export async function serveBlockArchive(repo: IRepo, blockId: BlockId, rev?: number): Promise<BlockArchive | undefined> {
	const context = rev !== undefined ? { rev, committed: [], pending: [] } : undefined;
	const result = await repo.get({ blockIds: [blockId], context }, { skipClusterFetch: true } as any);
	const entry = result[blockId];
	const latest = entry?.state?.latest;
	if (!latest) return undefined;
	return singleRevisionArchive(blockId, latest, entry.block);
}
