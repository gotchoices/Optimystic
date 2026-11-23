description: A node keeps its data in four separate stores that the host has to build and pass one by one, and any it forgets silently ends up in memory and is lost on restart. Let a host set up all of a node's storage in one call per platform, so nothing can be left out by accident.
architecture: docs/internals.md#client-nodes, docs/blobs.md#the-local-store, packages/db-p2p/docs/storage.md
files: packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.storage`, `kvStore`, `pieceStorage`, `transactionStateStore`; `resolveStorage`, `resolveKvStore`, `resolvePieceStore`), packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p-storage-{fs,ns,web,rn}/src/index.ts, packages/quereus-plugin-optimystic/src/types.ts and src/optimystic-adapter/collection-factory.ts (`rawStorageFactory`, `blobStorageFactory`), tickets/backlog/debt-a-networks-storage-is-taken-from-one-collections-options.md
difficulty: medium
----

# A node keeps all its data in one storage setup

## Why

Sereus built its strand nodes with a persistent block store and nothing else (sereus#67). Blob pieces then went to a `MemoryPieceStore` and blob records to a `MemoryKVStore`, so a photo put just before the phone went to the background was gone when the strand woke. Nothing failed; a warning went to a log nobody reads on a phone. The Quereus plugin made the same mistake once internally (backlog `debt-a-networks-storage-is-taken-from-one-collections-options`).

The cause is the shape of the options, not one host's oversight. Today a node takes four independent options, each defaulting to memory or to nothing:

| Option | When absent |
|---|---|
| `NodeOptions.storage` | `MemoryRawStorage`, with only a start-up durability line saying `'none'` |
| `NodeOptions.kvStore` | `MemoryKVStore`, with a `node-wiring` warning. This store holds blob records, the owed-blob ledger, the under-replication ledger and the HLC high-water mark |
| `NodeOptions.pieceStorage` | `MemoryPieceStore`, with a warning |
| `NodeOptions.transactionStateStore` | nothing: coordinator transaction state is never saved and never recovered. `PersistentTransactionStateStore` exists and could be built over the key-value store, but nothing builds it |

Each storage package already builds its stores to share one location (`FileRawStorage`, `FileKVStore` and `FilePieceStore` on one base path; the SQLite, IndexedDB and LevelDB stores on one database handle), but a host has to know that and make every call itself.

## What to build

- **One bundle type, defined in `db-p2p`:** everything a node persists, as one value — block store, key-value store, piece store and transaction-state store. `db-p2p` cannot depend on the storage packages (they depend on it), so the type lives in `db-p2p` and the platform factories live in the storage packages.
- **One factory per storage package** that builds the whole bundle on one location: a base path for files, a database handle for SQLite, IndexedDB and LevelDB. Its stores report one store identity, so capacity is counted once (see `StorageMonitor` and `blockStoreCountsPieces` in `packages/db-p2p/src/storage/storage-monitor.ts`). The transaction-state store is built over the bundle's key-value store, so a coordinator's in-flight transactions are recovered after a restart on every platform.
- **A memory bundle**, exported from `db-p2p`, for tests, demos and hosts that genuinely want nothing kept.
- **`NodeOptions` takes the bundle** in place of the four separate fields. Backwards compatibility is not a concern in this repository yet, so replace rather than add beside. A node given no bundle uses the memory bundle and logs ONE warning at start that names every store it is keeping in memory. A host that passes the memory bundle explicitly gets no warning.
- **Client nodes** (`servesBlocks: false`) keep what they keep today — the key-value store and the piece store, no block store — from the same bundle. Say in the type or the docs which parts a client uses.
- **The Quereus plugin takes one storage factory per network**, returning the bundle, in place of `rawStorageFactory` and `blobStorageFactory`. Consider whether this is the moment to take on backlog `debt-a-networks-storage-is-taken-from-one-collections-options`, since its proposed `NetworkOptions` is where that factory would live; if it is, fold it in, and if not, say why in the plan.
- **Docs:** `packages/db-p2p/docs/storage.md`, the storage section of each storage package's readme, docs/blobs.md §The local store and the host requirement it states, and the plugin README.

## Expected behaviour

- A host on any of the four platforms sets up a node's storage with one call and one location, and every store a node keeps survives a restart.
- Leaving storage out is visible at start, in one line that names what will be lost.
- The upgrade-check suite still reads every released fixture: the bundle changes how stores are handed to a node, not what they write. If a store's layout must change, that is an upgrade step to document, not an accident.
