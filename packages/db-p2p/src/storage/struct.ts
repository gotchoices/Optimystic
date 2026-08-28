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



