import type { PieceId } from '@optimystic/db-core';
import type { IPieceStore } from '../blob/piece-store.js';
import type { StoreDurability } from '../storage/store-durability.js';
import { StoreLostPowerError } from './power-loss-kv-store.js';

/**
 * Test-only {@link IPieceStore} that models a crash: the `IPieceStore` counterpart of
 * `PowerLossKVStore`. A `put` or `delete` resolves into an in-memory overlay that every read is
 * served from, and `flush()` applies the overlay to the durable pieces. {@link powerLoss} is the
 * crash: what no flush reached is gone, and {@link reopen} opens a fresh store over what survived.
 *
 * It never flushes on its own, so a test decides where the crash lands: an unflushed write stays
 * lost-on-crash until a flush.
 */
export class PowerLossPieceStore implements IPieceStore {
	readonly durability: StoreDurability = 'power-loss';
	/** Writes no flush has reached yet; `null` is a delete. */
	private readonly overlay = new Map<PieceId, Uint8Array | null>();
	private lost = false;

	/** @param durable What survived every earlier crash; shared with the store {@link reopen} returns. */
	constructor(private readonly durable: Map<PieceId, Uint8Array> = new Map()) {}

	async has(id: PieceId): Promise<boolean> {
		this.throwIfLost();
		return this.held(id) !== undefined;
	}

	async get(id: PieceId): Promise<Uint8Array | undefined> {
		this.throwIfLost();
		return this.held(id)?.slice();
	}

	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		this.throwIfLost();
		if (this.held(id) === undefined) this.overlay.set(id, bytes.slice());
	}

	async delete(id: PieceId): Promise<void> {
		this.throwIfLost();
		this.overlay.set(id, null);
	}

	async *list(): AsyncIterable<PieceId> {
		this.throwIfLost();
		yield* [...this.view().keys()];
	}

	async bytesUsed(): Promise<number> {
		this.throwIfLost();
		let total = 0;
		for (const bytes of this.view().values()) total += bytes.byteLength;
		return total;
	}

	async flush(): Promise<void> {
		this.throwIfLost();
		for (const [id, bytes] of this.overlay) {
			if (bytes === null) this.durable.delete(id);
			else this.durable.set(id, bytes);
		}
		this.overlay.clear();
	}

	/** The crash: every put and delete no flush reached is lost, and this store throws
	 * {@link StoreLostPowerError} from every method from now on, since the process that held it is gone. */
	powerLoss(): void {
		this.lost = true;
	}

	/** A fresh store over what survived {@link powerLoss}, which must have run first: two live stores
	 * over one set of pieces would each lose the other's unflushed writes. */
	reopen(): PowerLossPieceStore {
		if (!this.lost) throw new Error('PowerLossPieceStore.reopen: the store has not lost power; call powerLoss() first');
		return new PowerLossPieceStore(this.durable);
	}

	/** The bytes a read sees for `id`: the overlay's write when there is one, else the durable piece. */
	private held(id: PieceId): Uint8Array | undefined {
		const written = this.overlay.get(id);
		if (written !== undefined) return written ?? undefined;
		return this.durable.get(id);
	}

	/** Every piece a read sees: the durable ones with the overlay applied over them. */
	private view(): Map<PieceId, Uint8Array> {
		const pieces = new Map(this.durable);
		for (const [id, bytes] of this.overlay) {
			if (bytes === null) pieces.delete(id);
			else pieces.set(id, bytes);
		}
		return pieces;
	}

	private throwIfLost(): void {
		if (this.lost) throw new StoreLostPowerError();
	}
}
