import { UNDER_REPLICATED_KEY_PREFIX } from "../repo/kv-under-replication-ledger.js";
import { COORDINATOR_STATE_KEY_PREFIX, EXECUTED_KEY_PREFIX, PARTICIPANT_STATE_KEY_PREFIX } from "../cluster/persistent-transaction-state-store.js";

/**
 * The prefix of every key the Quereus plugin's offline-sync journal writes (`OfflineJournal` in
 * `packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-journal.ts`). The plugin owns the
 * keys under it; it is declared here because a host may hand the node and the journal one store, and
 * this list is how such a store keeps block listings from walking the journal.
 */
export const OFFLINE_JOURNAL_KEY_PREFIX = 'optimystic-offline/';

/**
 * The first key segment of every namespace written to the node's `IKVStore` — by the node itself, and
 * by the Quereus plugin's offline journal when the host shares the store with it. A file-backed KV
 * store sharing a base path with block storage puts each of these at the root beside the block
 * directories, so a block listing walking that root skips them (see `FileBatchBackend.listBlockIds`
 * in `@optimystic/db-p2p-storage-fs`).
 */
export const NODE_KV_NAMESPACES: readonly string[] = [
	UNDER_REPLICATED_KEY_PREFIX,
	COORDINATOR_STATE_KEY_PREFIX,
	PARTICIPANT_STATE_KEY_PREFIX,
	EXECUTED_KEY_PREFIX,
	OFFLINE_JOURNAL_KEY_PREFIX,
].map(prefix => prefix.replace(/\/$/, ''));
