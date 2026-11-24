import type { ActionId, BlockId } from '@optimystic/db-core';
import {
	CachedStoreDriver,
	JournalBatchBackend,
	JournalRecordDecodeError,
	KvRawStorage,
	WriteGroupDriver,
	decodeJournalRecord,
	encodeJournalRecord,
	identityForHandle,
	textValueCodec,
	type JournalBatchBackendOptions,
	type JournalContents,
	type JournalRecord,
	type JournalStore,
	type SharedCachePool,
	type StoreDurability,
	type StoreIdentity,
	type StoreKey,
	type WriteGroupOptions,
} from '@optimystic/db-p2p';
import { LEVELDB_HANDLE_SCHEME, drain, type LevelDBIteratorOptions, type LevelDBLike, type LevelDBWriteBatchLike } from './leveldb-like.js';
import { measurePieces } from './leveldb-piece-store.js';
import {
	TAG_MATERIALIZED,
	TAG_METADATA,
	TAG_PENDING,
	TAG_PROOFS,
	TAG_REVISIONS,
	TAG_TRANSACTIONS,
	actionIdFromKey,
	blockEnvelopeRange,
	blockIdFromMetadataKey,
	commitProofKey,
	decodeJournalMark,
	encodeJournalMark,
	isJournalMarkKey,
	journalMarkKey,
	journalRange,
	journalRecordKey,
	materializedKey,
	metadataKey,
	metadataRange,
	pendingKey,
	pieceRange,
	proofKey,
	revisionFromKey,
	revisionKey,
	seqFromJournalKey,
	transactionKey,
} from './keys.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:leveldb');

/** The LevelDB key a `StoreKey` addresses: the tag-prefixed byte scheme of `keys.ts`, unchanged from the per-write driver before it. */
function keyBytes(key: StoreKey): Uint8Array {
	switch (key.store) {
		case 'metadata':
			return metadataKey(key.blockId);
		case 'revisions':
			return revisionKey(key.blockId, key.rev);
		case 'proofs':
			return proofKey(key.blockId, key.rev);
		case 'commitProofs':
			return commitProofKey(key.messageHash);
		case 'pending':
			return pendingKey(key.blockId, key.actionId);
		case 'transactions':
			return transactionKey(key.blockId, key.actionId);
		case 'materialized':
			return materializedKey(key.blockId, key.actionId);
	}
}

/**
 * The tags `deleteBlock` empties, metadata first — the six block-scoped stores. `TAG_COMMIT_PROOFS`
 * is absent and must stay absent: its keys name consensus messages, not blocks (see
 * `BatchBackend.deleteBlock`). So are the tags of everything else sharing the handle — the journal,
 * the pieces, the key-value store and the identity key.
 */
const BLOCK_SCOPED_TAGS: readonly number[] = [
	TAG_METADATA, TAG_REVISIONS, TAG_PROOFS, TAG_PENDING, TAG_TRANSACTIONS, TAG_MATERIALIZED,
];

/**
 * LevelDB {@link JournalStore}: the seven logical block-storage stores mapped into a single ordered
 * byte keyspace, partitioned by a leading tag byte (see `./keys.ts`), read exactly as the per-write
 * driver before it read them, so data an earlier build wrote reads unchanged; and the journal under
 * its own tag byte, which `JournalBatchBackend` drives.
 *
 * `KvRawStorage` owns all JSON serialization, so this store only moves values: it writes the
 * UTF-8 bytes the write group hands it, and reads each value back as the text those bytes decode
 * to, decoded by LevelDB's binding in native code (`LevelDBLike.getText` and `textIterator`), so a
 * read never reaches a JavaScript `TextDecoder` — on React Native a polyfill, measured as the
 * largest single cost of an offline save on an older phone (GitHub #51). A journal record stays
 * bytes, through `encodeJournalRecord`, and is read only by recovery at open. Everything
 * LevelDB-specific stays here: the tag-range scans (drained snapshot-first before yielding, so a
 * native iterator never straddles a consumer's `await`), and the one `WriteBatch` each journal
 * write is.
 *
 * ### Why a group survives, and in order
 *
 * A LevelDB batch is atomic, but LevelDB syncs only its current log file, closes an old one
 * unsynced when it switches, and under default options skips a damaged log record and keeps the
 * ones after it, so a later write can survive a power cut while an earlier one is lost — which is
 * why the backend journals (see `JournalBatchBackend`). Here an append is one unsynced batch
 * putting the record under its sequence, and an apply is one batch over the data tags and the
 * journal — every record's entries in order, the applied-through mark, and the delete of each
 * record applied or discarded — written synced wherever the handle can sync (`canSync`). The apply
 * carries every byte it applies, so its durability depends on no earlier batch, and the backend
 * syncs each apply before the next starts: what a power cut leaves is a prefix of the groups, and
 * `durability` is `'power-loss'`. Nothing this package writes bypasses a batch, so no unsynced
 * direct write can sit in an old log file outside the journal's reach.
 *
 * `rn-leveldb` cannot sync today, so on a phone the store reports `'process-crash'` and the backend
 * applies each group at once as one unsynced batch, never journaling: a group lands whole or not
 * at all, and the ordering half of the contract arrives with the binding change and nothing here.
 *
 * The handle is shared with `LevelDBKVStore`, `LevelDBPieceStore` and `loadOrCreateRNPeerKey`, so
 * there is no `close` here: the host closes the handle after `storage.close()` has resolved.
 */
export class LevelDBJournalStore implements JournalStore<string> {
	// NOTE: `'process-crash'` holds only while the handle cannot sync (flush contract rule 3 is then
	// not kept across a power cut: LevelDB's recovery skips a damaged log record and keeps the ones
	// after it, and no apply is synced). The synced path is built and tested over `classic-level`;
	// `react-native-storage-syncs-once-rn-leveldb-can` is the binding change that turns it on.
	readonly durability: StoreDurability;

	// NOTE: identity is the HANDLE object, so two handles opened over the same LevelDB PATH read
	// as two identities. Resolving that would mean naming the underlying on-disk path, which
	// `LevelDBLike` does not expose. The package opener (`rn-opener.ts`) hands out one handle per
	// path in practice, so this is the reachable case, not the complete one.
	private readonly identity: StoreIdentity;

	constructor(private readonly db: LevelDBLike) {
		this.durability = db.canSync ? 'power-loss' : 'process-crash';
		this.identity = identityForHandle(LEVELDB_HANDLE_SCHEME, db);
	}

	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	// --- reads: the applied stores ---

	async get(key: StoreKey): Promise<string | undefined> {
		return this.db.getText(keyBytes(key));
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, string][]> {
		// Revs are encoded 8-byte big-endian (`revisionKey`), so byte order == numeric
		// order and `revisionKey(blockId, hi)` is exactly the inclusive upper bound;
		// LevelDB's upper bound is exclusive (`lt`), so use `lt = revisionKey(hi + 1)`.
		const gte = revisionKey(blockId, lo);
		const lt = revisionKey(blockId, hi + 1);
		// Drained before returning: a native LevelDB iterator must not stay open across the
		// consumer's awaits (the kernel's drain-before-yield contract).
		const entries = await drain(this.db.textIterator({ gte, lt }));
		return entries.map(([key, value]) => [revisionFromKey(key), value]);
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		const range = blockEnvelopeRange(TAG_PENDING, blockId);
		const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
		return entries.map(([key]) => actionIdFromKey(key, blockId) as ActionId);
	}

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

	/**
	 * The whole database: every key and value below the piece range and above it, and the pieces'
	 * lengths from their size keys (`measurePieces`), so the blob pieces sharing the handle are
	 * counted once, here, without reading their bytes — `LevelDBPieceStore` reports this store's
	 * identity, which tells `StorageAccount` not to add them again.
	 */
	// NOTE: full-scan byte sum of everything but the pieces — O(block-store bytes) per call. Fine as an
	// advisory StorageAccount input at current sizes; if a StorageAccount ever polls this on a large
	// db, replace with the kernel's incremental write-path counter (see the seam NOTE in
	// kv-raw-storage.ts's saveMetadata). The piece range is measured from its size keys, 4 bytes per
	// piece, so blob bytes never pass through the binding here.
	// NOTE: no `approximateBytesFree`. This package is handed an already-open `LevelDBLike` handle, not
	// a path, and the binding exposes no free-space call, so there is nothing honest to answer. Omitted
	// entirely rather than stubbed, under `BatchBackend.approximateBytesFree`'s rule: a stub answering 0
	// would read as "full". A host that knows the device's figure supplies it to the node itself.
	async approximateBytesUsed(): Promise<number> {
		try {
			const pieces = pieceRange();
			const below = await this.sumEntryBytes({ lt: pieces.gte });
			const above = await this.sumEntryBytes({ gte: pieces.lt });
			return below + above + await measurePieces(this.db);
		} catch (err) {
			log('approximateBytesUsed iterator failed: %o', err);
			return 0;
		}
	}

	/** The key and value lengths of every entry in `range`, summed as one scan is read, never held. */
	private async sumEntryBytes(range: LevelDBIteratorOptions): Promise<number> {
		let total = 0;
		const iter = this.db.iterator(range);
		try {
			for (;;) {
				const entry = await iter.next();
				if (!entry) break;
				total += entry[0].byteLength + entry[1].byteLength;
			}
		} finally {
			await iter.close();
		}
		return total;
	}

	// --- delete a whole block ---

	/**
	 * `BatchBackend.deleteBlock`: one batch deleting every key in the block's envelope range under
	 * each of the six block-scoped tags, synced wherever the handle can sync. A LevelDB batch is
	 * atomic, so no crash leaves the delete half-done — stronger than the contract's metadata-first
	 * ordering, which the tag order below states anyway.
	 *
	 * Scoped by the key envelope, which is what keeps the other tags sharing this database out of it:
	 * `TAG_COMMIT_PROOFS` (keyed by a consensus message's hash, so a key may still certify revisions
	 * of blocks this node keeps), `TAG_JOURNAL`, `TAG_PIECES`, `TAG_KV` and `TAG_IDENTITY` are not
	 * named. The envelope length-prefixes the block id, so block `a`'s range cannot reach block
	 * `a/b`'s keys.
	 *
	 * Idempotent: a block with no keys scans nothing and writes an empty batch.
	 */
	// NOTE: scan-then-delete, one key at a time, because `LevelDBWriteBatchLike` has no range delete
	// (neither does `rn-leveldb`). The scan is bounded by what the block holds, and a delete is never
	// on a read or commit path; if a sweep of a store with very long block histories ever shows up as
	// slow, batch the ranges in chunks rather than holding every key of a block at once.
	async deleteBlock(blockId: BlockId): Promise<void> {
		const batch = this.db.batch();
		for (const tag of BLOCK_SCOPED_TAGS) {
			const range = blockEnvelopeRange(tag, blockId);
			const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
			for (const [key] of entries) batch.delete(key);
		}
		await batch.write({ sync: this.db.canSync });
	}

	// --- the journal ---

	/** One unsynced batch: the record's bytes under its `seq`. `JournalStore.appendJournal`'s contract. */
	async appendJournal(record: JournalRecord): Promise<void> {
		await this.db.batch().put(journalRecordKey(record.seq), encodeJournalRecord(record)).write();
	}

	/**
	 * One batch over the data tags and the journal, synced wherever the handle can sync: each
	 * record's entries in order, then the mark, then the delete of every numbered record. A number
	 * with no record present (a strict group's, never appended) deletes nothing.
	 * `JournalStore.applyJournal`'s contract.
	 */
	// NOTE: on a handle that cannot sync every group is applied this way, so each flush also puts the
	// mark and deletes a record key that was never appended (a LevelDB tombstone): two small extra
	// operations per flush, unmeasured. If flush cost on phones ever shows in profiles, have the
	// backend hand the store only the numbers it appended, rather than every number applied.
	async applyJournal(apply: readonly JournalRecord[], appliedThrough: number, discard: readonly number[]): Promise<void> {
		const batch = this.db.batch();
		for (const record of apply) {
			putEntries(batch, record);
		}
		batch.put(journalMarkKey(), encodeJournalMark(appliedThrough));
		for (const { seq } of apply) batch.delete(journalRecordKey(seq));
		for (const seq of discard) batch.delete(journalRecordKey(seq));
		await batch.write({ sync: this.db.canSync });
	}

	/**
	 * One drained scan over the journal's tag: the mark and every numbered record, ascending (the
	 * sequence is 8 bytes big-endian, so key order is sequence order). A record that does not
	 * decode, or whose decoded number is not the one its key names, is left out, which recovery
	 * treats as a gap; a mark that is not 8 bytes reads as 0. `JournalStore.readJournal`'s contract.
	 */
	async readJournal(): Promise<JournalContents> {
		const range = journalRange();
		const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt }));
		let appliedThrough = 0;
		const records: JournalRecord[] = [];
		for (const [key, value] of entries) {
			if (isJournalMarkKey(key)) {
				appliedThrough = this.readMark(value);
			} else {
				const record = this.readRecord(key, value);
				if (record) records.push(record);
			}
		}
		return { appliedThrough, records };
	}

	private readMark(value: Uint8Array): number {
		const mark = decodeJournalMark(value);
		if (mark === undefined || !Number.isSafeInteger(mark)) {
			log('read-journal: the applied-through mark of %s is not a number this build can read (%d bytes) and reads as 0', this.identity, value.byteLength);
			return 0;
		}
		return mark;
	}

	private readRecord(key: Uint8Array, value: Uint8Array): JournalRecord | undefined {
		const seq = seqFromJournalKey(key);
		try {
			const record = decodeJournalRecord(value);
			if (record.seq === seq) return record;
			log('read-journal: a journal record of %s is numbered %d but filed under %s and is left out; recovery treats its number as missing', this.identity, record.seq, String(seq));
			return undefined;
		} catch (err) {
			if (!(err instanceof JournalRecordDecodeError)) throw err;
			log('read-journal: journal record %s of %s is not one this build can read and is left out (%s); recovery treats its number as missing', String(seq), this.identity, err.message);
			return undefined;
		}
	}

	// NOTE: intentionally NO close(). The `LevelDBLike` handle is shared with
	// `LevelDBKVStore`, `LevelDBPieceStore` and `loadOrCreateRNPeerKey` (one db per
	// RN peer — see the README usage), so the store must not own its lifecycle;
	// closing it here would break the others. Same rationale as the IndexedDB store.
}

/** The record's entries onto the batch, in order: a put stores the value, a delete removes the key. */
function putEntries(batch: LevelDBWriteBatchLike, record: JournalRecord): void {
	for (const { key, value } of record.entries) {
		const encoded = keyBytes(key);
		if (value === undefined) batch.delete(encoded); else batch.put(encoded, value);
	}
}

/**
 * The write group's and the journal backend's options (`idleFlushMs`, `maxUnsyncedBytes`, the
 * test-only `setTimer` and `now`), and the read cache's.
 */
export interface LevelDBRawStorageOptions extends WriteGroupOptions, JournalBatchBackendOptions {
	/** The pool the storage's read cache shares its memory budget with; `defaultCachePool()` by default. */
	readCachePool?: SharedCachePool;
	/** Names the storage in the pool's statistics; `'leveldb'` by default. */
	readCacheLabel?: string;
}

/**
 * LevelDB-backed {@link IRawStorage} for React Native peers, every layer holding text: the shared
 * {@link KvRawStorage} kernel over a {@link CachedStoreDriver} (its read cache) over a
 * {@link WriteGroupDriver} over a {@link JournalBatchBackend} over a {@link LevelDBJournalStore}.
 * Every write resolves into the driver's in-memory overlay; `flush()` hands the group to the
 * backend as one LevelDB batch — applied before the flush resolves, or, for a flush with a window on
 * a handle that can sync, appended as one journal record and applied by the deadline. The public
 * name/constructor (`new LevelDBRawStorage(db)`) is unchanged so existing imports keep resolving.
 *
 * The read cache is built in, and there is no option to leave it out: the node's own cache
 * (`withReadCache`) fronts a storage through `RawStorageDriverAdapter`, which carries bytes, so a
 * cold read through it would decode the stored value, re-encode it to bytes and decode it again,
 * twice in JavaScript. Because this storage reports `readCached`, the node and the Quereus plugin
 * pass it through unwrapped. A cache hit is the cached string and one `JSON.parse`. The cache claims
 * the handle in its pool (`SharedCachePool.registerStore`), so a second storage over the same handle
 * while the first is open is refused: two write groups over one store would already break Invariant 1
 * (every write funnels through one `IRawStorage`) in `packages/db-p2p/docs/storage.md`.
 *
 * `listBlockIds`/`getApproximateBytesUsed`/`getStoreIdentity`/`close`/`readCached` are re-declared
 * here as always-present (the store always implements the first three, so every layer always wires
 * them, the cache always has a `close` and always reports `readCached`) — the base declares them
 * optional, but every RN consumer relies on them. `close()` drops the cache and releases its pool
 * registration, then applies what the write group still holds and disarms the timers; it does not
 * close the shared handle, which the host closes afterwards.
 */
export class LevelDBRawStorage extends KvRawStorage<string> {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;
	declare getStoreIdentity: () => StoreIdentity;
	declare close: () => Promise<void>;
	// `declare`, not a field: a field would be redefined as `undefined` after `super()` (see the note
	// on `CachedRawStorage.readCached`).
	declare readonly readCached: true;

	constructor(db: LevelDBLike, options: LevelDBRawStorageOptions = {}) {
		const writeGroup = new WriteGroupDriver(new JournalBatchBackend(new LevelDBJournalStore(db), options), options, textValueCodec);
		super(new CachedStoreDriver(writeGroup, options.readCachePool, options.readCacheLabel ?? 'leveldb', textValueCodec), textValueCodec);
	}
}
