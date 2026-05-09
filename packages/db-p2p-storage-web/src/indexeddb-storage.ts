import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import type { OptimysticWebDBHandle } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:indexeddb');

/**
 * IndexedDB-backed `IRawStorage` implementation for browser peers.
 *
 * Uses real range cursors for `listRevisions` and key cursors for
 * `listPendingTransactions`, and runs `promotePendingTransaction` as a single
 * `readwrite` transaction over the `pending` and `transactions` stores so the
 * move is atomic.
 */
export class IndexedDBRawStorage implements IRawStorage {
	constructor(private readonly db: OptimysticWebDBHandle) {}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.db.get('metadata', blockId);
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.db.put('metadata', metadata, blockId);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return this.db.get('revisions', [blockId, rev]);
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.db.put('revisions', actionId, [blockId, rev]);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		const ascending = startRev <= endRev;
		const lo = ascending ? startRev : endRev;
		const hi = ascending ? endRev : startRev;
		const range = IDBKeyRange.bound([blockId, lo], [blockId, hi]);
		const tx = this.db.transaction('revisions', 'readonly');
		const store = tx.objectStore('revisions');
		// Snapshot first so we don't hold the transaction open across yields —
		// IndexedDB auto-commits idle transactions, which would invalidate the
		// cursor between awaits at the consumer.
		const results: ActionRev[] = [];
		let cursor = await store.openCursor(range, ascending ? 'next' : 'prev');
		while (cursor) {
			results.push({ rev: (cursor.key as [BlockId, number])[1], actionId: cursor.value });
			cursor = await cursor.continue();
		}
		await tx.done;
		for (const result of results) {
			yield result;
		}
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.db.get('pending', [blockId, actionId]);
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.db.put('pending', transform, [blockId, actionId]);
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.delete('pending', [blockId, actionId]);
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		// IndexedDB key ordering: array keys compare element-by-element, and a
		// shorter prefix-equal array is less than a longer one; arrays sort
		// above all primitive types. So `[blockId]` < `[blockId, anyActionId]`
		// < `[blockId, []]`, which captures exactly every key for this block.
		const range = IDBKeyRange.bound([blockId] as IDBValidKey, [blockId, []] as IDBValidKey);
		const tx = this.db.transaction('pending', 'readonly');
		const store = tx.objectStore('pending');
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

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.db.get('transactions', [blockId, actionId]);
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.db.put('transactions', transform, [blockId, actionId]);
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		return this.db.get('materialized', [blockId, actionId]);
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		const key: [BlockId, ActionId] = [blockId, actionId];
		if (block) {
			await this.db.put('materialized', block, key);
		} else {
			await this.db.delete('materialized', key);
		}
	}

	async getApproximateBytesUsed(): Promise<number> {
		try {
			const estimate = await navigator.storage?.estimate?.();
			return estimate?.usage ?? 0;
		} catch (err) {
			log('navigator.storage.estimate() failed: %o', err);
			return 0;
		}
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const key: [BlockId, ActionId] = [blockId, actionId];
		const tx = this.db.transaction(['pending', 'transactions'], 'readwrite');
		const pendingStore = tx.objectStore('pending');
		const transactionsStore = tx.objectStore('transactions');
		const transform = await pendingStore.get(key);
		if (!transform) {
			await tx.done.catch(() => undefined);
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		await transactionsStore.put(transform, key);
		await pendingStore.delete(key);
		await tx.done;
	}
}
