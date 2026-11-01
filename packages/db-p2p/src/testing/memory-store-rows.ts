import type { BlockId, ActionId } from '@optimystic/db-core';
import { canonicalStoreKey, type BatchEntry, type StoreKey } from '../storage/batch-backend.js';

/**
 * The six block-storage stores as one map keyed by `canonicalStoreKey`: the applied state the two
 * in-memory test doubles (`MemoryBatchBackend`, `MemoryJournalStore`) share, with the reads a
 * `BatchBackend` answers over it. Synchronous; the doubles wrap each call in their own promises.
 * Stores byte references directly, as `MemoryStoreDriver` does: the kernel above never mutates them.
 */
export class MemoryStoreRows {
	private readonly rows = new Map<string, { key: StoreKey; value: Uint8Array }>();

	get(key: StoreKey): Uint8Array | undefined {
		return this.rows.get(canonicalStoreKey(key))?.value;
	}

	rangeRevisions(blockId: BlockId, lo: number, hi: number): [number, Uint8Array][] {
		const results: [number, Uint8Array][] = [];
		for (let rev = lo; rev <= hi; rev++) {
			const value = this.get({ store: 'revisions', blockId, rev });
			if (value !== undefined) results.push([rev, value]);
		}
		return results;
	}

	listPendingActionIds(blockId: BlockId): ActionId[] {
		const ids: ActionId[] = [];
		for (const { key } of this.rows.values()) {
			if (key.store === 'pending' && key.blockId === blockId) ids.push(key.actionId);
		}
		return ids;
	}

	listBlockIds(): BlockId[] {
		const ids: BlockId[] = [];
		for (const { key } of this.rows.values()) {
			if (key.store === 'metadata') ids.push(key.blockId);
		}
		return ids;
	}

	approximateBytesUsed(): number {
		let total = 0;
		for (const [canonical, { value }] of this.rows) {
			total += canonical.length + value.byteLength;
		}
		return total;
	}

	/** Apply a batch in order: a put stores the value, a delete removes the key. */
	apply(entries: readonly BatchEntry[]): void {
		for (const { key, value } of entries) {
			const canonical = canonicalStoreKey(key);
			if (value === undefined) {
				this.rows.delete(canonical);
			} else {
				this.rows.set(canonical, { key, value });
			}
		}
	}

	clear(): void {
		this.rows.clear();
	}
}
