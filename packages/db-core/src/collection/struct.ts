import type { IBlock, BlockId, Action } from "../index.js";
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
}

/** Thrown by {@link ICollection.sync} / {@link ICollection.updateAndSync} when the retry budget
 * (attempt count or deadline) is exhausted while the transactor keeps returning stale failures.
 * Catchable so callers can surface a clear "gave up syncing" condition instead of hanging. */
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
	sync(options?: SyncOptions): Promise<void>;
	updateAndSync(options?: SyncOptions): Promise<void>;
	selectLog(forward?: boolean): AsyncIterableIterator<Action<TAction>>;
}

export type CreateCollectionAction = Action<void> & {
	type: "create";
};
