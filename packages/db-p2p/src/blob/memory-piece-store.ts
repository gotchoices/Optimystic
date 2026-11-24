import type { PieceId } from '@optimystic/db-core';
import type { StoreDurability } from '../storage/store-durability.js';
import type { IPieceStore } from './piece-store.js';

/**
 * The in-memory {@link IPieceStore}, a node's default. Copies on `put` and on `get`, so no caller
 * ever holds the bytes it stores. Lives nowhere a block store measures, so it has no
 * `storeIdentity` and `StorageAccount` always adds its figure.
 */
export class MemoryPieceStore implements IPieceStore {
	readonly durability: StoreDurability = 'none';
	private readonly pieces = new Map<PieceId, Uint8Array>();

	async has(id: PieceId): Promise<boolean> {
		return this.pieces.has(id);
	}

	async get(id: PieceId): Promise<Uint8Array | undefined> {
		return this.pieces.get(id)?.slice();
	}

	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		if (!this.pieces.has(id)) this.pieces.set(id, bytes.slice());
	}

	async delete(id: PieceId): Promise<void> {
		this.pieces.delete(id);
	}

	async *list(): AsyncIterable<PieceId> {
		// Snapshot before the first yield, so a put or delete between yields cannot disturb the walk.
		yield* [...this.pieces.keys()];
	}

	async bytesUsed(): Promise<number> {
		let total = 0;
		for (const bytes of this.pieces.values()) total += bytes.byteLength;
		return total;
	}

	async flush(): Promise<void> {
		// Nothing survives a restart, so there is nothing to make durable.
	}
}
