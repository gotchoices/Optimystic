import { Atomic } from './atomic.js';
import type { IBlock, BlockId, BlockStore, BlockType, BlockHeader, BlockOperation, ReadPurpose } from '../index.js';

/**
 * Opaque handle to an in-flight atomic scope.
 *
 * A method that opens a scope (via {@link AtomicProxy.atomic}) receives the scope as its
 * callback argument. To make a *nested* call reuse the enclosing scope — rather than open
 * (and separately commit) a second one — pass that handle back as the `parent` argument of
 * the nested `atomic()` call. This is how genuine nesting is distinguished from a second,
 * unrelated concurrent scope, portably (no `AsyncLocalStorage`, which is Node-only).
 */
export interface AtomicScope { readonly __atomicScope: unique symbol; }

/**
 * A BlockStore proxy that enables scoped atomic operations.
 * Operations normally delegate directly to the underlying store,
 * but during an `atomic()` call, they route through an Atomic tracker
 * that commits all-or-nothing on success, or rolls back on error.
 *
 * Both the BTree and its trunk should share the same AtomicProxy instance
 * so that all mutations (including root pointer updates) are part of the
 * same atomic batch.
 *
 * Concurrency model: top-level `atomic()` calls are *serialized* through a promise queue,
 * so a second, un-awaited scope started while the first is still in flight waits for the
 * first to commit/roll back before opening its own tracker — it never shares the first's
 * tracker. A genuinely nested call (one that hands back its enclosing scope) bypasses the
 * queue and reuses that scope, so it neither deadlocks on itself nor double-commits.
 */
export class AtomicProxy<T extends IBlock> implements BlockStore<T> {
	private _base: BlockStore<T>;
	private _active: BlockStore<T>;
	/** Tail of the serialization queue; each new top-level scope awaits the prior one. */
	private _tail: Promise<void> = Promise.resolve();
	/** The scope currently executing, or undefined between scopes. Serialization guarantees
	 *  at most one is active at a time, so identity against `parent` cleanly separates a
	 *  nested call (parent === current) from a foreign concurrent one (parent absent/stale). */
	private _current?: AtomicScope;

	constructor(store: BlockStore<T>) {
		this._base = store;
		this._active = store;
	}

	async tryGet(id: BlockId, purpose?: ReadPurpose): Promise<T | undefined> { return this._active.tryGet(id, purpose); }
	/** Forward a leaf-value upgrade to the active store (duck-typed; the Tracker/CacheSource chain
	 *  implements it). Keeps navigation-read filtering working for a B-tree bound to this proxy. */
	markReadValue(id: BlockId): void { (this._active as { markReadValue?: (id: BlockId) => void }).markReadValue?.(id); }
	insert(block: T): void { this._active.insert(block); }
	update(blockId: BlockId, op: BlockOperation): void { this._active.update(blockId, op); }
	delete(blockId: BlockId): void { this._active.delete(blockId); }
	generateId(): BlockId { return this._active.generateId(); }
	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader { return this._active.createBlockHeader(type, newId); }

	/** Execute fn within an atomic scope. All store mutations are collected and committed on
	 *  success, or discarded on error. `fn` receives a scope handle; pass it as the `parent`
	 *  of any nested `atomic()` call that should join this scope instead of opening its own.
	 *  Re-entrant safe (nesting reuses the parent scope) and concurrency safe (unrelated
	 *  overlapping scopes serialize rather than sharing a tracker). */
	async atomic<R>(fn: (scope: AtomicScope) => Promise<R>, parent?: AtomicScope): Promise<R> {
		// Genuine nesting: the caller handed back the scope it is already inside. Reuse it —
		// no second tracker, no second commit — and skip the queue, since waiting on the very
		// scope we are running inside would deadlock.
		if (parent !== undefined && parent === this._current) {
			return fn(parent);
		}
		// Top-level scope (first, or a foreign call that overlapped one in flight): take a
		// place in the serialization queue so it runs against its own tracker only after the
		// prior scope has committed/rolled back.
		const prior = this._tail;
		let release!: () => void;
		this._tail = new Promise<void>(resolve => { release = resolve; });
		await prior;
		const atomic = new Atomic<T>(this._base);
		const scope = atomic as unknown as AtomicScope;
		this._current = scope;
		this._active = atomic;
		try {
			const result = await fn(scope);
			atomic.commit();
			return result;
		} catch (e) {
			atomic.reset();
			throw e;
		} finally {
			this._active = this._base;
			this._current = undefined;
			release();
		}
	}
}
