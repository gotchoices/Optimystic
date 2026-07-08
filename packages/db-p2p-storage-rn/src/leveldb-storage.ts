import type { ActionId, BlockId } from '@optimystic/db-core';
import { KvRawStorage, type RawStoreDriver } from '@optimystic/db-p2p';
import { drain, type LevelDBLike } from './leveldb-like.js';
import {
	TAG_PENDING,
	actionIdFromKey,
	blockEnvelopeRange,
	blockIdFromMetadataKey,
	materializedKey,
	metadataKey,
	metadataRange,
	pendingKey,
	revisionFromKey,
	revisionKey,
	transactionKey,
} from './keys.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:leveldb');

/**
 * LevelDB {@link RawStoreDriver}: the five logical block-storage stores mapped
 * into a single ordered byte keyspace, partitioned by a leading tag byte (see
 * `./keys.ts`). LevelDB is already one ordered byte-keyspace, so this driver is
 * mostly key encoding — the tag-prefixed byte scheme in `keys.ts` stays in this
 * package; the kernel deals in logical keys.
 *
 * `KvRawStorage` now owns all JSON/UTF-8 serialization, so this driver only ever
 * reads/writes raw `Uint8Array` values — no `TextEncoder`/`TextDecoder` for
 * values, and no `JSON.parse`/`stringify`. A value round-trips as the exact bytes
 * the kernel wrote. Everything LevelDB-specific stays here: the tag-range scans
 * (drained snapshot-first before yielding, so a native iterator never straddles a
 * consumer's `await`), and the single `WriteBatch` that makes `promote` atomic.
 */
export class LevelDBStoreDriver implements RawStoreDriver {
	constructor(private readonly db: LevelDBLike) {}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		return this.db.get(metadataKey(blockId));
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		await this.db.put(metadataKey(blockId), value);
	}

	// --- revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		return this.db.get(revisionKey(blockId, rev));
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await this.db.put(revisionKey(blockId, rev), value);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		// Revs are encoded 8-byte big-endian (`revisionKey`), so byte order == numeric
		// order and `revisionKey(blockId, hi)` is exactly the inclusive upper bound;
		// LevelDB's upper bound is exclusive (`lt`), so use `lt = revisionKey(hi + 1)`.
		const gte = revisionKey(blockId, lo);
		const lt = revisionKey(blockId, hi + 1);
		// Drain before yielding — a native LevelDB iterator must not stay open across
		// the consumer's awaits (the kernel's drain-before-yield contract).
		const entries = await drain(this.db.iterator({ gte, lt, reverse }));
		for (const [key, value] of entries) {
			yield [revisionFromKey(key), value];
		}
	}

	// --- pending ---

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.db.get(pendingKey(blockId, actionId));
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.db.put(pendingKey(blockId, actionId), value);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.delete(pendingKey(blockId, actionId));
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const range = blockEnvelopeRange(TAG_PENDING, blockId);
		// Drain before yielding, same rationale as rangeRevisions.
		const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
		for (const [key] of entries) {
			yield actionIdFromKey(key, blockId) as ActionId;
		}
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.db.get(transactionKey(blockId, actionId));
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.db.put(transactionKey(blockId, actionId), value);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.db.get(materializedKey(blockId, actionId));
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.db.put(materializedKey(blockId, actionId), value);
	}

	// The kernel owns the put-or-delete branch of `saveMaterializedBlock`, so the
	// driver exposes delete as a separate op.
	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.delete(materializedKey(blockId, actionId));
	}

	// --- promote (the only cross-key atomic op) ---

	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pKey = pendingKey(blockId, actionId);
		const value = await this.db.get(pKey);
		if (!value) {
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		// The single `WriteBatch` IS the atomic move: a crash leaves either the
		// pending or the committed entry, never both/neither.
		const tKey = transactionKey(blockId, actionId);
		await this.db
			.batch()
			.put(tKey, value)
			.delete(pKey)
			.write();
	}

	// --- optional passthroughs ---

	async *listBlockIds(): AsyncIterable<BlockId> {
		// Scan the whole TAG_METADATA keyspace; each metadata key is one distinct
		// block id (empty suffix). keys:true skips values — we only need the ids.
		// Drained before yielding (same discipline as the range scans): a native
		// iterator must not stay open across consumer awaits.
		const range = metadataRange();
		const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
		for (const [key] of entries) {
			yield blockIdFromMetadataKey(key) as BlockId;
		}
	}

	async approximateBytesUsed(): Promise<number> {
		try {
			let total = 0;
			const iter = this.db.iterator();
			try {
				while (true) {
					const entry = await iter.next();
					if (!entry) break;
					total += entry[0].byteLength + entry[1].byteLength;
				}
			} finally {
				await iter.close();
			}
			return total;
		} catch (err) {
			log('approximateBytesUsed iterator failed: %o', err);
			return 0;
		}
	}

	// NOTE: intentionally NO close(). The `LevelDBLike` handle is shared with
	// `LevelDBKVStore` and `loadOrCreateRNPeerKey` (one db per RN peer — see the
	// README usage), so the driver must not own its lifecycle; closing it here
	// would break the other two. Same rationale as the IndexedDB driver. The
	// kernel never wires the optional close() regardless.
}

/**
 * LevelDB-backed {@link IRawStorage} for React Native peers, now a thin shell
 * over the shared {@link KvRawStorage} kernel driven by a {@link LevelDBStoreDriver}.
 * The public name/constructor (`new LevelDBRawStorage(db)`) is unchanged so
 * existing imports keep resolving; the kernel supplies the `IRawStorage` surface
 * and the driver supplies LevelDB behavior.
 *
 * `listBlockIds`/`getApproximateBytesUsed` are re-declared here as always-present
 * (the LevelDB driver always implements them, so the kernel constructor always
 * wires them) — the base declares them optional, but every RN consumer relies on
 * them.
 */
export class LevelDBRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;

	constructor(db: LevelDBLike) {
		super(new LevelDBStoreDriver(db));
	}
}
