import { openDB, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb';
import type { ActionId, BlockId, PieceId } from '@optimystic/db-core';
import type { JournalRecord } from '@optimystic/db-p2p';
import { createLogger } from './logger.js';

const log = createLogger('db');

/**
 * The key of the applied-through mark in the `journal` store. A string, where every record's key
 * is a number: IndexedDB orders numbers before strings, so a key range over the numbers never
 * reaches the mark.
 */
export const JOURNAL_MARK_KEY = 'applied-through';

/**
 * IndexedDB schema for the Optimystic browser storage backend.
 *
 * The seven block-storage stores keep their original object stores and compound
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
 * - `commitProofs`: `BlockCommitProof` bytes keyed by the proof's `messageHash` string, one
 *   per consensus message however many blocks it covers.
 * - `materialized`: materialized block bytes keyed by `[blockId, actionId]`. Deleting
 *   the row is an entry of a write group with no value, not a stored `undefined`.
 * - `journal`: the write groups appended and not yet applied to the seven stores above, each a
 *   `JournalRecord` stored by structured clone under its `seq` (no codec: the record's keys are
 *   plain objects and its values `Uint8Array`s), and under {@link JOURNAL_MARK_KEY} the number of
 *   the last record applied. `IndexedDBJournalStore` owns both; nothing else touches the store.
 * - `kv`: a generic string keyspace shared by `IndexedDBKVStore` and the
 *   identity helper. Identity keys are stored as raw `Uint8Array` blobs (under
 *   a separate logical store from string-only `IKVStore` data, but the same
 *   IndexedDB object store — IndexedDB stores typed arrays natively).
 * - `pieces`: blob piece bytes keyed by the piece's id string, stored by structured clone. Written
 *   and read only by `IndexedDBPieceStore`, one transaction per piece, never by the journal.
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
	commitProofs: {
		key: string;
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
	pieces: {
		key: PieceId;
		value: Uint8Array;
	};
}

export const DEFAULT_DB_NAME = 'optimystic';
// Bumped to 2 when the `proofs` object store was added, to 3 for `journal`, to 4 for
// `commitProofs`, and to 5 for `pieces`. The `upgrade` hook creates only the stores an existing
// database lacks, so a database any earlier version wrote gains the rest empty and keeps every
// record (`test/db.spec.ts` opens a version 1 database and reopens it here). A database at this
// version cannot be opened by a build asking for an older one: the browser refuses the open with a
// `VersionError`.
export const DEFAULT_DB_VERSION = 5;

/**
 * Every object store in the current schema, in the order the stores appear in
 * {@link OptimysticWebDB}. A version bump appends to this and raises {@link DEFAULT_DB_VERSION}.
 *
 * The `satisfies` clause is what keeps the list and the schema interface from drifting: a name not
 * in {@link OptimysticWebDB} is a type error. (`StoreNames` rather than `keyof`, which `DBSchema`'s
 * index signature would widen to `string | number`.)
 *
 * NOTE: the upgrade loop only ever creates. A store dropped from the schema would linger in an
 * existing database with its rows, since nothing deletes it; revisit if a store is ever dropped —
 * the right handling depends on whether its data needs migrating first.
 */
export const OBJECT_STORES = [
	'metadata', 'revisions', 'pending', 'transactions', 'proofs',
	'commitProofs', 'materialized', 'journal', 'kv', 'pieces',
] as const satisfies readonly StoreNames<OptimysticWebDB>[];

export type OptimysticWebDBHandle = IDBPDatabase<OptimysticWebDB>;

/**
 * Callbacks for the connection-lifecycle events IndexedDB raises outside a normal open. Each is
 * also logged whether or not it is supplied; supplying one is how a host takes action.
 *
 * None of these closes the handle. The handle's stores (`IndexedDBRawStorage`, `IndexedDBKVStore`)
 * buffer writes and hold armed timers, and this function does not own them — the host constructs
 * them afterwards and owns the close order — so closing from here would lose writes the host could
 * have flushed first. The recommended host handler is in the package README.
 */
export interface OptimysticWebDbLifecycle {
	/**
	 * An older connection on this origin is holding up this open, so it is waiting rather than
	 * resolving. (`idb`'s `blocked`.) Diagnosis only: the other tab is the one that can yield.
	 */
	onUpgradeBlocked?(currentVersion: number, requestedVersion: number | null): void;
	/**
	 * This connection is what is holding up another tab's open at a newer version. (`idb`'s
	 * `blocking`.) The recommended handler flushes and closes, then prompts a reload — see the
	 * package README.
	 */
	onBlockingUpgrade?(currentVersion: number, requestedVersion: number | null): void;
	/**
	 * The browser closed this connection abnormally — eviction, or site data cleared. (`idb`'s
	 * `terminated`; not called for `db.close()`.)
	 */
	onConnectionLost?(): void;
}

/**
 * Hands one lifecycle event to the host. Host callbacks run as DOM event listeners, where a throw
 * becomes an uncaught top-level error the open can never report, so the throw is logged against
 * the event it came from instead of escaping unattributed.
 */
function notifyHost(event: string, call: () => void): void {
	try {
		call();
	} catch (error) {
		log('%s handler threw %o', event, error);
	}
}

/**
 * Opens (and creates if necessary) the Optimystic IndexedDB database used by
 * `IndexedDBRawStorage`, `IndexedDBKVStore`, `IndexedDBPieceStore` and `loadOrCreateBrowserPeerKey`.
 *
 * The same handle can be safely shared across all four — IndexedDB connections
 * support concurrent transactions across disjoint object stores.
 *
 * With no `lifecycle` callbacks the behaviour is the browser's default: an open an older connection
 * blocks waits for that connection to close, and the older connection keeps it. The events are
 * logged either way.
 */
export async function openOptimysticWebDb(
	name: string = DEFAULT_DB_NAME,
	version: number = DEFAULT_DB_VERSION,
	lifecycle: OptimysticWebDbLifecycle = {},
): Promise<OptimysticWebDBHandle> {
	return openDB<OptimysticWebDB>(name, version, {
		upgrade(db) {
			for (const store of OBJECT_STORES) {
				if (!db.objectStoreNames.contains(store)) {
					db.createObjectStore(store);
				}
			}
		},
		blocked(currentVersion, blockedVersion) {
			log('upgrade-blocked db=%s current=%d requested=%o', name, currentVersion, blockedVersion);
			if (lifecycle.onUpgradeBlocked) {
				notifyHost('upgrade-blocked', () => lifecycle.onUpgradeBlocked!(currentVersion, blockedVersion));
			}
		},
		blocking(currentVersion, blockedVersion) {
			log('blocking-upgrade db=%s current=%d requested=%o', name, currentVersion, blockedVersion);
			if (lifecycle.onBlockingUpgrade) {
				notifyHost('blocking-upgrade', () => lifecycle.onBlockingUpgrade!(currentVersion, blockedVersion));
			}
		},
		terminated() {
			log('connection-lost db=%s', name);
			if (lifecycle.onConnectionLost) {
				notifyHost('connection-lost', () => lifecycle.onConnectionLost!());
			}
		},
	});
}
