----
description: A phone running twenty workspaces would otherwise keep twenty separate memory caches, each sized as if it were the only one, and a single bulk scan through one of them could throw away everything the others need. Give them one shared pool with a memory budget and an admission rule that protects frequently used records from one-off bulk reads.
prereq: coherent-raw-storage-cache
files: packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/docs/storage.md, packages/db-core/src/utility/
difficulty: hard
----

# Bound the raw-storage cache: one shared pool, byte budget, 2Q admission

## Why this is a separate ticket

`coherent-raw-storage-cache` (prereq) builds the cache and deliberately leaves it unbounded, because
its target workload — one control-database start over ~21 blocks — never needs eviction. That is
the easy case, and it is real: for a single store the working set is small enough that bounding is
irrelevant and any eviction policy is unreachable code.

The hard cases are what this ticket is for, and they change the answer.

## The two hard cases

**Many stores per process.** Consumers wire one store per node *and* one per workspace. In the
Sereus consumer a phone with 20 strands holds ~21 storage instances (control plus one per strand;
its `RawStorageProvider` is `IRawStorage | ((strandId) => IRawStorage)`). Twenty-one independent
caches, each sized as though it were the only one, is exactly the wrong shape on the device least
able to afford it.

**Streaming workloads that pollute.** Full scans stream blocks that will never be re-read: index
backfill (`packages/quereus-plugin-optimystic/src/optimystic-module.ts:2149`), consumer-side strand
backfill, restoration and reconcile sweeps, storage-monitor walks. Under a plain shared LRU, one
workspace's one-off sweep evicts another store's hot set — including the control database's ~21
blocks, which must stay resident for the next operation. This is the textbook case for admission
control, and it only appears once the pool is shared.

## What to build

**One pool per process, keyed `(storeId, entry class, key…)`.** Each wrapper registers with a unique
`storeId`. Keying by block id alone is unsafe: header block ids are **name-derived**, not content
hashes (`docs/architecture.md:67`), so two workspaces on the same schema produce identical header
block ids in different stores. Aliasing them would serve one store's data to another — a data
integrity bug, not a performance bug.

**Budget in bytes, with an entry count as a secondary rail.** Materialized blocks and transforms
dominate and vary in size; metadata, pending sets and revision maps are small but numerous. A byte
budget covers both honestly; an entry cap guards the pathological many-tiny-entries case.

> **Where the cache actually lives (corrected after the prereq landed).** This ticket originally
> assumed the prereq would hook the `KvRawStorage` kernel. It did not: `CachedStoreDriver`
> (`packages/db-p2p/src/storage/cached-store-driver.ts`) sits one layer *below*, wrapping any
> `RawStoreDriver`, and caches the encoded bytes the driver speaks. Byte sizes are therefore still
> free — the cached value *is* a `Uint8Array` — but the pool must be plumbed into the driver
> wrapper, not the kernel. `CachedRawStorage` is the same cache reached through an adapter for
> backends that only expose `IRawStorage`; both need the shared pool.

**Negative and empty entries count too.** `CachedStoreDriver.state()` allocates a per-block state
object for *every* block id touched, including ids that do not exist — proven-absent negatives are
cached deliberately, and `StorageRepo.get` is reachable from a remote peer with an arbitrary block-id
list. So a remote probe stream grows the cache with entries holding no data at all. The budget must
charge for negatives and for the bare per-block bookkeeping, or the entry cap is the only thing
standing between a peer and unbounded growth.

**Large values bypass admission.** A value above roughly 1/16 of the budget is read or written
through without being cached, so one oversized block cannot flush the pool.

**At the bound: always evict. Never refuse, never grow unbounded.** The cache is clean, so eviction
is always safe and there is no exhaustion condition to raise. Note that lamina's 2Q raises a
`BufferExhausted` error at its ceiling — that exists because its slots can be pinned and dirty.
Ours can be neither. Do not port that.

**2Q admission, and only the part that transfers.** From the reference implementation in the sibling
workspace `c:/projects/lamina` (`packages/lamina-substrate/src/buffer/twoq.ts`, Johnson & Shasha):
the A1in probation FIFO at ~25% of capacity, the A1out ghost key set at ~50% of entry budget,
ghost-demotion on A1in eviction only, no intra-A1in promotion on re-hit, and Am as the protected
LRU. That is roughly 150 transferable lines out of ~800. **Do not port** the pins, per-generation
dirty tracking and flush, copy-on-write generation ancestry, CRC verification, decoded-view slots,
or the exhaustion throw — all page-buffer machinery with no analogue in a clean value cache. Note
that repo is a *reference to read*, not a dependency to add.

Skip the correlated-reference (`VisitId`) refinement initially. Its analogue here is real — one
logical `get()` touches a block three or four times and should not count as reuse — but it is
second-order, and the write-path re-reads that matter most re-touch across *distinct* operations,
which is exactly the reuse signal `Am` should reward. Say in the handoff whether measurement
changed that judgement.

The intended asymmetry, worth confirming by measurement: hot metadata and set entries are
re-referenced almost immediately and clear probation fast, while streamed materialized blocks are
touched once and die in A1in without ever displacing `Am`.

Check `packages/db-core/src/utility/` before writing new containers — an `LruMap` already exists and
is used at `packages/db-p2p/src/repo/coordinator-repo.ts:195`. Reuse or extend rather than adding a
third map implementation.

## Edge cases & interactions

- **Store lifecycle.** A workspace closing must release its entries; a `storeId` must not be reused
  by a later store without a purge. Leaking a departed store's entries is a slow memory leak on a
  long-lived provider node — the exact deployment this ticket exists for.
- **Completeness flags survive eviction correctly.** The prereq keeps each list's completeness flag
  inside the entry it describes. Verify that still holds under real eviction, and that a
  half-populated set can never be read as complete.
- **The promote coupling** touches three entry classes atomically. Under eviction, any of the three
  may be absent. Confirm the prereq's "invalidate rather than synthesize" rule holds for every
  combination of present and evicted.
- **Budget configuration.** Host-set, with an honest default per platform (order 8 MB on React
  Native, 16-32 MB on desktop and provider hosts). Decide where it is configured and what happens
  when a host sets something absurd.
- **Fairness between stores is deliberately not enforced** — hot stores should occupy more of the
  pool. But confirm a single pathological store cannot starve every other one indefinitely, and say
  what you checked.
- **Observability.** Hit rate, evictions, bytes resident, and per-store occupancy should be
  inspectable. Without them, nobody can tell a badly sized pool from a slow disk — which is exactly
  the confusion the originating downstream report suffered from.
- **Concurrency.** Several stores mutate the pool at once. Eviction must not run mid-promote across
  the three coupled entries.

## How to confirm

Two measurements, both reported:

1. **The pollution case** — run a bulk scan over store A while store B's hot set is resident, and
   show B's hot entries survive. Under a plain LRU they will not; that contrast is the evidence 2Q
   earns its complexity here, and if the contrast does not appear, **say so and drop the admission
   layer for a plain LRU.** A negative result is a good outcome and should not be argued away.
2. **No regression on the easy case** — the control-start operation count from the prereq ticket
   must be unchanged with the pool in place at a sane budget. The bound must not cost the workload
   the cache was built for.
