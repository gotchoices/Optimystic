description: Right now every saved version of a block keeps a full copy of the block, so disk use grows forever. Keep only periodic full copies plus the small change-logs between them, and drop the redundant in-between copies as new versions land — every version can still be rebuilt by replaying the change-logs.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/test/block-storage.spec.ts, docs/repository.md
difficulty: hard
----

# Materialization checkpoint sweep — stop keeping a full block copy per revision

## Background: how a block is stored and rebuilt today

Each block keeps four logical stores (see `i-raw-storage.ts`):

- **revisions**: `rev → actionId` (which action produced revision `rev`).
- **transactions**: `actionId → Transform` (the forward change that produced that rev). Small — a delta.
- **materialized**: `actionId → IBlock` (a full materialized copy of the block at that rev). Large — a whole block.
- **metadata**: `{ latest, ranges }` (the tip revision, and which revision ranges are locally reconstructible).

`BlockStorage.materializeBlock` (`block-storage.ts:284`) rebuilds a block at a target rev by walking the
revisions **descending** from the target until it finds the **nearest rev that has a materialized copy**,
then **replaying the forward transforms** from that copy up to the target. Crucially, **this already works
with sparse materializations** — it does not require every rev to have a materialized copy, only that *some*
materialized copy exists at or below the target within the same contiguous range, plus every forward
transform in between.

The waste is entirely in one place: `StorageRepo.internalCommit` (`storage-repo.ts:626`) calls
`saveMaterializedBlock(actionId, newBlock)` on **every** commit. So every rev gets a full block copy that is
almost always redundant — the materializer only ever needs periodic ones. Result: storage grows
O(revisions × block size). Transforms also grow (O(revisions × delta size)), but transforms are the replay
log and **cannot** be pruned without giving up local reconstructibility — that is deliberately out of scope
here (see the backlog `feat-cold-range-transform-offload`).

## What to build

Retain a full materialization only at **checkpoint** revisions; prune the redundant intermediate ones **as
new commits land** (incrementally, under the commit latch — no separate background pass, no multi-step
crash window). "Checkpoint cadence" is applied incrementally: each commit deletes the now-superseded prior
materialization unless that rev is one we must keep.

### Retention predicate

A materialization at rev `r` must be **retained** iff any of:

- `r === meta.latest.rev` — the tip is always materialized (it is the common read target and the replay
  base for the next commit).
- `r` is the **floor of its contiguous range** — the lowest rev of the `meta.ranges` span that contains
  `r`. The descending walk in `materializeBlock` has nothing below the floor to fall back to, so the floor
  **must** carry a materialization or a read anywhere in `[floor, nextCheckpoint)` throws
  `Failed to find materialized block`. (A normally-committed block has floor `E = 1`; a replica-seeded
  block has floor `= N` where `saveReplica` wrote its single materialization; a restored range carries at
  least one materialization from its archive.)
- `r % CHECKPOINT_INTERVAL === 0` — periodic checkpoint. `CHECKPOINT_INTERVAL` bounds the maximum replay
  depth for any read. Default **32**. Make it an **optional `BlockStorage` constructor argument** (default
  32) so tests can exercise sweeping without committing 32+ revs.

Otherwise `r`'s materialization is **prunable** (its transform stays, so `r` is still reconstructible by
replay from the nearest retained materialization below it).

Note absolute `r % K` checkpoints do **not** automatically land on the floor `E` (e.g. `E = 1`, `K = 32`),
which is exactly why floor retention is a **separate, mandatory** clause — do not drop it.

### Where the prune happens

Add to `IBlockStorage` / `BlockStorage`:

```ts
/**
 * Delete the materialized copy at `prior` if it is now redundant under the checkpoint
 * retention policy (not the tip, not its range floor, not a checkpoint rev). The forward
 * transform for `prior.rev` is retained, so the rev stays reconstructible by replay.
 * No-op if `prior.rev` must be retained or has no materialization (e.g. a tombstone rev).
 * Must be called under the per-block commit latch (serialized against concurrent commit).
 */
pruneSupersededMaterialization(prior: ActionRev): Promise<void>;
```

`StorageRepo.internalCommit` already reads the **prior** latest into `latest` (`storage-repo.ts:641`).
After `setLatest` succeeds, and only when `latest !== undefined`, call
`storage.pruneSupersededMaterialization(latest)`. Ordering is deliberate: the prune runs **last**, after the
new rev's materialization + revision + transform + `setLatest` are all durable. A crash *before* the prune
leaves a redundant (harmless) materialization that the next commit's prune reclaims; a crash *after* it is
fully consistent. The prune only ever deletes a materialization that is reconstructible from the retained
floor + transforms, so **no crash point can leave a rev unrecoverable.**

`pruneSupersededMaterialization` computes the floor by reading `meta`, finding the range span containing
`meta.latest.rev`, and taking its start. Deleting a materialization is `saveMaterializedBlock(actionId,
undefined)` (routes to the driver `deleteMaterialized`).

### Read path must not repopulate prunable materializations

`materializeBlock` currently caches its result unconditionally at `actions[0].actionId`
(`block-storage.ts:324`). Left as-is, a cold read at a non-checkpoint historical rev would re-add a
materialization that the sweep is designed to remove — storage regrows via reads. Gate the cache write on
the **same retention predicate**: persist the recomputed materialization only when `actions[0].rev` is a
checkpoint, the range floor, or `meta.latest.rev`; otherwise skip it. `materializeBlock` already receives
the block's `meta` (currently the unused `_meta` param — wire it up), so it has `latest` and `ranges` to
evaluate the predicate without an extra read.

Consequence: repeated reads of a cold non-checkpoint historical rev re-replay each time (bounded by
`CHECKPOINT_INTERVAL` transforms). Acceptable — historical reads are rare and replay is depth-bounded.
Record this as a `NOTE:` tripwire at the cache site: *if cold historical reads ever show as hot, cache at
the nearest checkpoint below the target instead of skipping.*

### `meta.ranges` is unchanged by sweeping

This is the honesty invariant that must hold: because **every transform is retained** and a materialization
survives at each range floor + checkpoints, **every rev in a claimed range stays locally reconstructible**.
So pruning materializations requires **no** change to `meta.ranges` — a swept rev is still honestly claimed
as present. A test must assert `ranges` is byte-identical before and after a sweep. (Contrast the deferred
`feat-cold-range-transform-offload`, which prunes *transforms* and therefore *must* fragment `ranges` and
lean on restoration — that is the "swept-but-claimed range is a lie" hazard, and it is exactly why transform
pruning is out of scope here.)

## Edge cases & interactions

- **Floor of each contiguous range retained.** Single open-ended `[E, +inf)` is the common case (floor `E`).
  A post-restore block can have multiple ranges; prune-on-commit only ever targets the prior latest, which
  is in the *latest* range, so it never prunes into a lower restored range's floor. Test a multi-range block
  and assert lower-range floor materializations survive.
- **`CHECKPOINT_INTERVAL` boundary.** Commit exactly `K`, `K+1`, `2K` revs; assert materializations exist at
  and only at `{floor, K, 2K, latest}`, transforms exist at every rev, and `getBlock(r)` returns correct
  content for *every* `r` in `[E, latest]` including swept ones.
- **Tip is always materialized.** A read at `latest` never hits the replay branch. After the next commit the
  old tip becomes prunable and is swept.
- **Tombstone / delete revs carry no materialization.** `internalCommit` skips `saveMaterializedBlock` when
  `newBlock` is undefined; `pruneSupersededMaterialization` on a tombstone prior is a no-op delete. Read-back
  at a mid-history tombstone rev must still resolve to absent (undefined), and the rev before it to present.
- **Replica floor.** `saveReplica` writes exactly one materialization at its rev and sets it as floor —
  retention must keep it. Commit forward past a replica and assert the replica rev stays materialized.
- **Crash between `setLatest` and prune.** Simulate by skipping the prune call; assert the block is fully
  reconstructible and a subsequent commit's prune reclaims the lingering materialization.
- **Concurrent commit vs prune.** Both run under the per-block commit latch (`internalCommit` is always
  called holding it), so they serialize — no separate concurrency mechanism is needed. Do not add an
  independent latch.
- **Read-path re-cache under the retention gate.** Repeatedly read a cold non-checkpoint historical rev;
  assert the store's materialization count does not grow.
- **`materializeBlock` never throws for a held rev post-sweep.** Regression guard: for a fully-swept block,
  `getBlock(r)` for every `r >= E` must succeed (never `Failed to find materialized block`).
- **Per-adapter delete cost.** The prune issues one `deleteMaterialized` per commit through the kernel; all
  backends already implement it. No per-adapter special-casing.

## Key tests (write these)

- Commit `K+5` revs (with a small injected `CHECKPOINT_INTERVAL`, e.g. 4). Assert: materialized store holds
  copies only at `{E, checkpoints, latest}`; transaction store holds all revs; `getBlock(r)` correct for
  every `r`.
- `ranges` deep-equal before vs after sweeping a long chain (open-ended `[E, +inf)` preserved).
- Mid-history delete then more commits: read-back absent at the tombstone rev, present at rev before it.
- Multi-range (restore-seeded) block: lower range floor materialization survives commits to the upper range.
- Repeated cold historical read does not grow the materialized store.
- Simulated crash-before-prune: still reconstructible; next commit reclaims.

## TODO

- Add `CHECKPOINT_INTERVAL` (default 32) and an optional `BlockStorage` constructor arg overriding it;
  export the retention predicate as a small private helper `isRetainedRev(rev, latestRev, rangeFloor)`.
- Add a `rangeFloorOf(latestRev, ranges)` helper (start of the contiguous `meta.ranges` span containing
  `latestRev`).
- Add `pruneSupersededMaterialization(prior: ActionRev)` to `IBlockStorage` and implement in `BlockStorage`.
- Call it from `StorageRepo.internalCommit` after `setLatest`, only when prior `latest` is defined.
- Wire `materializeBlock`'s `_meta` → `meta`; gate the cache write on `isRetainedRev`. Add the `NOTE:`
  tripwire at the cache site.
- Update `docs/repository.md`: replace the aspirational "Archival based on resource pressure" bullet with
  the concrete checkpoint-materialization model (keep every `K`th materialization + tip + range floor; prune
  intermediates on commit; all transforms retained so every held rev is locally reconstructible; `ranges`
  unchanged). Note cold-range transform offload is future work.
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log` (stream, don't silently
  redirect); ensure build + block-storage/storage-repo/storage-monitor specs pass.
