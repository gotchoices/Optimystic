import type { ActionId, BlockId } from '@optimystic/db-core';
import { KvRawStorage, type RawStoreDriver } from '@optimystic/db-p2p';
import type { OptimysticWebDBHandle } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:indexeddb');

/**
 * IndexedDB {@link RawStoreDriver}: the five logical block-storage stores mapped
 * to the five IndexedDB object stores (`metadata`, `revisions`, `pending`,
 * `transactions`, `materialized`) with their original compound array keys. This
 * is a code refactor, not a storage-format change at the key level.
 *
 * `KvRawStorage` now owns all JSON serialization, so this driver only ever
 * reads/writes `Uint8Array` values — IndexedDB stores a typed array natively via
 * structured clone and returns a `Uint8Array`, so no codec lives here. Everything
 * IndexedDB-specific stays: the range/key cursors (drained snapshot-first before
 * yielding), and the single `readwrite` transaction that makes `promote` atomic.
 */
export class IndexedDBStoreDriver implements RawStoreDriver {
	constructor(private readonly db: OptimysticWebDBHandle) {}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		return this.db.get('metadata', blockId);
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		await this.db.put('metadata', value, blockId);
	}

	// --- revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		return this.db.get('revisions', [blockId, rev]);
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await this.db.put('revisions', value, [blockId, rev]);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		const range = IDBKeyRange.bound([blockId, lo], [blockId, hi]);
		const tx = this.db.transaction('revisions', 'readonly');
		const store = tx.objectStore('revisions');
		// Snapshot first so we don't hold the transaction open across yields —
		// IndexedDB auto-commits idle transactions, which would invalidate the
		// cursor between the consumer's awaits (the kernel's drain-before-yield
		// contract). Do NOT switch to lazy yielding mid-transaction.
		const results: [number, Uint8Array][] = [];
		let cursor = await store.openCursor(range, reverse ? 'prev' : 'next');
		while (cursor) {
			results.push([(cursor.key as [BlockId, number])[1], cursor.value]);
			cursor = await cursor.continue();
		}
		await tx.done;
		for (const result of results) {
			yield result;
		}
	}

	// --- pending ---

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.db.get('pending', [blockId, actionId]);
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.db.put('pending', value, [blockId, actionId]);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.delete('pending', [blockId, actionId]);
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		// IndexedDB key ordering: array keys compare element-by-element, and a
		// shorter prefix-equal array is less than a longer one; arrays sort
		// above all primitive types. So `[blockId]` < `[blockId, anyActionId]`
		// < `[blockId, []]`, which captures exactly every key for this block.
		const range = IDBKeyRange.bound([blockId] as IDBValidKey, [blockId, []] as IDBValidKey);
		const tx = this.db.transaction('pending', 'readonly');
		const store = tx.objectStore('pending');
		// Snapshot-first, same rationale as rangeRevisions.
		const results: ActionId[] = [];
		let cursor = await store.openKeyCursor(range);
		while (cursor) {
			results.push((cursor.key as [BlockId, ActionId])[1]);
			cursor = await cursor.continue();
		}
		await tx.done;
		for (const actionId of results) {
			yield actionId;
		}
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.db.get('transactions', [blockId, actionId]);
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.db.put('transactions', value, [blockId, actionId]);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.db.get('materialized', [blockId, actionId]);
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.db.put('materialized', value, [blockId, actionId]);
	}

	// The kernel owns the put-or-delete branch of `saveMaterializedBlock`, so the
	// driver exposes delete as a separate op.
	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.delete('materialized', [blockId, actionId]);
	}

	// --- promote (the only cross-key atomic op) ---

	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		const key: [BlockId, ActionId] = [blockId, actionId];
		// Single readwrite transaction over both stores IS the atomic move: a crash
		// leaves either the pending or the committed entry, never both/neither.
		const tx = this.db.transaction(['pending', 'transactions'], 'readwrite');
		const pendingStore = tx.objectStore('pending');
		const transactionsStore = tx.objectStore('transactions');
		const value = await pendingStore.get(key);
		if (!value) {
			// Settle the transaction before throwing so the failed promote does not
			// leak an open transaction — keep this ordering.
			await tx.done.catch(() => undefined);
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		await transactionsStore.put(value, key);
		await pendingStore.delete(key);
		await tx.done;
	}

	// --- optional passthroughs ---

	async *listBlockIds(): AsyncIterable<BlockId> {
		// The `metadata` store is keyed by blockId directly, so its keys ARE the
		// distinct block ids. getAllKeys reads them under an implicit readonly
		// transaction and returns an already-materialized array — no cursor held
		// across yields (same rationale as the cursor scans' snapshot-first pattern).
		const keys = await this.db.getAllKeys('metadata');
		for (const key of keys) {
			yield key as BlockId;
		}
	}

	async approximateBytesUsed(): Promise<number> {
		try {
			const estimate = await navigator.storage?.estimate?.();
			return estimate?.usage ?? 0;
		} catch (err) {
			log('navigator.storage.estimate() failed: %o', err);
			return 0;
		}
	}
}

/**
 * IndexedDB-backed {@link IRawStorage} for browser peers, now a thin shell over
 * the shared {@link KvRawStorage} kernel driven by an {@link IndexedDBStoreDriver}.
 * The public name/constructor (`new IndexedDBRawStorage(handle)`) is unchanged so
 * existing imports keep resolving; the kernel supplies the `IRawStorage` surface
 * and the driver supplies IndexedDB behavior.
 *
 * `listBlockIds`/`getApproximateBytesUsed` are re-declared here as always-present
 * (the IndexedDB driver always implements them, so the kernel constructor always
 * wires them) — the base declares them optional, but every web consumer relies
 * on them.
 */
export class IndexedDBRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;

	constructor(db: OptimysticWebDBHandle) {
		super(new IndexedDBStoreDriver(db));
	}
}
