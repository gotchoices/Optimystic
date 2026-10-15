import type { BlockId, ActionId } from '@optimystic/db-core';
import { canonicalStoreKey, type BatchBackend, type BatchEntry, type StoreKey } from '../storage/batch-backend.js';
import type { StoreDurability } from '../storage/store-durability.js';

export interface MemoryBatchBackendHooks {
	/**
	 * Runs before each batch is applied, with the batch. Returning a promise parks the commit until
	 * it resolves; throwing or rejecting makes the commit reject with nothing applied.
	 */
	beforeApply?: (entries: readonly BatchEntry[]) => void | Promise<void>;
}

/**
 * Test-only {@link BatchBackend} over maps. Every batch it applied is kept in {@link committed},
 * in commit order, so a test can count commits and read what each carried; {@link hooks} park or
 * fail a commit. Like `MemoryStoreDriver` it reports no `storeIdentity`: two of these are two
 * genuinely different stores.
 */
export class MemoryBatchBackend implements BatchBackend {
	readonly durability: StoreDurability = 'none';
	/** Every batch applied, in commit order. */
	readonly committed: (readonly BatchEntry[])[] = [];
	/** True once {@link close} ran. */
	closed = false;

	private readonly rows = new Map<string, { key: StoreKey; value: Uint8Array }>();

	constructor(private readonly hooks: MemoryBatchBackendHooks = {}) {}

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

	async commit(entries: readonly BatchEntry[]): Promise<void> {
		await this.hooks.beforeApply?.(entries);
		for (const { key, value } of entries) {
			const canonical = canonicalStoreKey(key);
			if (value === undefined) {
				this.rows.delete(canonical);
			} else {
				this.rows.set(canonical, { key, value });
			}
		}
		this.committed.push(entries);
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
}
