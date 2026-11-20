import type { BlockId, IBlock, ActionId, ActionRev, ActionTransform, ActionTransforms } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";

export type RevisionRange = [
	/** Inclusive start */
	startRev: number,
	/** Exclusive end, or open-ended if undefined */
	endRev?: number,
];

export type BlockMetadata = {
	// Revision ranges that are present in storage
	ranges: RevisionRange[];
	/** Latest revision - present if the repo is not empty */
	latest?: ActionRev;
	/**
	 * The lowest revision this node's content at `latest` is KNOWN to derive from: every revision
	 * record above it was produced HERE, by applying an update-only transform to the content of the
	 * revision before it. So a revision at or above the floor that the revision index names is part
	 * of what `latest` was built from, and one the index does not name is provably not.
	 *
	 * Anything that installs content this node did not derive moves the floor up to that revision,
	 * because it says nothing about what the content was built from: a replica or forward tombstone
	 * (`saveReplica`/`saveDeletion` — cohort reconcile, churn replication, invalidation), and a
	 * commit whose transform carries an `insert`, which replaces the block wholesale. The block's
	 * first commit starts the floor at its own revision.
	 *
	 * Absent on metadata written before the field existed; the next commit then starts it at the
	 * revision it built on, which claims nothing about the history below. Read through
	 * `IBlockStorage.lineageOf`, never compared by hand.
	 */
	lineageFloor?: number;
	/**
	 * The revision each pending record on this block was pended AT, keyed by the record's action id —
	 * the `rev` of the `PendRequest` it belongs to. This is what turns a pending record into a
	 * *reservation for a slot* rather than a bare "someone is writing": a record the incoming writer
	 * has built on — its requested revision is past the slot, or, where the promise vote reads it, its
	 * declared base for the block is at or past the slot — is no rival (see `isReservationAgainst` in
	 * `pending-claim.ts`),
	 * and one claiming a revision this block has already committed can never be promoted here at all.
	 *
	 * Kept here, beside `latest`, rather than inside the pending record itself, because the raw
	 * drivers move a pending record into the committed store byte-for-byte on promotion (a rename on
	 * the filesystem backend), so the record's value has to stay a plain transform. The pending
	 * NAMESPACE remains the record; this map only says what slot each record claims. An entry whose
	 * record is gone is inert — every reader joins it against the namespace
	 * (`IBlockStorage.listPendingClaims`) — and is dropped when the record is deleted or when
	 * `latest` advances to or past it. A record with no entry (written before the field existed, or
	 * pended without a revision) reads as an unknown claim, which is treated as the strongest kind.
	 */
	pendingRevs?: Record<ActionId, number>;
	/**
	 * The committed revision each pending record's update operations were computed against, keyed
	 * by the record's action id — the pend's `baseRevs[blockId]` (`PendRequest.baseRevs`). Absent for
	 * a record whose pend carried no base for this block (inserted, deleted, or unknown to the
	 * author) and for records written before the field existed; both read as base-unknown. Kept
	 * beside `pendingRevs`, and for the same reason: the raw drivers move a pending record into the
	 * committed store byte-for-byte on promotion, so the record's value has to stay a plain
	 * transform. Written, dropped and swept in the same metadata writes as `pendingRevs`
	 * (`BlockStorage.recordClaim`), so the two can never describe different records.
	 *
	 * A SIBLING map rather than a change to `pendingRevs`' shape, deliberately: metadata written by
	 * the release before this field must stay readable without a migration, and a record with no
	 * entry here simply reads as base-unknown. What each apply site does with an unknown base is
	 * its own rule — `StorageRepo.internalCommit` falls back to the commit's declaration and then
	 * abstains; the read-driven promotion in `StorageRepo.get` declines.
	 *
	 * NOTE: the sibling maps are not always co-keyed with `pendingRevs`. `pendingSince` is stamped on
	 * EVERY record, and a base or a run can be present without a slot, so a rev-less pend leaves an
	 * entry in one of the three siblings and none in `pendingRevs` — which the slot-driven dead-claim
	 * sweep cannot see, so it would live until the record is deleted or promoted. Harmless, and no
	 * production caller sends a rev-less pend (see the NOTE in `StorageRepo.pend`); if one ever
	 * appears, sweep these maps too.
	 */
	pendingBases?: Record<ActionId, number>;
	/**
	 * The run of this node that saved each pending record, keyed by the record's action id — present
	 * only for a record the node applied ALONE (no consensus) for a writer in its own process
	 * (`MessageOptions.localWriter`), and absent for every other record: a remote writer's, a
	 * coordinated write's, one written before the field existed. Read back as
	 * `PendingClaim.localRun`; a record stamped with a run other than the current one is abandoned —
	 * its writer was a transactor in a process of this node that no longer exists — and the next pend
	 * of the block deletes it (`isAbandonedClaim` in `pending-claim.ts`). A third sibling of
	 * `pendingRevs` and `pendingBases`, kept beside them for the same reasons (the record's value
	 * stays a plain transform; metadata the release before the field wrote reads without a
	 * migration) and written, dropped and swept in the same metadata writes
	 * (`BlockStorage.recordClaim`), so the three can never describe different records.
	 */
	pendingRuns?: Record<ActionId, string>;
	/**
	 * When this node stored each pending record, by its own wall clock, keyed by the record's action
	 * id. A record reserves its block against other writers only for a bounded span measured from
	 * this moment; past that span it has LAPSED — it no longer reserves, though it is not deleted and
	 * its own commit is still honoured (`hasLapsed` in `pending-claim.ts`). Read back as
	 * `PendingClaim.pendingSince`.
	 *
	 * Written for EVERY record, unlike the three siblings above: `PendingClaimFields.pendingSince` is
	 * required, so a save path that forgot to stamp it is a compile error rather than a record that
	 * silently lapses on the fallback below. Absent only for a record written before this field
	 * existed, which is judged from the run's start instead (see `hasLapsed`).
	 *
	 * A fourth sibling of `pendingRevs`, `pendingBases` and `pendingRuns`, kept beside them for the
	 * same reasons (the record's value stays a plain transform, so the raw drivers can promote it
	 * byte-for-byte; metadata the release before the field wrote reads without a migration) and
	 * written, dropped and swept in the same metadata writes (`BlockStorage.recordClaim`), so the
	 * four can never describe different records.
	 *
	 * Only ever read by the node that wrote it, against that node's own clock: nothing compares one
	 * node's reading with another's, so clock skew between members is not part of the rule.
	 */
	pendingSince?: Record<ActionId, number>;
};

export type ArchiveRevisions = Record<number, {
	action: ActionTransform;
	block?: IBlock;
	/**
	 * The cohort's commit proof for this revision, when the serving repo retained one.
	 *
	 * Absent in three legitimate cases, all of which every consumer must tolerate exactly as it
	 * tolerated the pre-proof shape: a revision committed before proofs were persisted at all; a
	 * member whose own materialization diverged from the digest the commit declared (it deliberately
	 * stores no proof — see `StorageRepo.persistProofIfContentMatches`); and a peer running an
	 * un-upgraded build.
	 *
	 * Keyed INSIDE the revision entry on purpose: the proof and the `(rev, actionId)` it certifies
	 * travel together, so nothing has to carry the pairing separately. That is a convenience, not the
	 * safeguard this comment once claimed: {@link ArchiveRevisions} now also lets a proof travel
	 * OUTSIDE the entry (`proofRef` below), so the wire shape no longer forbids a mis-pairing. What
	 * forbids it is that the only producer of a reference builds its table FROM the entries it
	 * rewrites (`dedupeResponseProofs` in `storage/block-archive.ts`), that the reader checks a
	 * table entry is filed under its own `messageHash` before resolving it, and that a proof is
	 * evidence of nothing until a consumer verifies it against the claim it was served for
	 * (`verifyBlockCommitProofClaim`, whose claim step is never memoized). Presence was never
	 * evidence.
	 */
	proof?: BlockCommitProof;
	/**
	 * The `messageHash` of the proof for this revision, when the proof travels in the response's own
	 * table (`SyncResponse.proofs`) instead of inside this entry — so a response answering several
	 * blocks of one commit carries that commit's proof once rather than once per block.
	 *
	 * Resolved back into {@link proof} at ONE seam, as a response is read (`SyncClient.requestBlock`),
	 * so no consumer of an archive ever sees a reference. Never stored: `BlockStorage.saveRestored`
	 * copies a revision entry field by field (`RestoredRevision`) and so ignores both the proof and
	 * this, which is why a remote archive's proof is never re-served as this node's own evidence.
	 */
	proofRef?: string;
}>;

export type BlockArchive = {
	blockId: BlockId;
	/** Revisions in this archive */
	revisions: ArchiveRevisions;
	/** Explicit range covered by this archive since revisions may be sparse */
	range: RevisionRange;
	/** Pending actions - present if this range is open-ended */
	pending?: Record<ActionId, ActionTransforms>;
}

/** Should return a BlockRepo with the given rev (materialized) if given,
 * else (no rev) at least the latest revision and any given pending transactions */
export type RestoreCallback = (blockId: BlockId, rev?: number) => Promise<BlockArchive | undefined>;



