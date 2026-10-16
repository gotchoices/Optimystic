import type { ActionId, BlockId } from '@optimystic/db-core';
import {
	JournalBatchBackend,
	JournalRecordDecodeError,
	KvRawStorage,
	WriteGroupDriver,
	decodeJournalRecord,
	encodeJournalRecord,
	identityForHandle,
	type JournalBatchBackendOptions,
	type JournalContents,
	type JournalRecord,
	type JournalStore,
	type StoreDurability,
	type StoreIdentity,
	type StoreKey,
	type WriteGroupOptions,
} from '@optimystic/db-p2p';
import { drain, type LevelDBLike, type LevelDBWriteBatchLike } from './leveldb-like.js';
import {
	TAG_PENDING,
	actionIdFromKey,
	blockEnvelopeRange,
	blockIdFromMetadataKey,
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
		case 'pending':
			return pendingKey(key.blockId, key.actionId);
		case 'transactions':
			return transactionKey(key.blockId, key.actionId);
		case 'materialized':
			return materializedKey(key.blockId, key.actionId);
	}
}

/**
 * LevelDB {@link JournalStore}: the six logical block-storage stores mapped into a single ordered
 * byte keyspace, partitioned by a leading tag byte (see `./keys.ts`), read exactly as the per-write
 * driver before it read them, so data an earlier build wrote reads unchanged; and the journal under
 * its own tag byte, which `JournalBatchBackend` drives.
 *
 * `KvRawStorage` owns all JSON/UTF-8 serialization, so this store only ever reads/writes raw
 * `Uint8Array` values; a journal record is bytes too, through `encodeJournalRecord`. Everything
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
 * The handle is shared with `LevelDBKVStore` and `loadOrCreateRNPeerKey`, so there is no `close`
 * here: the host closes the handle after `storage.close()` has resolved.
 */
export class LevelDBJournalStore implements JournalStore {
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
		this.identity = identityForHandle('leveldb-handle', db);
	}

	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	// --- reads: the applied stores ---

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		return this.db.get(keyBytes(key));
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		// Revs are encoded 8-byte big-endian (`revisionKey`), so byte order == numeric
		// order and `revisionKey(blockId, hi)` is exactly the inclusive upper bound;
		// LevelDB's upper bound is exclusive (`lt`), so use `lt = revisionKey(hi + 1)`.
		const gte = revisionKey(blockId, lo);
		const lt = revisionKey(blockId, hi + 1);
		// Drained before returning: a native LevelDB iterator must not stay open across the
		// consumer's awaits (the kernel's drain-before-yield contract).
		const entries = await drain(this.db.iterator({ gte, lt }));
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

	// NOTE: full-scan byte sum — O(total bytes) per call. Fine as an advisory
	// StorageMonitor input at current sizes; if a StorageMonitor ever polls this
	// on a large db, replace with the kernel's incremental write-path counter
	// (see the seam NOTE in kv-raw-storage.ts's saveMetadata).
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
	// `LevelDBKVStore` and `loadOrCreateRNPeerKey` (one db per RN peer — see the
	// README usage), so the store must not own its lifecycle; closing it here
	// would break the other two. Same rationale as the IndexedDB store.
}

/** The record's entries onto the batch, in order: a put stores the value, a delete removes the key. */
function putEntries(batch: LevelDBWriteBatchLike, record: JournalRecord): void {
	for (const { key, value } of record.entries) {
		const encoded = keyBytes(key);
		if (value === undefined) batch.delete(encoded); else batch.put(encoded, value);
	}
}

/** The write group's and the journal backend's options (`idleFlushMs`, `maxUnsyncedBytes`, the test-only `setTimer` and `now`). */
export type LevelDBRawStorageOptions = WriteGroupOptions & JournalBatchBackendOptions;

/**
 * LevelDB-backed {@link IRawStorage} for React Native peers: the shared {@link KvRawStorage}
 * kernel over a {@link WriteGroupDriver} over a {@link JournalBatchBackend} over a
 * {@link LevelDBJournalStore}. Every write resolves into the driver's in-memory overlay; `flush()`
 * hands the group to the backend as one LevelDB batch — applied before the flush resolves, or,
 * for a flush with a window on a handle that can sync, appended as one journal record and applied
 * by the deadline. The public name/constructor (`new LevelDBRawStorage(db)`) is unchanged so
 * existing imports keep resolving.
 *
 * `listBlockIds`/`getApproximateBytesUsed`/`getStoreIdentity`/`close` are re-declared here as
 * always-present (the store always implements the first three, so the backend, driver and kernel
 * always wire them, and the driver always has a `close`) — the base declares them optional, but
 * every RN consumer relies on them. `close()` applies what is still held and disarms the timers;
 * it does not close the shared handle, which the host closes afterwards.
 */
export class LevelDBRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;
	declare getStoreIdentity: () => StoreIdentity;
	declare close: () => Promise<void>;

	constructor(db: LevelDBLike, options: LevelDBRawStorageOptions = {}) {
		super(new WriteGroupDriver(new JournalBatchBackend(new LevelDBJournalStore(db), options), options));
	}
}
