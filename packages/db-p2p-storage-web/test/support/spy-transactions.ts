import type { OptimysticWebDBHandle } from '../../src/db.js';

/** One `transaction()` call the handle was asked for: the stores it covers, its mode, and the durability it asked for. */
export interface TransactionCall {
	readonly stores: readonly string[];
	readonly mode: IDBTransactionMode;
	readonly durability: IDBTransactionDurability | undefined;
}

/**
 * The handle with every explicit `transaction()` call recorded, which is all `fake-indexeddb` can
 * say about durability: it keeps what a transaction asked for and never touches a disk. The stores
 * are sorted, so a call over several reads the same whatever order it named them in. idb's
 * one-request shortcuts (`db.get`, `db.getAllKeys`) are bound to the real handle and open their
 * transactions unseen, so what is recorded is exactly the transactions the stores build themselves;
 * every write of this package is one of those.
 */
export function spyTransactions(db: OptimysticWebDBHandle): { db: OptimysticWebDBHandle; calls: TransactionCall[] } {
	const calls: TransactionCall[] = [];
	// Typed loosely: idb declares `transaction` as overloaded generics a recording wrapper cannot restate, and a proxy trap returns `any` anyway.
	const transaction = (stores: string | ArrayLike<string>, mode?: IDBTransactionMode, options?: IDBTransactionOptions): unknown => {
		calls.push({
			stores: typeof stores === 'string' ? [stores] : [...Array.from(stores)].sort(),
			mode: mode ?? 'readonly',
			durability: options?.durability,
		});
		return (db.transaction as (...args: unknown[]) => unknown)(stores, mode, options);
	};
	const spied = new Proxy(db, {
		get(target, prop) {
			if (prop === 'transaction') return transaction;
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	return { db: spied, calls };
}
