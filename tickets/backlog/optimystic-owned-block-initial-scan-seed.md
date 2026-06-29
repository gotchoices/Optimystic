description: When a node restarts, the resilience components that re-replicate and re-home data don't know about the blocks already saved on disk from before the restart until each one happens to be touched again; seed them at startup by scanning what's already stored.
prereq:
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/libp2p-node-base.ts
----

# Seed the owned-block tracked set from already-durable storage at startup

## Problem

The owned-block tracked set that drives the churn-spread and rebalance resilience monitors is fed
only by `storageRepo.onAnyCollectionChange`, which fires on **new** commits and received replicas.
Blocks that were already durable on disk from a previous run are therefore **not tracked until they
are next touched** — so immediately after a restart a node under-protects exactly the data it
already holds. This gap was documented as acceptable by `optimystic-spread-on-churn-monitor-wiring`
and again deferred by `optimystic-rebalance-monitor-wiring-shared-tracked-set` /
`unify-monitor-tracked-block-set`, because the monitors re-derive coverage over time.

## Why it's a separate ticket

There is currently **no way to enumerate stored block IDs**. `IRawStorage`
(`packages/db-p2p/src/storage/i-raw-storage.ts`) is entirely block-id-keyed — every method takes a
`blockId` — with no "list all block ids" operation. Seeding the tracked set therefore requires:

- adding an enumeration method (e.g. `listBlockIds(): AsyncIterable<BlockId>`) to `IRawStorage`,
- implementing it in every backend (`MemoryRawStorage` and any persistent backend),
- exposing it through `StorageRepo` so `createLibp2pNodeBase` can iterate durable blocks at startup
  and call `trackBlock` for each before/just after the monitors start.

That is a cross-cutting storage-interface change, distinct from the monitor wiring/unification work,
and only worthwhile once a persistent (non-memory) raw-storage backend is actually in use (for
`MemoryRawStorage` there is nothing durable across a process restart, so the seed is a no-op).

## Expected behavior

On startup, after the owned-block set and monitors are wired, the node enumerates the block IDs
already present in durable storage and adds them to the shared tracked set, so churn-spread and
rebalance protection covers pre-existing blocks without waiting for them to be touched. The scan
must be bounded/streamed so a large store does not block startup.

## Use case

A node restarts holding thousands of durable blocks. It should resume protecting them immediately,
not only as each is incidentally re-read or re-committed.
