import type { MMKV } from './mmkv-storage.js';
import type { IKVStore } from '@optimystic/db-p2p';

/** MMKV-backed IKVStore adapter for React Native. */
export class MMKVKVStore implements IKVStore {
	constructor(private readonly mmkv: MMKV, private readonly prefix = 'optimystic:txn:') {}

	async get(key: string): Promise<string | undefined> {
		return this.mmkv.getString(this.prefix + key);
	}

	async set(key: string, value: string): Promise<void> {
		this.mmkv.set(this.prefix + key, value);
	}

	async delete(key: string): Promise<void> {
		this.mmkv.delete(this.prefix + key);
	}

	async list(prefix: string): Promise<string[]> {
		const fullPrefix = this.prefix + prefix;
		return this.mmkv.getAllKeys()
			.filter(k => k.startsWith(fullPrefix))
			.map(k => k.slice(this.prefix.length));
	}
}
