description: A block used to keep a full copy of itself at every saved version, so disk grew forever; now it keeps full copies only at periodic checkpoints (plus the newest version and the oldest one it holds) and rebuilds the in-between versions on demand from the small change-logs, which are never dropped.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/test/block-storage.spec.ts, docs/repository.md
difficulty: hard
----

# Review: materialization checkpoint sweep

## What was built

Storage no longer keeps a full materialized block copy at every revision. It retains a full copy only at
**retained** revisions and prunes the redundant intermediate copies incrementally, as new commits land.
Every forward transform (the delta/replay-log) is still kept for every revision, so any held revision is
reconstructible by replaying transforms from the nearest retained copy at or below it. This drops storage
growth from O(revisions × block size) to O(revisions × delta size).

### Retention predicate (`BlockStorage.isRetainedRev`)

A materialization at rev `r` is retained iff **any** of:
- `r === meta.latest.rev` (the tip),
- `r === rangeFloor` (start of the contiguous `meta.ranges` span containing the rev — nothing below it to
  replay from), or
- `r % checkpointInterval === 0` (periodic checkpoint; default interval **32**).

Otherwise the copy is prunable. Floor retention is a **separate mandatory clause** — absolute `r % K`
checkpoints don't land on the floor `E` (e.g. `E=1, K=32`).

### Where it happens

- `BlockStorage` gained an optional 4th constructor arg `checkpointInterval` (default 32) so tests inject a
  small cadence. Module const `CHECKPOINT_INTERVAL = 32`.
- New `pruneSupersededMaterialization(prior: ActionRev)` on `IBlockStorage` / `BlockStorage`: reads `meta`,
  computes the floor of the span containing `meta.latest.rev`, and deletes `prior`'s materialization
  (`saveMaterializedBlock(actionId, undefined)` → driver `deleteMaterialized`) unless `prior.rev` is
  retained. No-op on a tombstone rev (nothing to delete).
- `StorageRepo.internalCommit` calls it **last** — after `setLatest` — passing the prior `latest`, only when
  `latest !== undefined`. Runs under the per-block commit latch already held, so it serializes against
  concurrent commits with no new lock.
- `materializeBlock`'s previously-unused `_meta` param is now `meta`; the read-path result cache is gated on
  `isRetainedRev`, so a cold read at a non-checkpoint historical rev no longer re-adds a materialization the
  sweep just removed (storage would otherwise regrow via reads). A `NOTE:` tripwire marks the cache site.
- `docs/repository.md`: the aspirational "Archival based on resource pressure" bullet was replaced with the
  concrete checkpoint-materialization model.

### `meta.ranges` invariant (honesty)

Because every transform is kept and a copy survives at each floor + checkpoint, every rev in a claimed range
stays locally reconstructible, so sweeping requires **no** change to `meta.ranges`. A test asserts `ranges`
is byte-identical before vs after sweeping a long chain. (Pruning *transforms* of cold ranges is explicitly
out of scope — see backlog `feat-cold-range-transform-offload`.)

## Validation done

- `yarn workspace @optimystic/db-p2p build` — clean (tsc, source type-checks).
- Full `yarn workspace @optimystic/db-p2p test` — **1304 passing, 36 pending, 0 failing**.
- New `describe('BlockStorage checkpoint materialization sweep')` (6 tests, all passing):
  1. Commit `K+5` revs (injected `K=4`): materializations only at `{floor=1, 4, 8, tip=9}`; transforms at all
     1..9; `getBlock(r)` content correct (`items.length === r-1`) for every `r`.
  2. `meta.ranges` byte-identical before vs after sweeping a long chain (open-ended `[[1]]` preserved).
  3. Mid-history delete (tombstone via the commit funnel) then re-create + more commits: tombstone rev reads
     back absent, the rev before it present, tombstone carries no materialization.
  4. Multi-range restore-seeded block: lower range floor (rev 2) survives commits to the upper range; upper
     range floor (rev 10, a **non-checkpoint** floor) also retained.
  5. Repeated cold historical read of a swept rev does not grow the materialized store.
  6. Crash-before-prune (prune suppressed via subclass): block stays fully reconstructible; prune resumes and
     reclaims its immediate prior on the next commit.

## Known gaps / where to look hard (treat tests as a floor)

- **Crash-before-prune leak — ticket claim is optimistic.** The ticket says a materialization left un-pruned
  by a crash between `setLatest` and the prune "is reclaimed by the next commit". It is **not**. Each commit
  prunes only its *immediate prior*; a later commit prunes *its own* prior, never the earlier leaked rev. So a
  crash in that tiny window permanently leaks **one** redundant block-copy. This is **harmless** — state stays
  consistent and every rev stays reconstructible — and bounded (≤1 copy per crash event). Recorded as a
  `NOTE:` tripwire at the prune call site (`storage-repo.ts`), with the remedy if it ever matters (bounded
  look-back window, or a periodic reconciliation sweep — *not* a per-read re-cache). Test 6 asserts the real
  guarantee (reconstructibility + prune resumes), and its final assertion documents that revs 2 & 3 remain
  leaked. **Reviewer: decide whether the bounded leak is acceptable or wants a follow-up `debt-` ticket.**
- **`rangeFloorOf` fallback** returns `rev` itself when no span contains it (documented unreachable, since
  `setLatest` always merges the containing span before a prune/read). If a caller ever violates that
  invariant, the fallback treats `rev` as its own floor (retain) — safe direction, but worth a skeptical look.
- **Checkpoint reads re-replay up to `checkpointInterval` transforms.** Default 32 → worst-case 32 forward
  `applyTransform`s per cold historical read. Fine for rare historical reads; the read-cache tripwire notes
  the escalation path (cache at nearest checkpoint below target) if cold reads ever go hot.
- **`checkpointInterval` is per-`BlockStorage`-instance, not persisted.** Two instances over the same raw
  store with different intervals would retain/prune to different cadences. In production all instances come
  from one factory (`libp2p-node-base.ts` uses the default 32), so this is only a test-shaped concern — but a
  reader mixing intervals on one store (as the sweep tests deliberately avoid) could see surprising counts.
- **Reads with a mismatched interval can re-cache at that reader's checkpoints.** The read-path gate uses the
  reader instance's `checkpointInterval`; a reader with a *smaller* interval than the writer could cache extra
  copies. Not reachable in production (single factory), but verify no code path constructs `BlockStorage` for
  the same block with divergent intervals.
- **Delete-then-recreate pend needs an explicit `rev`.** The re-create in test 3 had to pass `rev` to `pend`
  or the insert-conflict guard reported the block stale (a prior tombstone latest exists). Not a sweep bug,
  but confirms the commit funnel's expected shape for post-tombstone inserts.

## Suggested review focus

- Confirm the floor computation is correct for the multi-range case (prune must never target a rev below the
  latest range's floor). Trace `rangeFloorOf(meta.latest.rev, ranges)` on `[[2,3],[10]]`.
- Confirm `getBlock(r)` never throws `Failed to find materialized block` for any held `r` post-sweep (test 1
  covers `[E, latest]`; check the reasoning holds for sparse/gapped commits too).
- Decide the disposition of the crash-before-prune leak (accept as tripwire vs. file `debt-` follow-up).
