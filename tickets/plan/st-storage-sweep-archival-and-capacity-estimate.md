<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-08T16:15:48.105Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\st-storage-sweep-archival-and-capacity-estimate.plan.2026-07-08T16-15-48-105Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Storage never shrinks — every version of every block is kept forever, so disk use grows without bound, and the "how full am I" check scans the entire store each time it runs. Design a way to prune old versions and to answer the capacity question cheaply.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p/src/storage/ring-selector.ts, docs/repository.md
difficulty: hard
----

# No sweep/archival exists — storage grows without bound; capacity checks full-scan the store

Every commit persists **both** the full materialized block **and** the transform, and nothing
ever prunes either. Storage therefore grows O(revisions × block size) forever. `docs/repository.md`
promises archival "based on resource pressure," but that mechanism does not exist
(`storage-repo.ts:550`).

Compounding this, the capacity check `getApproximateBytesUsed` is a full-store scan on every
call: LevelDB iterates every key and value (`leveldb-storage.ts:122-140`); the fs adapter stats
the entire tree (`file-storage.ts:129-158`). `RingSelector` calls it repeatedly — twice within
`createArachnodeInfo` alone (`ring-selector.ts:95` area) — so the O(store) scan runs on a hot
path.

This is a design/refactor task (routed to plan), not a single localized bug. Two coupled
capabilities need designing:

1. **Checkpoint-cadence materialization sweeping.** Because the transform chain already supports
   replay, the store does not need every materialized revision — only periodic checkpoints plus
   the transforms between them. Design a sweep that prunes intermediate materializations (and/or
   old transforms) on a checkpoint cadence while keeping every revision reconstructible by
   replay. Must interoperate honestly with `meta.ranges` (a swept revision must not be claimed
   as locally present unless it is still reconstructible) and with the restoration path.

2. **Cheap capacity estimate.** Replace the full-store scan with either a cached estimate with a
   TTL, or an incrementally-maintained byte counter updated on write/delete, so `RingSelector`
   and other callers stop paying an O(store) cost per query.

## Edge cases & interactions

- **Reconstructibility invariant.** Pruning a materialized revision must never make a revision
  unrecoverable: either a checkpoint + transform chain covers it, or it is fetchable via
  restoration. Ties directly to `meta.ranges` honesty (see `st-pend-seeds-open-ended-ranges`)
  and gap detection (`st-commit-accepts-noncontiguous-revisions`) — a swept-but-claimed range is
  the same class of lie.
- **Concurrent sweep vs commit.** Sweeping runs while commits/promotions land on the same block;
  it must take the per-block commit latch (or otherwise serialize) so it does not delete a
  revision a concurrent commit depends on, and must not regress `meta.latest`/`meta.ranges`.
- **Crash mid-sweep.** A crash part-way through pruning must leave the block reconstructible —
  no state where both the materialization and the transforms needed to rebuild it are gone.
  Interacts with fs write atomicity (`st-filestorage-non-atomic-write-corruption`).
- **Per-adapter cost model.** LevelDB, fs, NativeScript SQLite, IndexedDB each have different
  scan/delete costs; the incremental-counter vs cached-TTL choice may differ per adapter or need
  a shared abstraction (interacts with the shared-KV-kernel design, `st-storage-shared-kv-kernel`).
- **Checkpoint cadence policy.** How often to checkpoint, and what "resource pressure" trigger
  drives sweeping — needs a defensible default (time-based, revision-count-based, or
  bytes-pressure-based) documented in `docs/repository.md` so doc and code agree.
- **Estimate staleness bounds.** A cached/TTL estimate can lag reality; define how stale it may
  be before `RingSelector` decisions are affected, and whether ring-selection needs a fresh read
  at decision boundaries.

Resolve the checkpoint policy and the estimate mechanism (cached-TTL vs incremental counter)
before emitting implement tickets; if either has no defensible default, route that decision to
`blocked/` rather than under-specifying the implementer.
