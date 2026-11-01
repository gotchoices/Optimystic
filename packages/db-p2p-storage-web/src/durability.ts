/**
 * Whether this runtime's IndexedDB honours `IDBTransactionOptions.durability`. A browser that does
 * exposes the durability a transaction was given as `IDBTransaction.durability`, an accessor on
 * the prototype (Chrome 83+, and Firefox and Safari in their current releases); one that does not
 * ignores the option and commits every transaction at its default, which current browsers treat
 * as relaxed. Asked once per store, at construction, since a store's `durability` never changes
 * over its life.
 *
 * `fake-indexeddb` keeps the durability a transaction asked for as an own property of the
 * transaction and puts nothing on the prototype, so under it this answers false and the tests
 * override it with `strictDurability: true`.
 */
export function supportsStrictDurability(): boolean {
	return typeof IDBTransaction !== 'undefined' && 'durability' in IDBTransaction.prototype;
}

/** The option every store of this package takes: whether the transactions that must reach the disk ask for strict durability. */
export interface IndexedDBDurabilityOptions {
	/**
	 * Whether a transaction that must survive a power cut asks for `durability: 'strict'`. Defaults to
	 * {@link supportsStrictDurability}. Tests set it, since `fake-indexeddb` honours the option
	 * without advertising it; a host has no reason to.
	 */
	readonly strictDurability?: boolean;
}

export function resolveStrictDurability(options: IndexedDBDurabilityOptions): boolean {
	return options.strictDurability ?? supportsStrictDurability();
}

/**
 * The durability a transaction asks for: `'strict'` for one that must be on the disk before it
 * completes, where the browser supports it, and `'relaxed'` otherwise — what every current
 * browser's default already is, and what a browser without the option does whatever is asked.
 */
export function transactionDurability(strict: boolean): IDBTransactionDurability {
	return strict ? 'strict' : 'relaxed';
}
