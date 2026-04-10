import type { IKVStore } from "./i-kv-store.js";

/** In-memory IKVStore backed by a Map. Used for testing. */
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
