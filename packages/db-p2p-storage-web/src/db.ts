import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ActionId, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata } from '@optimystic/db-p2p';

/**
 * IndexedDB schema for the Optimystic browser storage backend.
 *
 * - `metadata`: per-block `BlockMetadata` keyed by `blockId`.
 * - `revisions`: revision lookup keyed by `[blockId, rev]` mapping to an `ActionId`.
 *   Range scans use `IDBKeyRange.bound([blockId, startRev], [blockId, endRev])`.
 * - `pending`: pending transforms keyed by `[blockId, actionId]`. Listing pending
 *   transactions for a block uses a key cursor over `[blockId, ...]`.
 * - `transactions`: committed transforms keyed by `[blockId, actionId]`.
 * - `materialized`: materialized blocks keyed by `[blockId, actionId]`. Saving
 *   `undefined` deletes the row.
 * - `kv`: a generic string keyspace shared by `IndexedDBKVStore` and the
 *   identity helper. Identity keys are stored as raw `Uint8Array` blobs (under
 *   a separate logical store from string-only `IKVStore` data, but the same
 *   IndexedDB object store — IndexedDB stores typed arrays natively).
 */
export interface OptimysticWebDB extends DBSchema {
	metadata: {
		key: BlockId;
		value: BlockMetadata;
	};
	revisions: {
		key: [BlockId, number];
		value: ActionId;
	};
	pending: {
		key: [BlockId, ActionId];
		value: Transform;
	};
	transactions: {
		key: [BlockId, ActionId];
		value: Transform;
	};
	materialized: {
		key: [BlockId, ActionId];
		value: IBlock;
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
