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
	) {
		super(`sync for collection ${collectionId} exhausted ${attempts} retries` +
			(lastReason ? `: ${lastReason}` : ''));
		this.name = 'SyncRetryExhaustedError';
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
