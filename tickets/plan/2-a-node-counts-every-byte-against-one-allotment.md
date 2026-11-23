description: An operator who gives a storage node a fixed amount of disk has no way to tell the node so, and the node does not add up everything it stores — blob files and its own bookkeeping are counted only by accident, against a made-up 10 GB total. Give a node one storage allotment and have every kind of stored data count against it.
architecture: packages/db-p2p/docs/storage.md, docs/blobs.md#lifetime, docs/arachnode-ring-handoff.md
files: packages/db-p2p/src/storage/storage-monitor.ts (`StorageMonitor`, `StorageMonitorConfig`, `blockStoreCountsPieces`), packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/blob/cache-budget.ts (`BlobCacheBudget`), packages/db-p2p/src/libp2p-node-base.ts (`arachnode.storage`, `blobs.cacheBudgetBytes`), the four storage packages' block, key-value and piece stores
difficulty: hard
prereq: each-storage-package-opens-a-whole-nodes-storage
----

# A node counts every byte against one allotment

## Why

A machine that serves a group stores four kinds of data: block revisions and their commit proofs, blob pieces, the key-value store's records (blob records, the owed-blob and under-replication ledgers), and coordinator transaction state. An operator who sets a machine up with, say, 50 GB for the network needs every one of them to count against that 50 GB and to be managed within it. Today:

- **The only total is a guess.** `arachnode.storage.totalBytes` (`StorageMonitorConfig`) defaults to 10 GB and is never compared with the disk. Its one consumer is ring selection (`RingSelector`).
- **"Used" is block bytes plus piece bytes**, the piece figure left out when the two stores report one identity. What else is counted depends on each backend's measure: the file store sizes its whole directory, SQLite its whole database file, IndexedDB the whole browser origin, LevelDB its entries plus pieces. So the key-value store and transaction state count only when they happen to share the block store's location.
- **Blobs read from other machines have a budget of their own**, `blobs.cacheBudgetBytes` (default 256 MiB, `BlobCacheBudget`), unrelated to any node total. Blobs kept for the network have none.

## What to build

- **One allotment per node**, configured on the node (the operator's figure in bytes). It replaces `arachnode.storage.totalBytes`. The effective total is the smaller of the allotment and what the disk can actually give: bytes used now plus free space, as the bundle's backend reports it. With no allotment the disk's figure is the total. A backend that cannot report free space (state which ones, after checking) uses the allotment, and with neither, says so in a start-up line rather than inventing 10 GB.
- **Every store of the bundle reports its own bytes**, and the node sums them, counting each physical location once by store identity. The sum includes the key-value store and the transaction-state store. Where a backend's only cheap measure covers its whole location, keep it as the location's figure and do not add the parts again.
- **One accounting surface on the node** that reports the total, the effective allotment, and the bytes per kind: blocks, blob pieces by why they are held (pinned, owed, responsible, cached), and bookkeeping. It is what ring selection reads, what the cached-blob budget reads, what an operator's dashboard reads, and what the next ticket acts on. Say what it costs to compute and how often; today's used-bytes scan is memoized for 60 s (`usedBytesCacheTtlMs`) because a full scan is expensive.
- **Cached blobs come out of the allotment.** The cache may use what the allotment leaves after everything else, capped by `cacheBudgetBytes` when the host sets one. Decide the default share in the plan and say why.
- **Docs:** packages/db-p2p/docs/storage.md gets a section on the allotment and what counts; docs/blobs.md §Lifetime and the arachnode ring docs say what they now read.

Note on the transaction-state store (2026-11-23, from the planning that produced the `a-node-takes-all-its-storage-as-one-value` chain): the prereq chain resolves the node's storage into **three** stores a host opens — block store, key-value store, piece store (`NodeStorage` in db-p2p) — and keeps the node's transaction state inside the key-value store rather than in a fourth store of its own. So "the sum includes the key-value store and the transaction-state store" is one figure here, not two, and `IKVStore` is the interface this ticket has to give a byte measure to (it has none today, where `IPieceStore` has `bytesUsed` and `IRawStorage` has `getApproximateBytesUsed`).

## Expected behaviour

- An operator sets one figure and can read back, at any time, how much of it each kind of data is using.
- Two stores in one location are never counted twice, and nothing the node stores is left out.
- No behaviour changes yet when the node is over its allotment, except that ring selection and the cache budget read the true figure. Acting on it is `3-a-node-stays-within-its-allotment`.
