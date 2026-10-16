import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ActionId, BlockId } from '@optimystic/db-core';
import type { JournalRecord } from '@optimystic/db-p2p';

/**
 * The key of the applied-through mark in the `journal` store. A string, where every record's key
 * is a number: IndexedDB orders numbers before strings, so a key range over the numbers never
 * reaches the mark.
 */
export const JOURNAL_MARK_KEY = 'applied-through';

/**
 * IndexedDB schema for the Optimystic browser storage backend.
 *
 * The six block-storage stores keep their original object stores and compound
 * array keys, but their values are opaque `Uint8Array` blobs: the shared
 * `KvRawStorage` kernel owns JSON (de)serialization, so `IndexedDBJournalStore`
 * only ever hands IndexedDB kernel-encoded bytes. IndexedDB stores a
 * `Uint8Array` natively via structured clone and returns a `Uint8Array`, so the
 * bytes round-trip without a codec here.
 *
 * - `metadata`: per-block metadata bytes keyed by `blockId`.
 * - `revisions`: revision lookup keyed by `[blockId, rev]` mapping to actionId bytes.
 *   Range scans use `IDBKeyRange.bound([blockId, startRev], [blockId, endRev])`.
 * - `pending`: pending transform bytes keyed by `[blockId, actionId]`. Listing pending
 *   transactions for a block uses a key cursor over `[blockId, ...]`.
 * - `transactions`: committed transform bytes keyed by `[blockId, actionId]`.
 * - `proofs`: `BlockCommitProof` bytes keyed by `[blockId, rev]` — the same key shape
 *   as `revisions`, deliberately NOT the action keyspace (an action id is caller-chosen,
 *   so no reserved id could be relied on).
 * - `materialized`: materialized block bytes keyed by `[blockId, actionId]`. Deleting
 *   the row is an entry of a write group with no value, not a stored `undefined`.
 * - `journal`: the write groups appended and not yet applied to the six stores above, each a
 *   `JournalRecord` stored by structured clone under its `seq` (no codec: the record's keys are
 *   plain objects and its values `Uint8Array`s), and under {@link JOURNAL_MARK_KEY} the number of
 *   the last record applied. `IndexedDBJournalStore` owns both; nothing else touches the store.
 * - `kv`: a generic string keyspace shared by `IndexedDBKVStore` and the
 *   identity helper. Identity keys are stored as raw `Uint8Array` blobs (under
 *   a separate logical store from string-only `IKVStore` data, but the same
 *   IndexedDB object store — IndexedDB stores typed arrays natively).
 */
export interface OptimysticWebDB extends DBSchema {
	metadata: {
		key: BlockId;
		value: Uint8Array;
	};
	revisions: {
		key: [BlockId, number];
		value: Uint8Array;
	};
	pending: {
		key: [BlockId, ActionId];
		value: Uint8Array;
	};
	transactions: {
		key: [BlockId, ActionId];
		value: Uint8Array;
	};
	proofs: {
		key: [BlockId, number];
		value: Uint8Array;
	};
	materialized: {
		key: [BlockId, ActionId];
		value: Uint8Array;
	};
	journal: {
		key: number | typeof JOURNAL_MARK_KEY;
		value: JournalRecord | number;
	};
	kv: {
		key: string;
		value: string | Uint8Array;
	};
}

export const DEFAULT_DB_NAME = 'optimystic';
// Bumped to 2 when the `proofs` object store was added and to 3 for `journal`. The `upgrade` hook
// is guarded by `objectStoreNames.contains`, so an existing database gains only the stores it
// lacks (backlog `debt-indexeddb-version-upgrade-is-untested-and-unhandled` owns testing that, and
// the open that another tab's older connection blocks).
export const DEFAULT_DB_VERSION = 3;

export type OptimysticWebDBHandle = IDBPDatabase<OptimysticWebDB>;

/**
 * Opens (and creates if necessary) the Optimystic IndexedDB database used by
 * `IndexedDBRawStorage`, `IndexedDBKVStore`, and `loadOrCreateBrowserPeerKey`.
 *
 * The same handle can be safely shared across all three — IndexedDB connections
 * support concurrent transactions across disjoint object stores.
 */
export async function openOptimysticWebDb(
	name: string = DEFAULT_DB_NAME,
	version: number = DEFAULT_DB_VERSION,
): Promise<OptimysticWebDBHandle> {
	return openDB<OptimysticWebDB>(name, version, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('metadata')) {
				db.createObjectStore('metadata');
			}
			if (!db.objectStoreNames.contains('revisions')) {
				db.createObjectStore('revisions');
			}
			if (!db.objectStoreNames.contains('pending')) {
				db.createObjectStore('pending');
			}
			if (!db.objectStoreNames.contains('transactions')) {
				db.createObjectStore('transactions');
			}
			if (!db.objectStoreNames.contains('proofs')) {
				db.createObjectStore('proofs');
			}
			if (!db.objectStoreNames.contains('materialized')) {
				db.createObjectStore('materialized');
			}
			if (!db.objectStoreNames.contains('journal')) {
				db.createObjectStore('journal');
			}
			if (!db.objectStoreNames.contains('kv')) {
				db.createObjectStore('kv');
			}
		},
	});
}
