import type { IBlock, BlockId, Action, WriteDurability } from "../index.js";
import type { IChainHeader } from "../chain/chain-nodes.js";
import type { RandFn } from "../utility/backoff.js";

export type CollectionId = BlockId;

export type CollectionHeaderBlock = IBlock & Partial<IChainHeader>;

/** Bounds the retry loop inside {@link ICollection.sync} / {@link ICollection.updateAndSync}
 * so a transactor that keeps rejecting the sync can no longer spin the collection latch forever.
 * All fields are optional; unset fields fall back to conservative defaults. */
export interface SyncOptions {
	/** Max consecutive stale-failure retries that make no progress before giving up.
	 * The counter resets to 0 on every successful commit, so a legitimate large multi-batch
	 * sync (which iterates many times making forward progress) is never falsely tripped.
	 * Default 10. */
	maxAttempts?: number;
	/** Optional wall-clock deadline in ms measured from the start of the sync call. Independent
	 * of the attempt count — a progress-agnostic ceiling. Unset means no deadline. */
	deadlineMs?: number;
	/** Base backoff delay in ms applied before the first retry; subsequent retries grow the delay
	 * exponentially up to {@link maxBackoffMs}. Default 100. */
	baseBackoffMs?: number;
	/** Upper bound on any single backoff sleep, in ms. Default 5000. */
	maxBackoffMs?: number;
	/** Optional abort signal. Checked at the top of each loop iteration and raced against the
	 * backoff sleep, so an aborted sync rejects promptly (with an AbortError) rather than finishing
	 * the current sleep. */
	signal?: AbortSignal;
	/** Advanced/testing hook: source of uniform [0,1) randomness for the backoff jitter. Defaults to
	 * the package CSPRNG; inject a deterministic sequence to assert exact retry delays. */
	rand?: RandFn;
	/** Consecutive refreshes that move this collection's revision NOWHERE while a responder has
	 * CONFIRMED a revision at or above the one the next attempt would request, before sync gives up
	 * with {@link SyncRevisionStalledError}. Such a retry provably re-sends the identical, already
	 * lost request, so the wait buys nothing. Two absorbs one transiently-lagging read; set it to
	 * {@link maxAttempts} or higher to restore the pre-existing behaviour of burning the whole
	 * budget. Default 2.
	 *
	 * Neither shape of progress trips this. Ordinary contention: the rival's commit is what the
	 * refresh adopts, so the next request lands above the confirmed revision. A collection still
	 * catching up: the refresh moves the revision forward without yet clearing the confirmed
	 * number, so the next request differs from the one that just failed. Either resets the counter.
	 * {@link deadlineMs} is still checked first, so a sync that is both past its deadline and
	 * stalled reports the deadline (as {@link SyncRetryExhaustedError}), not the stall. */
	maxStalledAttempts?: number;
}

/** Thrown by {@link ICollection.sync} / {@link ICollection.updateAndSync} when the retry budget
 * (attempt count or deadline) is exhausted while the transactor keeps returning stale failures.
 * Catchable so callers can surface a clear "gave up syncing" condition instead of hanging.
 *
 * It says the write was NOT SAVED; it does not prove nothing was stored. A write's log tail is
 * committed before its other blocks, and the attempt that spent the budget is not followed by a
 * refresh, so that attempt's log entry may be standing in the log with none of its data — the state
 * {@link TornActionError} names when a refresh does get to see it. */
export class SyncRetryExhaustedError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		readonly attempts: number,
		readonly lastReason?: string,
		/** The last confirmed revision a responder reported holding, if any responder reported one
		 * (see `StaleFailure.staleAt`). Absent whenever no rejection carried a confirmed number —
		 * which is normal, not a signal that the failure was something other than a lost race. */
		readonly staleAt?: { blockId: BlockId; rev: number },
	) {
		super(`sync for collection ${collectionId} exhausted ${attempts} retries` +
			(lastReason ? `: ${lastReason}` : '') +
			(staleAt ? `, last seen block ${staleAt.blockId} at rev ${staleAt.rev}` : ''));
		this.name = 'SyncRetryExhaustedError';
	}
}

/** Thrown by {@link ICollection.sync} / {@link ICollection.updateAndSync} when refreshing
 * repeatedly moved this collection nowhere at all while a responder confirmed a revision at or
 * above the one being requested — the client's view of the current revision disagrees with the
 * cluster's, and retrying would re-send the identical taken number.
 *
 * The distinction matters because the two failures need different responses. Plain exhaustion
 * means "I lost a race too many times", and waiting longer or retrying later can succeed. This
 * one means the next attempt is provably identical to the one that just failed, so the remaining
 * budget buys nothing — the caller's view of the collection has to be repaired first.
 *
 * Sync deliberately does NOT adopt the responder's revision to get past this. `staleAt` is a bare
 * number, not content: submitting this client's staged transforms at a revision built on a
 * history it never read would overwrite that history silently. Reconciling a genuine fork is
 * partition healing's job (docs/transactions.md), not the retry loop's.
 *
 * Extends {@link SyncRetryExhaustedError} so existing callers that catch the base class keep
 * working; catch this subclass to distinguish "my revision view is wrong" from "I lost a race
 * too many times". */
export class SyncRevisionStalledError extends SyncRetryExhaustedError {
	/** Required here, unlike on the base class — it is the evidence the stall is based on. */
	declare readonly staleAt: { blockId: BlockId; rev: number };

	constructor(
		collectionId: CollectionId,
		attempts: number,
		staleAt: { blockId: BlockId; rev: number },
		/** The revision the next attempt would have requested. */
		readonly requestedRev: number,
		/** The revision this client believes is current. `undefined` for a collection that has
		 * committed nothing. */
		readonly heldRev: number | undefined,
		lastReason?: string,
	) {
		super(collectionId, attempts, lastReason, staleAt);
		// The base class's "exhausted N retries" wording is deliberately NOT reused: it reads as
		// ordinary contention, which is exactly the misdiagnosis this class exists to prevent.
		this.message = `sync for collection ${collectionId} stopped after ${attempts} attempts: `
			+ `this client holds rev ${heldRev ?? 'none'} and would request rev ${requestedRev}, `
			+ `but block ${staleAt.blockId} is confirmed committed at rev ${staleAt.rev} and `
			+ `refreshing did not close the gap`
			+ (lastReason ? `: ${lastReason}` : '');
		this.name = 'SyncRevisionStalledError';
	}
}

/** Why a half-landed write could not be finished (see {@link TornActionError}).
 *
 * - `rival-holds-revision` — a DIFFERENT action holds a revision at or past the one a block needed.
 *   Permanent: nothing can land this write's transform on that block at its revision any more.
 * - `completion-refused` — finishing was attempted and refused for a cause that can clear on its
 *   own (another write in flight on the block, the revision not yet held by a majority). The write
 *   paths retry this inside their own budget, so seeing it means that budget ran out.
 * - `transforms-not-held` — the write's own log entry was found with blocks still missing, but this
 *   collection no longer holds the transforms that would finish them. */
export type TornActionReason = 'rival-holds-revision' | 'completion-refused' | 'transforms-not-held';

/** Thrown when a write HALF-LANDED and was not finished: its log entry is stored, but at least one
 * of the other blocks that entry names does not hold the write's revision.
 *
 * A write's log tail is committed before the rest of its blocks, so a write can be refused AFTER the
 * tail was stored (see `NetworkTransactor.commit`). The writer's retry then finds its own log entry.
 * That entry proves only that the tail landed; the write is saved only once EVERY block the entry
 * names holds the write's revision, so the retry finishes the remaining blocks at the same action id
 * and revision (see `Collection.completeOwnEntry`). This error is what it raises when it could not
 * — {@link reason} says which way.
 *
 * To the CALLER this is never retryable, whatever the reason, and it is deliberately not a
 * {@link SyncRetryExhaustedError}: that error says the write never landed and invites trying again,
 * whereas here the log already holds an entry for a write whose data is not saved. Finishing needs
 * the original action id and the transforms it sent, and both are gone once this escapes (the one
 * reason that CAN clear, `completion-refused`, has already been retried to the end of the budget by
 * the write path that threw). Re-driving under a NEW revision would record the same actions in the
 * log twice, so nothing here does that on the caller's behalf. The staged actions are left in
 * place on the collection; the caller decides whether to discard them or submit them again as a
 * new write, knowing the log already carries one entry for them whose data never landed.
 *
 * Raised out of {@link ICollection.sync} / {@link ICollection.updateAndSync}, and out of the
 * refresh `TransactionCoordinator.commit` runs between attempts (`Collection.refreshInFlight`).
 * The coordinator passes it on bare only when no other participant of the commit is saved; when
 * one is, it arrives as the `reason` of a `CoordinatorPartialCommitError` that names the saved
 * participants. */
export class TornActionError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		/** The half-landed write's action id. */
		readonly actionId: string,
		/** The revision its log entry landed at — the revision every block it names had to take. */
		readonly rev: number,
		/** The blocks the entry names that do not hold that revision — or, when the refusal did not
		 * say which, every block the entry names other than ones known to hold it. */
		readonly blockIds: BlockId[],
		/** Which of the three ways finishing failed — see {@link TornActionReason}. */
		readonly reason: TornActionReason,
		/** The refusal in the responder's own words, for a log line. Never branch on it. */
		readonly detail: string,
		/** The confirmed revision a responder reported holding under ANOTHER action, when the refusal
		 * carried one (see `StaleFailure.staleAt`). */
		readonly staleAt?: { blockId: BlockId; rev: number },
	) {
		super(`collection ${collectionId}: action ${actionId} is torn at rev ${rev} — its log entry is stored `
			+ `but block(s) ${blockIds.join(', ') || '(unknown)'} do not hold that revision, and the write cannot be `
			+ `finished: ${detail}`
			+ (staleAt ? ` (block ${staleAt.blockId} is at rev ${staleAt.rev})` : ''));
		this.name = 'TornActionError';
	}
}

/** Thrown when a collection that already holds a committed revision reads its own header
 * block as authoritatively absent.
 *
 * The two facts contradict each other: this client has proof that something was committed
 * under this id (it holds the revision it committed at, or the one it read off the log tail),
 * and storage has just answered that nothing ever was. Exactly one of them is wrong, so this
 * is a fault rather than an absence — the same reasoning `Collection.attachToLog` applies to a
 * header that probes fine but whose log will not open.
 *
 * Deliberately NOT a `StaleFailure`: {@link ICollection.sync}'s retry loop only absorbs
 * returned stale failures, so throwing this aborts the sync immediately with a named
 * diagnosis instead of letting it spin the full retry budget re-requesting a revision it
 * has silently forgotten.
 *
 * NOTE: durable invalidation restores reverted content to its as-if-absent state, so once the
 * cascade runs end-to-end (docs/right-is-right.md § Durable Invalidation), reverting the commit
 * that CREATED a collection would make its header legitimately absent for a client still holding
 * that revision — a reversal, not a contradiction, which this message would misdiagnose.
 * Aborting is still the right action there; if it ever fires for that reason, distinguish the
 * two by checking the log for an invalidation of the held revision before wording the error. */
export class CollectionHeaderVanishedError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		/** The committed revision this collection held when the header read came back absent. */
		readonly heldRev: number,
	) {
		super(`collection ${collectionId} holds committed revision ${heldRev}, but its header block `
			+ `read as absent — storage reported that nothing was ever committed under this id`);
		this.name = 'CollectionHeaderVanishedError';
	}
}

export interface ICollection<TAction> {
	readonly id: CollectionId;
	act(...actions: Action<TAction>[]): Promise<void>;
	update(): Promise<void>;
	/** Push staged changes. Resolves to who holds what was committed, or `undefined` when NOTHING WAS
	 * WRITTEN — nothing was staged, so there was no pend and no commit and there is no durability to
	 * report. A write that never landed throws ({@link SyncRetryExhaustedError}) rather than returning
	 * a class. Decide "is this saved" with `isFullyDurable`, never by comparing `quorum`. */
	sync(options?: SyncOptions): Promise<WriteDurability | undefined>;
	/** Refresh, then {@link sync}. Same return contract. */
	updateAndSync(options?: SyncOptions): Promise<WriteDurability | undefined>;
	selectLog(forward?: boolean): AsyncIterableIterator<Action<TAction>>;
}

export type CreateCollectionAction = Action<void> & {
	type: "create";
};
