import type { ActionRev, BlockId, IBlock, IRepo } from "@optimystic/db-core";
import type { BlockArchive } from "./struct.js";
import { proofClaimsCommit, type BlockCommitProof } from "../cluster/commit-proof.js";
import { createLogger } from "../logger.js";

const log = createLogger('block-archive');

/**
 * The archive shape every block-repair path exchanges: ONE revision — the one being served —
 * carrying its action, the block itself when the serving repo materialized it, and the cohort's
 * commit proof for that revision when the serving repo retained one.
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
 *
 * `proof` is optional for the same kind of reason (see `ArchiveRevisions.proof`): a pre-proof
 * revision, a diverged member, or an un-upgraded peer serves none, and every consumer must behave
 * exactly as it did before proofs existed when it is absent.
 */
export function singleRevisionArchive(
	blockId: BlockId,
	source: ActionRev,
	block: IBlock | undefined,
	proof?: BlockCommitProof
): BlockArchive {
	return {
		blockId,
		revisions: {
			[source.rev]: {
				action: { actionId: source.actionId, transform: { insert: block } },
				...(block ? { block } : {}),
				...(proof ? { proof } : {})
			}
		},
		range: [source.rev, source.rev + 1]
	};
}

/**
 * A peer's answer to the latest-revision consult: the `(rev, actionId)` it claims, plus the cohort's
 * commit proof for that revision when it retained one.
 *
 * Defined HERE, alongside the archive shape, rather than beside the callback that returns it
 * (`ClusterLatestCallback` in `repo/coordinator-repo.ts`, which re-exports this name): a remote
 * peer's answer IS a projection of the archive it served, so keeping the two in one file is what
 * stops the projection from drifting from the shape — the same reason `singleRevisionArchive` is a
 * function rather than a shape re-typed at each site.
 *
 * The proof is OPTIONAL and means nothing until a consumer verifies it. A pre-proof revision, a
 * diverged member, and an un-upgraded peer all legitimately answer without one, and a peer is free
 * to attach whatever it likes — verification, never presence, is what makes a proof evidence.
 */
export type CertifiedActionRev = ActionRev & { proof?: BlockCommitProof };

/**
 * The highest-revision claim an archive carries, or `undefined` when it holds no usable revision.
 * `undefined` is the peer having ANSWERED without data — an absent claim, never silence (see
 * `ClusterLatestCallback`'s three-way contract).
 *
 * The proof is read from the SAME revision entry as the `(rev, actionId)`, so a serving peer cannot
 * pair a genuine proof with a revision it does not certify by choosing a different layout. Nothing
 * here verifies anything: the result is the peer's unverified assertion until a caller checks it.
 *
 * `Object.keys` on a JSON-parsed archive yields strings; a key that is not a number coerces to `NaN`
 * and is dropped rather than poisoning `Math.max`.
 */
export function latestClaimFromArchive(archive: BlockArchive): CertifiedActionRev | undefined {
	const revisions = Object.keys(archive.revisions ?? {}).map(Number).filter(rev => Number.isFinite(rev));
	if (revisions.length === 0) return undefined;
	const maxRev = Math.max(...revisions);
	const entry = archive.revisions[maxRev];
	if (!entry?.action) return undefined;
	return {
		actionId: entry.action.actionId,
		rev: maxRev,
		...(entry.proof ? { proof: entry.proof } : {})
	};
}

/**
 * What {@link serveBlockArchive} needs of the repo it reads: `IRepo`, plus — OPTIONALLY — the
 * revision-keyed commit-proof accessor `StorageRepo` implements.
 *
 * Optional rather than required so the unit-test doubles and any other plain `IRepo` that serves
 * archives keep compiling and keep working (they simply serve no proof). A repo that CAN serve
 * proofs and does not is not a type error here — it is the pre-proof behaviour, which stays valid.
 */
export type ArchiveServingRepo = IRepo & {
	getBlockProof?(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined>;
};

/**
 * Serve `blockId` out of a local repo as a {@link singleRevisionArchive} — what a peer answers a
 * block-repair fetch with. `undefined` when the repo holds no revision of the block at all, which
 * callers report as "holds nothing" (`ReconcileBlockDeps.fetchArchive`'s contract folds
 * "unreachable" into that same answer).
 *
 * The read skips the cluster deliberately: a peer answering a repair fetch reports what IT holds,
 * and one that re-asked its own cohort would launder another peer's claim as its own.
 *
 * NOTE: `rev` DOES NOT currently pin anything. It is packed into a synthetic `ActionContext`, and
 * `StorageRepo.get` reads only that context's `committed` list -- never its `rev` -- so this always
 * serves the repo's own latest and labels the archive with that revision. A caller asking for an
 * older revision (`RestorationCoordinator` is the one that does) silently gets the latest instead.
 * Filed as `fix/block-archive-rev-pin-is-a-no-op`; this doc used to claim the pin worked, which is
 * why it now says so loudly.
 *
 * The proof served is looked up for the revision ACTUALLY served (`latest.rev`), never for a
 * revision chosen independently -- so whatever the line above resolves to, the archive can never
 * publish a proof paired with a revision it does not certify.
 *
 * NOTE: a single-revision archive's proof is a rounding error against the wire cap. A sync
 * *response* is bounded by `MAX_BLOCK_MESSAGE_BYTES` (8 MiB — `SyncClient.requestBlock` sets the
 * response decoder's `maxDataLength`; the 1 MiB `MAX_CONTROL_MESSAGE_BYTES` bounds the inbound
 * REQUEST, not this). A proof's serialized size is dominated by two signatures plus a peer id per
 * cohort member: a whole proof-carrying single-revision archive measured 4801 bytes at a 10-peer
 * cohort and 8851 bytes at 20 (`test/block-archive-proof.spec.ts`, "far below the sync response
 * cap", which prints both), i.e. ~405 bytes per additional peer. Reaching 8 MiB would take a cohort in the tens of thousands, so
 * no plausible cluster size puts this near the cap — the block bytes the archive already carries
 * are the term that matters. Revisit only if a proof ever grows a per-peer payload beyond its two
 * signatures.
 */
export async function serveBlockArchive(repo: ArchiveServingRepo, blockId: BlockId, rev?: number): Promise<BlockArchive | undefined> {
	const context = rev !== undefined ? { rev, committed: [], pending: [] } : undefined;
	const result = await repo.get({ blockIds: [blockId], context }, { skipClusterFetch: true } as any);
	const entry = result[blockId];
	const latest = entry?.state?.latest;
	if (!latest) return undefined;
	const proof = await servableProof(repo, blockId, latest);
	return singleRevisionArchive(blockId, latest, entry.block, proof);
}

/**
 * The stored proof for the revision being served, or `undefined` — including whenever anything is
 * off about it. Serving no proof is always safe (every consumer must already handle its absence),
 * so this fails closed on all three unhappy paths:
 *
 *  - the repo has no proof accessor at all (a plain `IRepo`, a test double);
 *  - the lookup throws — a storage fault must not turn a servable archive into "holds nothing",
 *    because that would recreate the phantom-non-holder bug the archive shape exists to prevent;
 *  - the stored proof's own message does not name this `(blockId, rev, actionId)`. That is a local
 *    storage-integrity fault, not a peer's doing, and publishing a mis-paired proof would hand
 *    every receiver an artifact that cannot verify. Logged loudly, because it means a proof was
 *    written under a key its content contradicts.
 *
 * Exported for the SAME reason {@link singleRevisionArchive} is: the mesh test harness answers the
 * latest-revision consult out of a sibling's repo directly rather than over the sync protocol, and
 * a harness that attached proofs by a different rule than a real peer would let every mesh-tier
 * test silently exercise a path production does not have.
 */
export async function servableProof(
	repo: ArchiveServingRepo, blockId: BlockId, latest: ActionRev
): Promise<BlockCommitProof | undefined> {
	if (typeof repo.getBlockProof !== 'function') return undefined;
	let proof: BlockCommitProof | undefined;
	try {
		proof = await repo.getBlockProof(blockId, latest.rev);
	} catch (error) {
		log('serve:proof-lookup-failed blockId=%s rev=%d error=%s', blockId, latest.rev,
			error instanceof Error ? error.message : String(error));
		return undefined;
	}
	if (!proof) return undefined;
	if (!proofClaimsCommit(proof, { blockId, rev: latest.rev, actionId: latest.actionId })) {
		log('serve:proof-claim-mismatch blockId=%s rev=%d actionId=%s', blockId, latest.rev, latest.actionId);
		return undefined;
	}
	return proof;
}
