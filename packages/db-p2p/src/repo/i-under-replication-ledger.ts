import type { ActionId, BlockId, DurabilityQuorum } from "@optimystic/db-core";

/**
 * The classes a commit can be acknowledged at while still owing somebody a copy. `full` is excluded
 * by type: a block every cohort member confirmed owes nobody a push, so an entry recording one is
 * a contradiction rather than a state to handle.
 */
export type ShortfallQuorum = Exclude<DurabilityQuorum, 'full'>;

/** One block this node acknowledged below full replication, and who is still missing it. */
export type UnderReplicatedEntry = {
	readonly blockId: BlockId;
	/** The highest under-replicated revision of this block. A later revision SUPERSEDES an earlier
	 *  one: pushing the newer materialization satisfies the older, so entries are keyed by block
	 *  alone and this field is overwritten, never appended to. */
	readonly rev: number;
	readonly actionId: ActionId;
	/** The class the commit was acknowledged at — `local`, `unrouted`, or `majority`. */
	readonly quorum: ShortfallQuorum;
	/** Cohort members that had not confirmed holding `rev`, by peer-id string.
	 *  EMPTY when the cohort could not be named (`local`, `unrouted`): there was nobody to name,
	 *  and the drain must re-resolve the cohort at drain time instead. An empty array therefore
	 *  means "unknown", not "nobody". */
	readonly missingPeerIds: readonly string[];
	/** When this shortfall was first recorded, in milliseconds since the epoch. */
	readonly recordedAt: number;
	/** Consecutive unsuccessful drain rounds — the give-up counter the drain owns. */
	readonly attempts: number;
};

/**
 * The durable record of blocks this node acknowledged below full replication. Written by
 * `CoordinatorRepo.commit` at the moment it answers the writer — the only moment the missing
 * members are known — and read by whatever pushes the missing copies later.
 *
 * Every operation on one block is applied in call order, so each read-compare-write below is atomic
 * with respect to the others for the same block. That guarantee is per ledger INSTANCE: one node owns
 * one ledger over its key-value store, and a second instance writing the same store concurrently is
 * outside it.
 */
export interface IUnderReplicationLedger {
	/**
	 * Record a block's shortfall. Against an existing entry for the same block:
	 * - a HIGHER `rev` replaces it outright, `attempts` and `recordedAt` included — a fresh shortfall
	 *   deserves a fresh give-up budget;
	 * - the SAME `rev` is the same shortfall observed again: the new `quorum` and `missingPeerIds`
	 *   replace the old, and the existing `recordedAt` and `attempts` are kept;
	 * - a LOWER `rev` is skipped, so a slow older commit cannot clobber a newer one.
	 */
	record(entry: UnderReplicatedEntry): Promise<void>;
	/**
	 * A commit at `rev` reached full replication: delete the block's entry, unless that entry records
	 * a HIGHER revision — a newer shortfall is not settled by an older commit finishing.
	 */
	settle(blockId: BlockId, rev: number): Promise<void>;
	get(blockId: BlockId): Promise<UnderReplicatedEntry | undefined>;
	/** Every outstanding entry, oldest `recordedAt` first. The drain pages nothing today: the set is
	 *  bounded by the node's own owned-block count and shrinks as copies land. */
	list(): Promise<UnderReplicatedEntry[]>;
	/** How many entries are outstanding — the drain's "is anything still owed" check between
	 *  passes, so it must be cheap once warm: answered from memory after the first call. */
	size(): Promise<number>;
	/**
	 * Remove `peerIds` from an entry's missing set, deleting the entry when it empties. Returns the
	 * remaining entry, or `undefined` when it was deleted or never existed.
	 *
	 * An entry whose missing set is UNKNOWN (empty — recorded `local` or `unrouted`) is returned
	 * unchanged: removing named peers from an unknown set cannot prove it empty. Name its missing set
	 * first by recording it again at the same `rev`, or `delete` it once the whole re-resolved cohort
	 * has confirmed.
	 *
	 * `heldRev` is the revision the peers confirmed holding. When given, an entry recording a HIGHER
	 * revision is returned unchanged: a copy of an older revision says nothing about a newer
	 * shortfall recorded while that copy was in flight. A copy of a newer revision satisfies an older
	 * entry — a later revision supersedes an earlier one — so `heldRev` above the entry's is fine.
	 */
	satisfy(blockId: BlockId, peerIds: readonly string[], heldRev?: number): Promise<UnderReplicatedEntry | undefined>;
	/** Bump the give-up counter after an unsuccessful drain round. A no-op for an absent entry. */
	noteAttempt(blockId: BlockId): Promise<void>;
	delete(blockId: BlockId): Promise<void>;
}
