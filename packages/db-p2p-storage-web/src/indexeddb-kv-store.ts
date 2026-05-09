import type { IKVStore } from '@optimystic/db-p2p';
import type { OptimysticWebDBHandle } from './db.js';

/**
 * IndexedDB-backed `IKVStore` adapter for browser peers.
 *
 * Stored keys are namespaced with `prefix` so the `kv` object store can be
 * shared with the identity helper without collisions. `list(prefix)` uses a
 * range-bounded key cursor — never `getAllKeys()` — so a large `kv` store
 * does not pay an O(n) JS-side filter cost.
 */
export class IndexedDBKVStore implements IKVStore {
	constructor(
		private readonly db: OptimysticWebDBHandle,
		private readonly prefix: string = 'optimystic:txn:',
	) {}

	async get(key: string): Promise<string | undefined> {
		const value = await this.db.get('kv', this.prefix + key);
		return typeof value === 'string' ? value : undefined;
	}

	async set(key: string, value: string): Promise<void> {
		await this.db.put('kv', value, this.prefix + key);
	}

	async delete(key: string): Promise<void> {
		await this.db.delete('kv', this.prefix + key);
	}

	async list(prefix: string): Promise<string[]> {
		const fullPrefix = this.prefix + prefix;
		// '￿' is the highest BMP code unit; appending it produces a string
		// that is >= every string starting with `fullPrefix`. IndexedDB compares
		// strings by UTF-16 code units, so this bound is exact.
		const range = IDBKeyRange.bound(fullPrefix, fullPrefix + '￿');
		const tx = this.db.transaction('kv', 'readonly');
		const store = tx.objectStore('kv');
		const keys: string[] = [];
		let cursor = await store.openKeyCursor(range);
		while (cursor) {
			const fullKey = cursor.key as string;
			keys.push(fullKey.slice(this.prefix.length));
			cursor = await cursor.continue();
		}
		await tx.done;
		return keys;
	}
}
