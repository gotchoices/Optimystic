import type { ActionId, BlockId } from '@optimystic/db-core';
import {
	JournalBatchBackend,
	KvRawStorage,
	WriteGroupDriver,
	identityForHandle,
	type BatchEntry,
	type JournalBatchBackendOptions,
	type JournalContents,
	type JournalRecord,
	type JournalStore,
	type StoreDurability,
	type StoreIdentity,
	type StoreKey,
	type WriteGroupOptions,
} from '@optimystic/db-p2p';
import { JOURNAL_MARK_KEY, type OptimysticWebDBHandle } from './db.js';
import { resolveStrictDurability, transactionDurability, type IndexedDBDurabilityOptions } from './durability.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:indexeddb');

/** The object stores an apply writes: the six block-storage stores and the journal itself. */
const APPLY_STORES = ['metadata', 'revisions', 'pending', 'transactions', 'proofs', 'materialized', 'journal'] as const;

/** The IndexedDB key a `StoreKey` addresses in its object store: the compound array keys the schema declares. */
type IdbKey = BlockId | [BlockId, number] | [BlockId, ActionId];

function idbKeyOf(key: StoreKey): IdbKey {
	switch (key.store) {
		case 'metadata':
			return key.blockId;
		case 'revisions':
		case 'proofs':
			return [key.blockId, key.rev];
		case 'pending':
		case 'transactions':
		case 'materialized':
			return [key.blockId, key.actionId];
	}
}

/**
 * The stored value as a record this build can read, or `undefined`. A record is stored by
 * structured clone, so this is the check the byte codec's decode makes for LevelDB: a record it
 * fails is left out of `readJournal`, and recovery treats its number as missing.
 */
function asJournalRecord(value: unknown): JournalRecord | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { seq, entries } = value as { seq?: unknown; entries?: unknown };
	if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || !Array.isArray(entries)) return undefined;
	return entries.every(isBatchEntry) ? { seq, entries } : undefined;
}

function isBatchEntry(entry: unknown): entry is BatchEntry {
	if (typeof entry !== 'object' || entry === null) return false;
	const { key, value } = entry as { key?: unknown; value?: unknown };
	return isStoreKey(key) && (value === undefined || value instanceof Uint8Array);
}

function isStoreKey(key: unknown): key is StoreKey {
	if (typeof key !== 'object' || key === null) return false;
	const { store, blockId, rev, actionId } = key as { store?: unknown; blockId?: unknown; rev?: unknown; actionId?: unknown };
	if (typeof blockId !== 'string') return false;
	switch (store) {
		case 'metadata':
			return true;
		case 'revisions':
		case 'proofs':
			return Number.isInteger(rev);
		case 'pending':
		case 'transactions':
		case 'materialized':
			return typeof actionId === 'string';
		default:
			return false;
	}
}

export type IndexedDBJournalStoreOptions = IndexedDBDurabilityOptions;

/**
 * IndexedDB {@link JournalStore}: the six logical block-storage stores mapped to the six IndexedDB
 * object stores (`metadata`, `revisions`, `pending`, `transactions`, `proofs`, `materialized`)
 * with their compound array keys, read exactly as the per-write driver before it read them, so
 * data an earlier build wrote reads unchanged; and the journal in the `journal` object store,
 * which `JournalBatchBackend` drives.
 *
 * `KvRawStorage` owns all JSON serialization, so this store only ever reads/writes `Uint8Array`
 * values — IndexedDB stores a typed array natively via structured clone and returns a `Uint8Array`,
 * so no codec lives here; a journal record is stored by structured clone too. Everything
 * IndexedDB-specific stays: the range/key cursors (drained snapshot-first before yielding), and the
 * one `readwrite` transaction each journal write is.
 *
 * ### Why a group survives a power cut, and in order
 *
 * IndexedDB makes one transaction durable when it is asked to (`durability: 'strict'`: the
 * transaction completes only once the browser has put it on the disk) but promises nothing about
 * the order relaxed transactions reach the disk, which is why the backend journals (see
 * `JournalBatchBackend`). Here an append is one relaxed transaction on `journal` alone, and an
 * apply is one strict transaction over the six stores and `journal`: every record's entries in
 * order, the applied-through mark, and the delete of each record applied or discarded. The apply
 * carries every byte it applies, so its durability depends on no earlier transaction, and the
 * backend syncs each apply before the next starts — so what a power cut leaves is a prefix of the
 * groups, and `durability` is `'power-loss'` wherever the browser honours the option
 * (`supportsStrictDurability`). Every request of a transaction is queued synchronously and the
 * transaction awaited once, because IndexedDB commits a transaction that is left idle.
 *
 * The handle is shared with `IndexedDBKVStore` and `loadOrCreateBrowserPeerKey`, so there is no
 * `close` here: the host closes the handle after `storage.close()` has resolved.
 */
export class IndexedDBJournalStore implements JournalStore {
	// NOTE: in a browser that ignores `durability` this is `'process-crash'`, and there the backend
	// journals nothing and applies every group at once as one relaxed transaction: a group lands
	// whole, but browsers do not promise that what survives an operating-system crash or power cut is
	// a prefix of relaxed transactions (flush contract rule 3). With strict transactions both hold,
	// as the class doc says.
	readonly durability: StoreDurability;

	// NOTE: identity is the HANDLE object, so two handles opened over the same IndexedDB database
	// NAME read as two identities. Resolving that would mean naming the underlying database,
	// which `OptimysticWebDBHandle` does not expose. The package opener (`db.ts`) hands out one
	// handle per database name in practice, so this is the reachable case, not the complete one.
	// Two tabs over one database run two nodes over one store, which Invariant 5 of
	// `packages/db-p2p/docs/storage.md` forbids and nothing here enforces: the second tab's open
	// applies the journal records the first tab still holds, and each then numbers its records from
	// its own count.
	private readonly identity: StoreIdentity;
	private readonly strict: boolean;

	constructor(private readonly db: OptimysticWebDBHandle, options: IndexedDBJournalStoreOptions = {}) {
		this.strict = resolveStrictDurability(options);
		this.durability = this.strict ? 'power-loss' : 'process-crash';
		this.identity = identityForHandle('idb-handle', db);
	}

	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	// --- reads: the applied stores ---

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		return this.db.get(key.store, idbKeyOf(key));
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		const range = IDBKeyRange.bound([blockId, lo], [blockId, hi]);
		const tx = this.db.transaction('revisions', 'readonly');
		const store = tx.objectStore('revisions');
		// Snapshot first so the transaction is not held open across the caller's awaits —
		// IndexedDB auto-commits idle transactions, which would invalidate the cursor
		// (the kernel's drain-before-yield contract). Do NOT switch to lazy yielding mid-transaction.
		const results: [number, Uint8Array][] = [];
		let cursor = await store.openCursor(range);
		while (cursor) {
			results.push([(cursor.key as [BlockId, number])[1], cursor.value]);
			cursor = await cursor.continue();
		}
		await tx.done;
		return results;
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		// IndexedDB key ordering: array keys compare element-by-element, and a
		// shorter prefix-equal array is less than a longer one; arrays sort
		// above all primitive types. So `[blockId]` < `[blockId, anyActionId]`
		// < `[blockId, []]`, which captures exactly every key for this block.
		const range = IDBKeyRange.bound([blockId] as IDBValidKey, [blockId, []] as IDBValidKey);
		const tx = this.db.transaction('pending', 'readonly');
		const store = tx.objectStore('pending');
		// Snapshot-first, same rationale as rangeRevisions.
		const results: ActionId[] = [];
		let cursor = await store.openKeyCursor(range);
		while (cursor) {
			results.push((cursor.key as [BlockId, ActionId])[1]);
			cursor = await cursor.continue();
		}
		await tx.done;
		return results;
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		// The `metadata` store is keyed by blockId directly, so its keys ARE the
		// distinct block ids. getAllKeys reads them under an implicit readonly
		// transaction and returns an already-materialized array — no cursor held
		// across yields (same rationale as the cursor scans' snapshot-first pattern).
		const keys = await this.db.getAllKeys('metadata');
		for (const key of keys) {
			yield key as BlockId;
		}
	}

	async approximateBytesUsed(): Promise<number> {
		try {
			const estimate = await navigator.storage?.estimate?.();
			return estimate?.usage ?? 0;
		} catch (err) {
			log('navigator.storage.estimate() failed: %o', err);
			return 0;
		}
	}

	// --- the journal ---

	/** One relaxed transaction on `journal`: the record under its `seq`. `JournalStore.appendJournal`'s contract. */
	async appendJournal(record: JournalRecord): Promise<void> {
		const tx = this.db.transaction('journal', 'readwrite', { durability: 'relaxed' });
		await Promise.all([tx.store.put(record, record.seq), tx.done]);
	}

	/**
	 * One transaction over the six stores and `journal`, strict where the browser supports it: each
	 * record's entries in order, then the mark, then the delete of every numbered record. A number
	 * with no record present (a strict group's, never appended) deletes nothing.
	 * `JournalStore.applyJournal`'s contract.
	 */
	async applyJournal(apply: readonly JournalRecord[], appliedThrough: number, discard: readonly number[]): Promise<void> {
		const tx = this.db.transaction(APPLY_STORES, 'readwrite', { durability: transactionDurability(this.strict) });
		const requests: Promise<unknown>[] = [];
		for (const record of apply) {
			for (const { key, value } of record.entries) {
				const store = tx.objectStore(key.store);
				requests.push(value === undefined ? store.delete(idbKeyOf(key)) : store.put(value, idbKeyOf(key)));
			}
		}
		const journal = tx.objectStore('journal');
		requests.push(journal.put(appliedThrough, JOURNAL_MARK_KEY));
		for (const { seq } of apply) requests.push(journal.delete(seq));
		for (const seq of discard) requests.push(journal.delete(seq));
		await Promise.all([...requests, tx.done]);
	}

	/** One readonly transaction: every numbered record and the mark. `JournalStore.readJournal`'s contract. */
	async readJournal(): Promise<JournalContents> {
		const tx = this.db.transaction('journal', 'readonly');
		// Every record's key is a positive safe integer; the mark's string key sorts above every number.
		const [values, mark] = await Promise.all([
			tx.store.getAll(IDBKeyRange.bound(1, Number.MAX_SAFE_INTEGER)),
			tx.store.get(JOURNAL_MARK_KEY),
			tx.done,
		]);
		const records: JournalRecord[] = [];
		for (const value of values) {
			const record = asJournalRecord(value);
			if (record) {
				records.push(record);
			} else {
				log('read-journal: a journal record of %s is not one this build can read and is left out; recovery treats its number as missing', this.identity);
			}
		}
		records.sort((a, b) => a.seq - b.seq);
		const appliedThrough = typeof mark === 'number' && Number.isSafeInteger(mark) && mark >= 0 ? mark : 0;
		return { appliedThrough, records };
	}
}

/** The write group's and the journal backend's options (`idleFlushMs`, `maxUnsyncedBytes`, the test-only `setTimer` and `now`), and whether to ask for strict transactions. */
export type IndexedDBRawStorageOptions = WriteGroupOptions & JournalBatchBackendOptions & IndexedDBDurabilityOptions;

/**
 * IndexedDB-backed {@link IRawStorage} for browser peers: the shared {@link KvRawStorage} kernel
 * over a {@link WriteGroupDriver} over a {@link JournalBatchBackend} over an
 * {@link IndexedDBJournalStore}. Every write resolves into the driver's in-memory overlay;
 * `flush()` hands the group to the backend, which applies it as one strict transaction before the
 * flush resolves, or — a flush with a window — appends it as one relaxed journal record and applies
 * it by the deadline. The public name/constructor (`new IndexedDBRawStorage(handle)`) is unchanged
 * so existing imports keep resolving.
 *
 * `listBlockIds`/`getApproximateBytesUsed`/`getStoreIdentity`/`close` are re-declared here as
 * always-present (the store always implements the first three, so the backend, driver and kernel
 * always wire them, and the driver always has a `close`) — the base declares them optional, but
 * every web consumer relies on them. `close()` applies what is still held and disarms the timers; it
 * does not close the shared handle, which the host closes afterwards.
 */
export class IndexedDBRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;
	declare getStoreIdentity: () => StoreIdentity;
	declare close: () => Promise<void>;

	constructor(db: OptimysticWebDBHandle, options: IndexedDBRawStorageOptions = {}) {
		super(new WriteGroupDriver(new JournalBatchBackend(new IndexedDBJournalStore(db, options), options), options));
	}
}
