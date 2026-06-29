description: Make the transaction-reversal path use the same per-block lock as normal commits, so a reversal and a write to the same block can't clobber each other's record of which version is current.
prereq:
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/invalidation.spec.ts
difficulty: medium
----

# Invalidation apply must hold the per-block commit latch

## Problem (confirmed)

Two code paths do a read-modify-write of a block's `meta.latest`/`meta.ranges`, but under
**disjoint** named latches, so they are not mutually exclusive on the same block:

| Path | RMW of `meta.latest` runs under |
| --- | --- |
| `StorageRepo.commit` → `internalCommit` | `StorageRepo.commit:<blockId>` (storage-repo.ts:338) |
| `BlockStorage.saveReplica` / `saveDeletion` | `BlockStorage.saveReplica:<blockId>` (block-storage.ts:134, 183) |
| `StorageRepo.saveReplicatedBlock` (churn re-replication) | **wraps** `saveReplica` in `StorageRepo.commit:<blockId>` (storage-repo.ts:469) — on purpose |
| `applyInvalidation` (restore + delete branches) | **nothing** — calls `saveReplica`/`saveDeletion` directly (invalidation.ts:559, 568) |

The churn path proves the project already knows out-of-band writers of `latest` must serialize
against `commit` on the outer `StorageRepo.commit:<blockId>` latch. The invalidation apply path is
the one writer that does **not**, so it can interleave with a concurrent commit on the same block.

### Why this corrupts `latest`

`internalCommit.setLatest({actionId, rev})` is **unconditional** — it has no monotonic guard of its
own. The staleness guard that protects it lives in `StorageRepo.commit`'s partition step
(storage-repo.ts:359-383), which reads `getLatest()` **while holding `StorageRepo.commit:<id>`** and
rejects the commit as stale if `latest.rev >= request.rev`. An invalidation that advances `latest`
**outside that latch** is invisible to this guard, so the commit can clobber it:

```
block X at rev 4
  commit(rev 5)  ── acquires StorageRepo.commit:X
                    partition check: getLatest() → rev 4  (< 5, proceed)
                    … awaits …
  applyInvalidation(rev 6)  ── acquires BlockStorage.saveReplica:X  (DIFFERENT latch — not blocked)
                              saveReplica/saveDeletion: latest 4 < 6 → setLatest(rev 6)
  commit resumes ── internalCommit.setLatest(rev 5)   ← clobbers rev 6 back to rev 5
```

Result: `meta.latest` regresses (non-monotonic), and the `rev → actionId` index + `ranges` can be
left inconsistent. Because different members interleave differently, they diverge on which revision
is current. This is the lost-update / non-monotonic-`latest` the source ticket flagged.

## Production reachability — what is and isn't live today

Be honest about scope: the invalidation-**apply** path is currently **dormant in the live node**.

- `onInvalidate` is **not** passed to `clusterMember(...)` in the composition root
  (libp2p-node-base.ts:581-601), so `ClusterMember.applyConsensusInvalidation` logs
  `consensus-invalidate-no-sink` and returns without applying.
- `cascadeInvalidate` (cascade.ts:252) — the only production caller of `applyInvalidation` — has no
  production driver wired either.

So the race **cannot manifest on a live node right now**. It is a **latent** correctness bug that
becomes live the instant the sink / cascade driver is wired (the documented plan). Fix the invariant
now so it is already sound when activation lands; do not wait for the race to become observable.

### The existing cluster-level mitigation is partial (do not rely on it)

`ClusterMember.getAffectedBlockIds` surfaces `invalidate.blockIds` into conflict detection
(cluster-repo.ts:1210-1214). This is **best-effort, not mutual exclusion**:
- it runs only in the **promise** phase, against this member's in-memory `activeTransactions`, which
  is cleared after consensus and stale-swept after 2 s (cluster-repo.ts:1104);
- per-member views diverge, so enough members can promise both a commit and an invalidation on the
  same block for both to reach consensus;
- it only declares the **root** `invalidate.blockIds`. Cascade-discovered read-dependent blocks are
  found dynamically inside the apply and are **never** in the cluster message, so a commit racing a
  **cascade-child** reversal has zero cluster-level protection.

The per-block storage latch is the correct and complete fix; the cluster check stays as a useful
first-line race resolver.

## Fix — thread the commit latch into the apply path

Make `applyInvalidation` wrap each block's `saveReplica`/`saveDeletion` RMW in the same
`StorageRepo.commit:<blockId>` latch `commit` and `saveReplicatedBlock` use. `applyInvalidation`
lives in the dispute module and holds only an `IBlockStorage`, so the capability is injected.

### Recommended seam: inject a latch-runner through the context (chosen)

Keeps the dispute module storage-agnostic and mirrors how it already receives capabilities
(`createBlockStorage`, `log`). Single source of truth for the latch key so it cannot drift from the
two existing call sites.

```ts
// storage-repo.ts — export ONE source of truth for the key, use it in commit() (line 338) and
// saveReplicatedBlock() (line 469) instead of the inline template literal.
export const commitLatchKey = (blockId: BlockId) => `StorageRepo.commit:${blockId}`;

// invalidation.ts — InvalidationContext gains:
/**
 * Runs `fn` while holding the same per-block commit latch StorageRepo.commit /
 * saveReplicatedBlock hold, so the compensating saveReplica/saveDeletion RMW of meta.latest is
 * mutually exclusive with a concurrent local commit on that block. Optional: when omitted (unit
 * tests / non-StorageRepo hosts) the write runs unlatched, preserving today's behavior.
 */
readonly withBlockCommitLatch?: <T>(blockId: BlockId, fn: () => Promise<T>) => Promise<T>;

// invalidation.ts — in applyInvalidation's per-block loop, wrap ONLY the write:
const runLatched = <T>(fn: () => Promise<T>) =>
    ctx.withBlockCommitLatch ? ctx.withBlockCommitLatch(blockId, fn) : fn();
// delete branch:  await runLatched(() => storage.saveDeletion({ rev, actionId: revertActionId }));
// restore branch: await runLatched(() => storage.saveReplica(computation.block, { rev, actionId: revertActionId }));

// composition-root impl (supplied where onInvalidate / the cascade env is wired):
withBlockCommitLatch: async (blockId, fn) => {
    const release = await Latches.acquire(commitLatchKey(blockId));
    try { return await fn(); } finally { release(); }
}
```

Thread `withBlockCommitLatch` through cascade's `CollectionEnv` (cascade.ts:39-43) and into the
`{ log, createBlockStorage }` context it builds for `applyInvalidation` (cascade.ts:350) so cascade
children are latched too.

**Latch scope:** hold the latch only around the single `saveReplica`/`saveDeletion` call — *not*
around `computeRevertedBlock` (which already ran in the earlier `Promise.all`). That matches
`saveReplicatedBlock`'s scope and is sufficient: the monotonic guard inside
`saveReplica`/`saveDeletion` runs under the latch and reconciles against any commit that advanced
`latest` in between.

**Deadlock-free:** acquire per-block, one at a time, inside the loop (acquire → write → release).
`commit` grabs all of a batch's block latches up front in sorted order, but invalidation holds at
most one block latch at any instant, so it can never hold A while waiting for B — no cycle.

### Alternatives considered (document, don't implement unless the chosen seam proves noisy)

- **Acquire `Latches.acquire(commitLatchKey(blockId))` directly inside `applyInvalidation`.** No
  plumbing, but couples the dispute module to a storage-layer latch-naming detail and to the global
  `Latches`. Acceptable lighter fallback — if taken, still import `commitLatchKey` from storage-repo
  so the key can't drift.
- **Teach `saveReplica`/`saveDeletion` to acquire the outer latch themselves.** REJECTED:
  `saveReplicatedBlock` already wraps `saveReplica` in `StorageRepo.commit:<id>`; making `saveReplica`
  also acquire that key would double-acquire it. `Latches` are non-reentrant (latches.ts: a second
  acquire on the same key awaits a release that never comes within the same async flow) →
  self-deadlock.

## Out of scope (note, do not expand)

The compute→write window: `computeRevertedBlock` reads block history *before* the latch is taken, so
a commit landing between compute and the latched write changes "surviving later actions". The
consensus-assigned `rev` + the monotonic guard bound the `meta.latest` corruption this ticket targets;
cross-member *content* determinism under concurrent commits is governed by consensus ordering, not one
member's wall-clock, and is a separate concern. Flag if you see a concrete divergence, but do not
broaden this ticket to chase it.

## TODO

- [ ] In `storage-repo.ts`, export `commitLatchKey(blockId)` and use it in `commit()` (line 338) and
      `saveReplicatedBlock()` (line 469) in place of the inline `` `StorageRepo.commit:${...}` `` literals.
- [ ] Add optional `withBlockCommitLatch` to `InvalidationContext` (invalidation.ts:456-461) with the
      doc comment above.
- [ ] In `applyInvalidation`'s per-block loop (invalidation.ts:551-570), wrap the `saveDeletion`
      (delete branch) and `saveReplica` (restore branch) calls in `runLatched` as shown. Latch scope =
      the write call only; acquire/release per block inside the loop.
- [ ] Thread `withBlockCommitLatch` through cascade's `CollectionEnv` (cascade.ts:39-43) and into the
      context object passed to `applyInvalidation` (cascade.ts:350).
- [ ] Supply the `withBlockCommitLatch` implementation (using `Latches.acquire(commitLatchKey(blockId))`)
      at the composition seam — wherever the `onInvalidate` sink / cascade env is constructed. If that
      seam is not yet wired in libp2p-node-base.ts, add the helper alongside `createBlockStorage` so it
      is ready when the sink/cascade is activated, and note it in the review handoff.
- [ ] Regression test in `packages/db-p2p/test/invalidation.spec.ts`:
      - Build a `StorageRepo` + `BlockStorage` over `MemoryRawStorage` (helpers already imported in the
        spec). Seed block X at rev 4.
      - Deterministic contention check: externally `Latches.acquire(commitLatchKey(X))`, then start
        `applyInvalidation` with `withBlockCommitLatch` supplied and assert its write does **not**
        complete until the external latch is released (proves it now contends on the commit latch).
      - Lost-update check: with a `MemoryRawStorage` whose `saveMetadata`/`getMetadata` can pause at a
        barrier, interleave a `commit(rev 5)` and an `applyInvalidation(rev 6)` per the trace above.
        WITHOUT `withBlockCommitLatch` → final `meta.latest` regresses / `rev→actionId` inconsistent
        (documents the bug). WITH it → the two serialize, `commit`'s partition check sees rev 6, the
        stale commit is rejected, and `meta.latest` stays monotonic.
- [ ] Run `yarn workspace @optimystic/db-p2p test` (stream with `2>&1 | tee`) and the type check; make
      sure the existing invalidation/cascade/cluster-invalidation specs still pass.
