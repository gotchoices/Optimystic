import type { PieceId } from '@optimystic/db-core';
import { identityForHandle, type IPieceStore, type StoreDurability, type StoreIdentity } from '@optimystic/db-p2p';
import { LEVELDB_HANDLE_SCHEME, drain, type LevelDBLike } from './leveldb-like.js';
import {
	decodePieceSize,
	encodePieceSize,
	pieceIdFromSizeKey,
	pieceKey,
	pieceSizeKey,
	pieceSizeRange,
} from './keys.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:pieces');

/** Ids per `list` page, so no page loads every id a node holds at once. */
export const PIECE_LIST_PAGE = 1000;

/**
 * The bytes the pieces under `TAG_PIECES` hold, summed from their size keys: one scan of 4-byte
 * values, reading no piece's bytes. A size value that is not 4 bytes is logged and left out. A
 * failed scan throws; `LevelDBPieceStore.bytesUsed` and `LevelDBJournalStore.approximateBytesUsed`
 * each decide what a failure answers.
 */
export async function measurePieces(db: LevelDBLike): Promise<number> {
	let total = 0;
	const iter = db.iterator(pieceSizeRange());
	try {
		for (;;) {
			const entry = await iter.next();
			if (!entry) break;
			const [key, value] = entry;
			const size = decodePieceSize(value);
			if (size === undefined) {
				log('measure: the size of piece %s is %d bytes, not 4, and is left out', pieceIdFromSizeKey(key), value.byteLength);
				continue;
			}
			total += size;
		}
	} finally {
		await iter.close();
	}
	return total;
}

/**
 * The React Native {@link IPieceStore}: blob pieces under `TAG_PIECES` in the database
 * `openOptimysticRNDb` opens, sharing the handle with `LevelDBRawStorage`, `LevelDBKVStore` and the
 * identity helper. Not a `RawStoreDriver` store and not part of `LevelDBRawStorage`'s write group: a
 * piece is raw bytes written by one batch, and needs no cross-key atomicity (docs/blobs.md §The local
 * store).
 *
 * Each piece is two keys written and deleted in one batch: its bytes, and its length
 * (`pieceKey` and `pieceSizeKey` in `keys.ts`). Only `get` reads a piece's bytes; `has`, `list` and
 * `bytesUsed` read size keys. Pieces are read with `LevelDBLike.get`, never a text read: React
 * Native's block store reads values as text through the engine's UTF-8 decoder, and a piece's bytes
 * are not text, even when they happen to be valid UTF-8.
 *
 * Every put is synced where the handle can sync, and `flush()` resolves at once. LevelDB has no
 * sync of its own: a synced write syncs only the current log file, and LevelDB closes an older one
 * unsynced when it switches (`leveldb-like.ts`). With 256 KiB pieces and a 4 MiB write buffer the log
 * switches every few pieces, so unsynced puts and one synced write at the flush would not cover the
 * pieces in older files; holding the pieces in memory until the flush would hold a whole blob.
 * `rn-leveldb` cannot sync, so on a phone the store reports `'process-crash'` and writes every batch
 * unsynced, exactly as the block store does.
 *
 * There is no `close`: the handle is shared, and the host closes it after the node has stopped. The
 * store holds nothing in memory to release.
 */
export class LevelDBPieceStore implements IPieceStore {
	/** `'power-loss'` when the handle can sync (`LevelDBLike.canSync`), else `'process-crash'`; the rule `LevelDBJournalStore` follows. */
	readonly durability: StoreDurability;

	private readonly identity: StoreIdentity;

	constructor(private readonly db: LevelDBLike) {
		this.durability = db.canSync ? 'power-loss' : 'process-crash';
		this.identity = identityForHandle(LEVELDB_HANDLE_SCHEME, db);
	}

	/** The identity `LevelDBRawStorage` reports over this handle, so `blockStoreCountsPieces` counts the pieces once. */
	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	/** A 4-byte read of the size key, never the piece. */
	async has(id: PieceId): Promise<boolean> {
		return (await this.db.get(pieceSizeKey(id))) !== undefined;
	}

	/** Both adapters return a fresh array per read (`rn-opener.ts` over the buffer the native read allocated, the test driver a copy), which no one else holds. */
	// NOTE: an empty blob is a zero-length piece. `classic-level` reads a zero-length value back as an
	// empty array; whether `rn-leveldb`'s `getBuf` does, or answers `null` as for an absent key, has not
	// been run on a device. If it answers `null`, `get` reads an empty piece as absent while `has` says
	// present: answer an empty array here when the size key holds 0.
	async get(id: PieceId): Promise<Uint8Array | undefined> {
		return this.db.get(pieceKey(id));
	}

	// NOTE: the has-then-write is not atomic. Two puts of one id racing past `has` both write the
	// same bytes and size, which changes nothing, so "a present id writes nothing" holds for every put
	// that does not race one of its own id.
	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		if (await this.has(id)) return;
		// The batch keeps its own copy: `classic-level` copies at `put`, and `rn-opener.ts` copies a
		// sub-view into a buffer of its own (`toArrayBuffer`) before the native batch copies that.
		await this.db.batch()
			.put(pieceKey(id), bytes)
			.put(pieceSizeKey(id), encodePieceSize(bytes.byteLength))
			.write({ sync: this.db.canSync });
	}

	// NOTE: accepted tradeoff — a delete is written unsynced, so on a handle that can sync a power cut
	// can undo one that resolved before a `flush()`, which the flush contract says it should not. What
	// comes back is a content-addressed piece no record names, which the next sweep removes; a sync per
	// deleted piece costs more than that. Revisit if anything comes to rely on a delete surviving.
	async delete(id: PieceId): Promise<void> {
		await this.db.batch()
			.delete(pieceKey(id))
			.delete(pieceSizeKey(id))
			.write();
	}

	/**
	 * Pages of {@link PIECE_LIST_PAGE} size keys, each drained before its ids are yielded, the next
	 * starting after the last key of the one before, so a native iterator never stays open across the
	 * consumer's awaits and no page holds every id.
	 */
	async *list(): AsyncIterable<PieceId> {
		const range = pieceSizeRange();
		let after: Uint8Array | undefined;
		for (;;) {
			const start = after === undefined ? { gte: range.gte } : { gt: after };
			const page = await drain(this.db.iterator({ ...start, lt: range.lt, keys: true, limit: PIECE_LIST_PAGE }));
			for (const [key] of page) yield pieceIdFromSizeKey(key) as PieceId;
			if (page.length < PIECE_LIST_PAGE) return;
			after = page[page.length - 1]![0];
		}
	}

	async bytesUsed(): Promise<number> {
		try {
			return await measurePieces(this.db);
		} catch (err) {
			log('summing piece bytes failed: %o', err);
			return 0;
		}
	}

	/** Every put was synced before it resolved, where the handle can sync, so there is nothing left to do. */
	async flush(): Promise<void> {}
}
