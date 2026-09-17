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



