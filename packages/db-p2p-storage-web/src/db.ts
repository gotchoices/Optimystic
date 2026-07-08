import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ActionId, BlockId } from '@optimystic/db-core';

/**
 * IndexedDB schema for the Optimystic browser storage backend.
 *
 * The five block-storage stores keep their original object stores and compound
 * array keys, but their values are now opaque `Uint8Array` blobs: the shared
 * `KvRawStorage` kernel owns JSON (de)serialization, so `IndexedDBStoreDriver`
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
 * - `materialized`: materialized block bytes keyed by `[blockId, actionId]`. Deleting
 *   the row is a driver `delete`, not a stored `undefined`.
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
	materialized: {
		key: [BlockId, ActionId];
		value: Uint8Array;
	};
	kv: {
		key: string;
		value: string | Uint8Array;
	};
}

export const DEFAULT_DB_NAME = 'optimystic';
export const DEFAULT_DB_VERSION = 1;

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
			if (!db.objectStoreNames.contains('materialized')) {
				db.createObjectStore('materialized');
			}
			if (!db.objectStoreNames.contains('kv')) {
				db.createObjectStore('kv');
			}
		},
	});
}
