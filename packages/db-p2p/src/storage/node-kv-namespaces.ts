import { UNDER_REPLICATED_KEY_PREFIX } from "../repo/kv-under-replication-ledger.js";
import { COORDINATOR_STATE_KEY_PREFIX, EXECUTED_KEY_PREFIX, PARTICIPANT_STATE_KEY_PREFIX } from "../cluster/persistent-transaction-state-store.js";

/**
 * The first key segment of every namespace the node writes to its `IKVStore`. A file-backed KV
 * store sharing a base path with block storage puts each of these at the root beside the block
 * directories, so a block listing walking that root skips them (see `FileBatchBackend.listBlockIds`
 * in `@optimystic/db-p2p-storage-fs`).
 */
export const NODE_KV_NAMESPACES: readonly string[] = [
	UNDER_REPLICATED_KEY_PREFIX,
	COORDINATOR_STATE_KEY_PREFIX,
	PARTICIPANT_STATE_KEY_PREFIX,
	EXECUTED_KEY_PREFIX,
].map(prefix => prefix.replace(/\/$/, ''));
