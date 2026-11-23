import type { IKVStore } from "./i-kv-store.js";

/**
 * In-memory IKVStore backed by a Map. Used for testing.
 *
 * No `storeIdentity`, for the reason `MemoryStoreDriver` reports none: two memory stores are
 * independent of each other and of any block store, so there is no location for an identity to
 * name. That is why `memoryNodeStorage()` asserts no coverage — `blockStoreCountsPieces`' fallback
 * rule (no identity reported ⇒ count each store's own figure) is the correct one for memory.
 */
export class MemoryKVStore implements IKVStore {
	private readonly store = new Map<string, string>();

	async get(key: string): Promise<string | undefined> {
		return this.store.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list(prefix: string): Promise<string[]> {
		const result: string[] = [];
		for (const key of this.store.keys()) {
			if (key.startsWith(prefix)) {
				result.push(key);
			}
		}
		return result;
	}
}
