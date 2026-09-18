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
	 * has built on — its declared base for the block is at or past the slot, or, with no base, its
	 * requested revision is past it — is no rival (see `isReservationAgainst` in `pending-claim.ts`),
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
	 * NOTE: the two maps are not always co-keyed. A rev-less pend that names a base would leave an
	 * entry here and none in `pendingRevs`, which the slot-driven dead-claim sweep cannot see, so it
	 * would live until the record is deleted or promoted. Harmless, and no production caller sends a
	 * rev-less pend (see the NOTE in `StorageRepo.pend`); if one ever appears, sweep this map too.
	 */
	pendingBases?: Record<ActionId, number>;
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
	 * travel together, so a serving bug or a hostile peer cannot pair a genuine proof with a
	 * different revision by construction of the wire shape alone.
	 */
	proof?: BlockCommitProof;
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



