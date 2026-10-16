import type { BlockId, ActionId } from '@optimystic/db-core';
import { canonicalStoreKey, type BatchBackend, type BatchEntry, type StoreKey } from '../storage/batch-backend.js';
import type { StoreDurability } from '../storage/store-durability.js';
import { StoreFailedError, type CommittedBatch } from '../storage/write-group.js';
import { deferred, type Deferred } from '../deferred.js';

export interface MemoryBatchBackendOptions {
	/**
	 * Runs before each batch is applied, with the batch. Returning a promise parks the commit until
	 * it resolves; throwing or rejecting makes the commit reject with nothing applied.
	 */
	beforeApply?: (entries: readonly BatchEntry[]) => void | Promise<void>;
	/**
	 * Runs before a batch is marked durable, with the batch — on the sync that makes it so. Throwing
	 * or rejecting makes that batch's `durable` reject, and the `sync()` or strict `commit` running
	 * it reject with the same error, and latches the backend failed like a real store: every later
	 * commit and sync throws `StoreFailedError`, and the batches after it stay not durable.
	 */
	beforeDurable?: (entries: readonly BatchEntry[]) => void | Promise<void>;
	/**
	 * When true, a batch committed with `syncWithinMs` above 0 stays not durable until {@link MemoryBatchBackend.sync}
	 * or a later commit with `syncWithinMs` 0; the deadline itself is ignored, so the test decides
	 * when time passes. Default false: every batch is durable when its commit resolves.
	 */
	deferSync?: boolean;
}

/** One batch {@link MemoryBatchBackend} applied. */
export interface MemoryCommittedBatch {
	readonly entries: readonly BatchEntry[];
	/** What the commit was allowed to defer its sync by. */
	readonly syncWithinMs: number;
	/** True once the batch survives {@link MemoryBatchBackend.powerLoss}. */
	durable: boolean;
}

interface Unsynced {
	readonly batch: MemoryCommittedBatch;
	readonly settle: Deferred;
}

const noop = (): void => undefined;

/**
 * Test-only {@link BatchBackend} over maps. Every batch it applied is kept in {@link committed},
 * in commit order, so a test can count commits and read what each carried, what it was allowed to
 * defer, and whether it is durable; the hooks in {@link MemoryBatchBackendOptions} park or fail a
 * commit or a sync. With `deferSync` it is the power-loss double: reads reflect a batch from its
 * commit, {@link sync} makes committed batches durable, and {@link powerLoss} is the crash that
 * keeps only the durable prefix. Like `MemoryStoreDriver` it reports no `storeIdentity`: two of
 * these are two genuinely different stores.
 */
export class MemoryBatchBackend implements BatchBackend {
	readonly durability: StoreDurability = 'none';
	/** Every batch applied, in commit order. */
	readonly committed: MemoryCommittedBatch[] = [];
	/** Calls of {@link sync} — the hasten a strict flush with nothing to seal makes. A commit's own sync is not counted. */
	syncs = 0;
	/** True once {@link close} ran. */
	closed = false;

	private readonly rows = new Map<string, { key: StoreKey; value: Uint8Array }>();
	/** Batches committed and not yet durable, in commit order. */
	private readonly unsynced: Unsynced[] = [];
	/** Syncs run one at a time, in order, on this chain; it never rejects. */
	private syncQueue: Promise<void> = Promise.resolve();
	private fault: { cause: unknown } | undefined;

	constructor(private readonly options: MemoryBatchBackendOptions = {}) {}

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		return this.rows.get(canonicalStoreKey(key))?.value;
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		const results: [number, Uint8Array][] = [];
		for (let rev = lo; rev <= hi; rev++) {
			const value = this.rows.get(canonicalStoreKey({ store: 'revisions', blockId, rev }))?.value;
			if (value !== undefined) results.push([rev, value]);
		}
		return results;
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		const ids: ActionId[] = [];
		for (const { key } of this.rows.values()) {
			if (key.store === 'pending' && key.blockId === blockId) ids.push(key.actionId);
		}
		return ids;
	}

	/**
	 * Apply the batch to the maps at once, so reads reflect it, and record it. Without `deferSync`,
	 * or with `syncWithinMs` 0, this and every earlier batch are durable before this resolves.
	 */
	async commit(entries: readonly BatchEntry[], { syncWithinMs }: { readonly syncWithinMs: number }): Promise<CommittedBatch> {
		this.throwIfFailed();
		await this.options.beforeApply?.(entries);
		this.apply(entries);
		const batch: MemoryCommittedBatch = { entries, syncWithinMs, durable: false };
		const settle = deferred();
		this.committed.push(batch);
		this.unsynced.push({ batch, settle });
		if (!this.options.deferSync || syncWithinMs === 0) await this.syncAll();
		return { durable: settle.promise };
	}

	/** Hasten: mark every committed batch durable, in commit order, resolving each `durable`. */
	sync(): Promise<void> {
		this.throwIfFailed();
		this.syncs += 1;
		return this.syncAll();
	}

	/**
	 * The crash the double models: the maps are rebuilt from the durable batches alone, in order, and
	 * the rest are dropped from {@link committed}. Their `durable` promises never settle, because the
	 * process that awaited them is gone. Open a fresh driver over the backend afterwards, as the
	 * conformance reopen case does.
	 */
	powerLoss(): void {
		const survived = this.committed.filter(batch => batch.durable);
		this.committed.length = 0;
		this.committed.push(...survived);
		this.unsynced.length = 0;
		this.rows.clear();
		for (const batch of survived) this.apply(batch.entries);
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		const ids: BlockId[] = [];
		for (const { key } of this.rows.values()) {
			if (key.store === 'metadata') ids.push(key.blockId);
		}
		yield* ids;
	}

	async approximateBytesUsed(): Promise<number> {
		let total = 0;
		for (const [canonical, { value }] of this.rows) {
			total += canonical.length + value.byteLength;
		}
		return total;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private apply(entries: readonly BatchEntry[]): void {
		for (const { key, value } of entries) {
			const canonical = canonicalStoreKey(key);
			if (value === undefined) {
				this.rows.delete(canonical);
			} else {
				this.rows.set(canonical, { key, value });
			}
		}
	}

	private throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}

	/** Syncs run one at a time so two overlapping ones cannot mark a later batch durable ahead of an earlier one. */
	private syncAll(): Promise<void> {
		const run = this.syncQueue.then(() => this.drainUnsynced());
		this.syncQueue = run.catch(noop);
		return run;
	}

	private async drainUnsynced(): Promise<void> {
		while (this.unsynced.length > 0) {
			const { batch, settle } = this.unsynced.shift()!;
			try {
				await this.options.beforeDurable?.(batch.entries);
			} catch (err) {
				this.fault ??= { cause: err };
				settle.reject(err);
				throw err;
			}
			batch.durable = true;
			settle.resolve();
		}
	}
}
