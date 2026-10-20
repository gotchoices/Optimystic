import type { ActionContext, ActionRev, BlockId, IBlock, IRepo } from "@optimystic/db-core";
import type { BlockArchive } from "./struct.js";
import type { SyncBlockAnswer } from "../sync/protocol.js";
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
 *
 * NOTE: the `range` emitted here is a COMPATIBILITY CONTRACT with `BlockStorage.vetRestoredArchive`,
 * which refuses an archive whose declared range does not start at its lowest revision, end past its
 * highest, or which is open-ended. `[rev, rev + 1]` around a single revision satisfies all three
 * trivially, and this is currently the ONLY producer of an archive that crosses the restore wire —
 * which is why no test drives a refusal end to end through `RestorationCoordinator`. If a second
 * producer ever appears (a multi-revision or sparse archive, say), that contract stops being
 * trivially true and needs a test pinning the two ends together.
 *
 * NOTE: when the block rides, it rides twice — as `action.transform.insert` and as `block`. The
 * restore wire depends on the transform copy (`BlockStorage.saveRestored` stores `action.transform`,
 * and `noDivergentRewrite` compares it), so it stays. Fine while consults mostly omit the bytes
 * (`serveConsultAnswer`); if acquisition or restore traffic ever dominates, serve the content once
 * and rebuild the other copy on receipt.
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
 * Highest revision an archive covers, or `undefined` when it covers none.
 *
 * ONE implementation for every site that asks an untrusted archive this question — the two repair
 * wires ({@link latestClaimFromArchive}) and the reconcile pass (`cluster/reconcile-block.ts`) — for
 * the same reason {@link singleRevisionArchive} is one function: two copies is how one of them ends
 * up without the guards below.
 *
 * Both guards matter on input a remote peer chose. `Object.keys` on a JSON-parsed archive yields
 * strings, so a non-numeric key coerces to `NaN` and is skipped rather than poisoning the maximum.
 * And the fold is deliberate rather than `Math.max(...keys)`: the spread passes one ARGUMENT per
 * revision, which throws `RangeError: Maximum call stack size exceeded` past ~125k arguments —
 * comfortably inside the 8 MiB `MAX_BLOCK_MESSAGE_BYTES` a sync response may carry (130k minimal
 * revision entries serialize to ~6.3 MiB), so a peer could otherwise choose to make this throw.
 */
export function maxArchiveRevision(revisions: BlockArchive['revisions'] | undefined): number | undefined {
	let max: number | undefined;
	for (const key of Object.keys(revisions ?? {})) {
		const rev = Number(key);
		if (Number.isFinite(rev) && (max === undefined || rev > max)) max = rev;
	}
	return max;
}

/**
 * The highest-revision claim an archive carries, or `undefined` when it holds no usable revision.
 * `undefined` is the peer having ANSWERED without data — an absent claim, never silence (see
 * `ClusterLatestCallback`'s three-way contract).
 *
 * The proof is read from the SAME revision entry as the `(rev, actionId)`, so a serving peer cannot
 * pair a genuine proof with a revision it does not certify by choosing a different layout. Nothing
 * here verifies anything: the result is the peer's unverified assertion until a caller checks it.
 */
export function latestClaimFromArchive(archive: BlockArchive): CertifiedActionRev | undefined {
	const maxRev = maxArchiveRevision(archive.revisions);
	if (maxRev === undefined) return undefined;
	const entry = archive.revisions[maxRev];
	if (!entry?.action) return undefined;
	return {
		actionId: entry.action.actionId,
		rev: maxRev,
		...(entry.proof ? { proof: entry.proof } : {})
	};
}

/**
 * The claim one block's consult answer ({@link serveConsultAnswer}) carries, with the archive it was
 * read from, or `undefined` when the peer holds nothing — an answer, never silence.
 *
 * The archive rides along so an acquisition that follows reuses it instead of asking the peer again
 * (`ConsultedArchives` in `cluster/cluster-repo.ts`), and that holds for an archive whose bytes were
 * left out as `'held'` too: such a peer's revision is at or below the asker's own, so it is never a
 * candidate for the acquisition's content quorum, which takes only a corroborated revision strictly
 * above the asker's (`createReconcileBlock` reads it as behind). Reusing it is what keeps a peer that
 * answered from being asked twice. An omission reason that can apply to a peer AHEAD of the asker
 * must not be reused that way — the acquisition would then have no bytes from a peer that holds the
 * revision it needs — so any reason other than `'held'` (one a newer peer sends) returns the claim
 * without the archive, and the acquisition asks that peer for the content.
 */
export function claimFromConsultAnswer(answer: SyncBlockAnswer): (CertifiedActionRev & { archive?: BlockArchive }) | undefined {
	if (!answer.archive) return undefined;
	const claim = latestClaimFromArchive(answer.archive);
	if (!claim) return undefined;
	if (answer.contentOmitted !== undefined && answer.contentOmitted !== 'held') return claim;
	return { ...claim, archive: answer.archive };
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
 * An {@link ArchiveServingRepo} that definitely CAN serve proofs — the accessor required rather
 * than optional.
 *
 * The optionality above exists for a serving repo that legitimately has no proofs (a test double, a
 * plain-`IRepo` embedder). It is the wrong default for a node's OWN store: forgetting the accessor
 * there degrades every archive it serves to proof-less, silently and without a type error. Naming
 * the stronger shape lets a composition root demand it (`createServedRepoProxy`).
 */
export type ProofRetainingRepo = IRepo & Required<Pick<ArchiveServingRepo, 'getBlockProof'>>;

/**
 * Serve `blockId` out of a local repo as a {@link singleRevisionArchive} — what a peer answers a
 * block-repair fetch with. `undefined` when the repo holds no revision of the block at all, which
 * callers report as "holds nothing" (`ReconcileBlockDeps.fetchArchive`'s contract folds
 * "unreachable" into that same answer).
 *
 * The read skips the cluster deliberately: a peer answering a repair fetch reports what IT holds,
 * and one that re-asked its own cohort would launder another peer's claim as its own.
 *
 * `rev` pins the read: `StorageRepo.get` materializes the highest committed revision of the block
 * at or below it and reports that revision as `GetBlockResult.materialized`, which is what the
 * archive is labelled with — its revision number, its action id, and its proof all belong to the
 * bytes actually served. `state.latest` (the repo's NEWEST revision) is never the label: a caller
 * asking for an older revision (`RestorationCoordinator` is the one that does) is answered with
 * that revision as itself, or with nothing. Never with old bytes under a newer label — that pairing
 * is what a receiver keyed by action id writes over its own good copy of the newer revision.
 *
 * The proof served is looked up for the revision ACTUALLY served, never for one chosen
 * independently, so the archive can never publish a proof paired with a revision it does not
 * certify. (A newer revision's proof over older bytes would pass `verifyBlockCommitProofClaim` and
 * fail `verifyBlockCommitProofContent` — strictly worse than no proof.)
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
	const servable = await readServable(repo, blockId, rev);
	if (!servable) return undefined;
	const { served, latest, block, proof } = servable;
	// Fail closed rather than mislabel. A served revision ABOVE the pin is never a right answer:
	// either the repo could not say what it materialized and its latest is newer than what was
	// asked for (so the bytes may be pinned or may not — and the only label in hand is wrong for
	// one of them), or the repo misreported. Labelling old bytes with a newer revision's number and
	// action id is what the asker's `saveRestored` — keyed by action id — then writes over the good
	// copy it already holds. Serve nothing instead: every caller already handles "holds nothing",
	// and `restoreRevision` turns it into a loud "not found during restore attempt". A served
	// revision AT OR BELOW the pin is the block unchanged since the pin, served exactly as before.
	if (rev !== undefined && served.rev > rev) {
		log('serve:skip blockId=%s served=%d requested=%d latest=%d (pinned read — refusing to mislabel content)',
			blockId, served.rev, rev, latest.rev);
		return undefined;
	}
	return singleRevisionArchive(blockId, served, block, proof);
}

/**
 * Answer one block of a latest-revision consult that said what the asker holds
 * (`SyncRequest.held`): the claim and its proof always, the block's bytes only when this repo
 * holds something the asker does not.
 *
 *  - holds nothing → `{}`;
 *  - the asker holds nothing, the served revision is above `held.rev`, or it equals `held.rev`
 *    under a different action id (a fork between the two copies, whose repair needs this copy's
 *    content) → the full archive, as {@link serveBlockArchive} serves it;
 *  - otherwise — served below `held.rev`, or equal under the same action id → the archive with the
 *    proof but without the block, and `contentOmitted: 'held'`.
 *
 * Bytes are left out only when this repo is NOT ahead of the asker, so an omitted block is never
 * content the asker's acquisition would need: the read path acquires only a corroborated revision
 * strictly above its own (`CoordinatorRepo.fetchBlockFromCluster`).
 *
 * Always unpinned — a consult asks for the latest — so the pinned-read refusal in
 * {@link serveBlockArchive} has nothing to refuse here. The read itself is shared with it
 * ({@link readServable}), so the two answers cannot drift on what is served or how it is labelled.
 */
export async function serveConsultAnswer(repo: ArchiveServingRepo, blockId: BlockId, held: ActionRev | undefined): Promise<SyncBlockAnswer> {
	const servable = await readServable(repo, blockId);
	if (!servable) return {};
	const { served, block, proof } = servable;
	if (askerHoldsServed(served, held)) {
		return { archive: singleRevisionArchive(blockId, served, undefined, proof), contentOmitted: 'held' };
	}
	return { archive: singleRevisionArchive(blockId, served, block, proof) };
}

/**
 * Whether the asker already holds the revision served, or a newer one. Stated positively, so a
 * `held` the asker sent without a usable revision (missing, `null` or `NaN` off the wire) fails both
 * comparisons and gets the bytes rather than losing them.
 */
function askerHoldsServed(served: ActionRev, held: ActionRev | undefined): boolean {
	if (!held) return false;
	return served.rev < held.rev || (served.rev === held.rev && served.actionId === held.actionId);
}

/** What one block-repair answer serves: the revision the content is, the repo's newest, the content and its proof. */
interface Servable {
	served: ActionRev;
	latest: ActionRev;
	block: IBlock | undefined;
	proof: BlockCommitProof | undefined;
}

/**
 * The read every block-repair answer is built from, or `undefined` when the repo holds no revision
 * of the block. One function so {@link serveBlockArchive} and {@link serveConsultAnswer} cannot
 * drift on how the served revision is labelled or which proof rides with it.
 */
async function readServable(repo: ArchiveServingRepo, blockId: BlockId, rev?: number): Promise<Servable | undefined> {
	// `ActionContext` is `{ committed, rev, actionId? }` — nothing else. `committed: []` claims no
	// uncommitted-but-known action, and omitting `actionId` is what keeps this off `StorageRepo`'s
	// pending-overlay path, so the read is purely "the highest COMMITTED revision at or below `rev`".
	const context: ActionContext | undefined = rev !== undefined ? { rev, committed: [] } : undefined;
	const result = await repo.get({ blockIds: [blockId], context }, { skipClusterFetch: true } as any);
	const entry = result[blockId];
	const latest = entry?.state?.latest;
	if (!latest) return undefined;
	// The revision the content in hand IS. A repo that reports `materialized` (`StorageRepo`) has
	// served the highest committed revision at or below the pin, and that — never `state.latest`,
	// the repo's NEWEST revision — is the archive's label. A repo that does not report it (a plain
	// `IRepo`) can only be describing its latest.
	const served = entry.materialized ?? latest;
	const proof = await servableProof(repo, blockId, served);
	return { served, latest, block: entry.block, proof };
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
 * Exported for the SAME reason {@link singleRevisionArchive} is: a node answers the latest-revision
 * consult about itself out of its own repo rather than over the sync protocol (the self
 * short-circuit in `libp2p-node-base.ts`), and a self answer that attached proofs by a different
 * rule than a peer's would let the two answers weigh differently.
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
