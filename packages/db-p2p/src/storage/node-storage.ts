import type { IRawStorage } from "./i-raw-storage.js";
import type { IKVStore } from "./i-kv-store.js";
import { MemoryRawStorage } from "./memory-storage.js";
import { MemoryKVStore } from "./memory-kv-store.js";
import type { IPieceStore } from "../blob/piece-store.js";
import { MemoryPieceStore } from "../blob/memory-piece-store.js";

/**
 * Every store a node persists to, as one value. A host opens all of it in one call per platform;
 * there is no part of it a host can leave out.
 *
 * A client node (`servesBlocks: false`) reads {@link NodeStorage.kv} and {@link NodeStorage.pieces}
 * and never touches {@link NodeStorage.blocks} — it stores no blocks for anyone
 * (docs/internals.md §Client nodes). `blocks` is required anyway so that one value serves either
 * role and a host that changes the role changes one flag; an unused block store over a location the
 * node already holds costs nothing, since every backend's constructor is lazy.
 *
 * NOTE: three stores and not four — the node builds its transaction-state store over `kv`
 * (`PersistentTransactionStateStore`), so there is one rule for it in one place on every platform
 * and no field for a factory to forget. If a backend ever wants its own (a SQLite table rather than
 * JSON under three key prefixes), add an optional fourth field whose ABSENCE keeps that derivation,
 * rather than making every platform supply one.
 */
export interface NodeStorage {
	/**
	 * Block revisions and their commit proofs. Read by a serving node only.
	 *
	 * The node puts the write-through read cache in front of this store (`withReadCache`, unless it
	 * is a `MemoryRawStorage` or already read-cached) under a lease, and releases THAT LEASE when it
	 * stops; the store you supplied is never disposed. The cache is shared per backing store: two
	 * concurrently running nodes handed one uncached instance — or two instances that report the same
	 * `getStoreIdentity()`, such as two `FileRawStorage` over one directory — read and write through
	 * ONE cache, which is cleared and unregistered only when the last of them stops. Sequential reuse
	 * (a restart over the same instance) starts cold once the previous node's lease has released.
	 * What remains unguarded is the cross-process case (Invariant 5 in
	 * `packages/db-p2p/docs/storage.md`). A host that attaches its own read cache and hands the
	 * result in keeps owning it; the node never releases it. Either documented cache construction is
	 * accepted here — `new CachedRawStorage(inner)` or `new KvRawStorage(new
	 * CachedStoreDriver(driver))`, the latter preferred when the backend's driver is reachable. Both
	 * report `IRawStorage.readCached`, which is what the seam checks.
	 */
	blocks: IRawStorage;
	/**
	 * Node-local records: the blob records, the owed-blob, under-replication and released-block ledgers, the clock's
	 * high-water mark, the node's transaction state. Each namespace's key prefix is declared in
	 * `NODE_KV_NAMESPACES` (`packages/db-p2p/src/storage/node-kv-namespaces.ts`), which is what keeps
	 * a file-backed store sharing the block store's directory from listing them as blocks.
	 */
	kv: IKVStore;
	/** Blob pieces (docs/blobs.md §The local store). */
	pieces: IPieceStore;
}

/**
 * A {@link NodeStorage} that was opened and must be closed; what every platform factory returns.
 * The node never calls `close` — it closes no store it was handed — so the host closes it after
 * `stop()`.
 */
export interface OpenNodeStorage extends NodeStorage {
	close(): Promise<void>;
}

/**
 * Storage that keeps nothing across a restart, for specs, demos and hosts that mean it. A fresh set
 * of stores per call — two nodes in one process must not share one memory store — and its `close`
 * does nothing.
 *
 * Passing this to `NodeOptions.storage` is how a host says the memory case was intended: the node
 * warns only when the option is absent, not when the stores it was handed happen to be in memory.
 */
export function memoryNodeStorage(): OpenNodeStorage {
	return {
		blocks: new MemoryRawStorage(),
		kv: new MemoryKVStore(),
		pieces: new MemoryPieceStore(),
		close: async () => { },
	};
}
