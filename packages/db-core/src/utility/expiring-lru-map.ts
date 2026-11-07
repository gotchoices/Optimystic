import { LruMap } from './lru-map.js';

interface Stamped<V> {
	readonly value: V;
	usedAt: number;
}

/**
 * An {@link LruMap} whose entries also expire `idleMs` after their last use. The size cap bounds memory
 * while the cache is busy; the idle expiry releases entries a long-lived process stopped asking for even
 * when the cap is never reached. Expiry is judged on lookup, so the map needs no timer and no teardown.
 */
export class ExpiringLruMap<K, V> {
	private readonly entries: LruMap<K, Stamped<V>>;

	constructor(maxSize: number, private readonly idleMs: number, private readonly now: () => number = Date.now) {
		if (!(idleMs > 0)) throw new Error('ExpiringLruMap idleMs must be > 0');
		this.entries = new LruMap(maxSize);
	}

	/** The live value for `key`, refreshing its recency and its idle clock; `undefined` once expired. */
	get(key: K): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		const at = this.now();
		if (at - entry.usedAt > this.idleMs) {
			this.entries.delete(key);
			return undefined;
		}
		entry.usedAt = at;
		return entry.value;
	}

	set(key: K, value: V): this {
		this.entries.set(key, { value, usedAt: this.now() });
		return this;
	}

	get size(): number {
		return this.entries.size;
	}
}
