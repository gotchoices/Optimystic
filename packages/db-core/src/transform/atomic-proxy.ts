import { Atomic } from './atomic.js';
import type { IBlock, BlockId, BlockStore, BlockType, BlockHeader, BlockOperation } from '../index.js';

/**
 * A BlockStore proxy that enables scoped atomic operations.
 * Operations normally delegate directly to the underlying store,
 * but during an `atomic()` call, they route through an Atomic tracker
 * that commits all-or-nothing on success, or rolls back on error.
 *
 * Both the BTree and its trunk should share the same AtomicProxy instance
 * so that all mutations (including root pointer updates) are part of the
 * same atomic batch.
 */
export class AtomicProxy<T extends IBlock> implements BlockStore<T> {
	private _base: BlockStore<T>;
	private _active: BlockStore<T>;

	constructor(store: BlockStore<T>) {
		this._base = store;
		this._active = store;
	}

	async tryGet(id: BlockId): Promise<T | undefined> { return this._active.tryGet(id); }
	insert(block: T): void { this._active.insert(block); }
	update(blockId: BlockId, op: BlockOperation): void { this._active.update(blockId, op); }
	delete(blockId: BlockId): void { this._active.delete(blockId); }
	generateId(): BlockId { return this._active.generateId(); }
	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader { return this._active.createBlockHeader(type, newId); }

	/** Execute fn within an atomic scope. All store mutations are collected
	 *  and committed on success, or discarded on error. Re-entrant safe. */
	async atomic<R>(fn: () => Promise<R>): Promise<R> {
		if (this._active !== this._base) {
			return fn();	// Already in atomic context
		}
		const atomic = new Atomic<T>(this._base);
		this._active = atomic;
		try {
			const result = await fn();
			atomic.commit();
			return result;
		} catch (e) {
			atomic.reset();
			throw e;
		} finally {
			this._active = this._base;
		}
	}
}
