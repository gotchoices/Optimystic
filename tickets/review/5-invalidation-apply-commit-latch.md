description: Made the transaction-reversal code take the same per-block lock as normal writes, so a reversal and a write to the same block can no longer overwrite each other's record of which version is current.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/invalidation.spec.ts
----

# Invalidation apply now holds the per-block commit latch — review handoff

## What changed

The invalidation-apply path (`applyInvalidation`) did a read-modify-write of a block's `meta.latest`
via `saveReplica`/`saveDeletion` under **no** outer latch, while normal commit
(`StorageRepo.commit` → `internalCommit.setLatest`) and churn re-replication
(`StorageRepo.saveReplicatedBlock`) both serialize that RMW on `StorageRepo.commit:<blockId>`. Because
`internalCommit.setLatest` is unconditional and the staleness guard that protects it only runs *while
holding that latch*, an invalidation advancing `latest` outside the latch was invisible to the guard and
could be clobbered back down — a lost-update / non-monotonic `meta.latest` regression.

The fix threads the **same** commit latch into the apply path, scoped to just the compensating write
(matching `saveReplicatedBlock`). Four production edits + one test file:

- **`storage-repo.ts`** — exported a single source of truth for the key and a runner:
  - `commitLatchKey(blockId)` → `` `StorageRepo.commit:${blockId}` ``, now used by `commit()`
    (the per-batch lock loop) and `saveReplicatedBlock()` in place of the inline literals.
  - `withBlockCommitLatch(blockId, fn)` → `acquire(commitLatchKey) → fn → release` in `finally`.
- **`invalidation.ts`** — `InvalidationContext` gained optional
  `withBlockCommitLatch?: <T>(blockId, fn) => Promise<T>`. In `applyInvalidation`'s per-block loop a
  `runLatched` helper wraps **only** the `saveDeletion` (delete branch) and `saveReplica` (restore
  branch) calls; when no runner is injected the write runs unlatched (today's behavior — keeps the unit
  tests and non-`StorageRepo` hosts working).
- **`cascade.ts`** — `CollectionEnv` gained the same optional `withBlockCommitLatch`, threaded into the
  `applyInvalidation` context it builds for each cascade child, so cascade children latch too.
- **`libp2p-node-base.ts`** — imported `withBlockCommitLatch` and bound it as `blockCommitLatch`
  alongside the `storageRepo`/`createBlockStorage` construction, **ready** to thread into the
  `onInvalidate` sink and cascade `CollectionEnv` the instant either is wired. See the gap note below.

**Deadlock-free:** invalidation acquires per block, one at a time (acquire → write → release), so it
never holds two block latches; commit grabs a batch's latches up front in sorted order. Invalidation
can never hold A while waiting for B, so no cycle.

## How to validate

```
yarn workspace @optimystic/db-p2p build        # tsc, clean
cd packages/db-p2p && yarn test                # full suite: 1062 passing, 37 pending, 0 failing
```

(The `cohort-topic cold-start: parent unreachable` line in the output is a log emitted *inside* a
passing negative-path test, not a failure.)

## Tests added (in `test/invalidation.spec.ts`, nested under `applyInvalidation` →
`per-block commit latch (lost-update guard)`)

A module-scope `GatedRawStorage extends MemoryRawStorage` adds a `beforeSaveMetadata` barrier so a test
can park a commit precisely between its staleness check and its `setLatest` write.

1. **Contention check** — externally `Latches.acquire(commitLatchKey(X))`, then run `applyInvalidation`
   with a runner that wraps the real `withBlockCommitLatch`. Asserts the compensating write does **not**
   complete and `latest` stays put while the external latch is held, then completes and advances `latest`
   once released. Proves apply now contends on the commit latch. (Deterministic: a `reachedWrite` flag
   flips when apply reaches the latched write; while the external latch is held the apply promise can
   never resolve, so the `applied === false` assertion cannot race.)

2. **Lost-update WITHOUT the latch (characterization of the bug)** — parks `commit(rev 5)` just before
   its `setLatest`, runs an **unlatched** `applyInvalidation(rev 6)` in the window (disjoint
   `BlockStorage.saveReplica` latch → not blocked), releases the commit, and asserts `latest` **regresses
   6 → 5**. This intentionally asserts the broken behavior to pin the bug.

3. **Lost-update WITH the latch (the fix)** — a gated runner acquires the real commit latch, writes
   rev 6, and holds the latch open while `commit(rev 5)` is started; the commit must queue, and when it
   finally acquires the latch its staleness check sees `latest = 6 ≥ 5` (different action) → **rejected as
   stale**, `latest` stays monotonic at 6. Matches the ticket's trace exactly.

## Known gaps / honesty for the reviewer

- **The latch is dormant in the live node.** `onInvalidate` is still not passed to `clusterMember(...)`
  and `cascadeInvalidate` still has no production driver, so the invalidation-apply path does not execute
  on a live node yet (the ticket's "latent bug" framing). Therefore the new latch is exercised **only by
  the unit tests**, not by any production code path. The `blockCommitLatch` binding in
  `libp2p-node-base.ts` is intentionally unused-for-now (marked `void blockCommitLatch;` so it survives a
  future `noUnusedLocals` flip). **Reviewer judgment wanted:** is the `void`-marked readiness binding the
  right call, or would a comment-only pointer to the exported helper be cleaner? It is the literal "add
  the helper alongside `createBlockStorage` so it is ready" the ticket asked for.

- **Cascade threading is structurally wired but not behaviorally tested.** `cascade.ts` now forwards
  `env.withBlockCommitLatch` into each child's `applyInvalidation`, and the existing cascade specs still
  pass (they pass `CollectionEnv` without the field → `undefined` → unlatched, same as before). But there
  is **no cascade-level test that exercises a child write under a real latch**. The behavioral coverage is
  all at the `applyInvalidation` seam (tests above). Verifying the cascade wiring is type-level + "existing
  tests unaffected" only.

- **Test 2 asserts the bug on purpose.** It is a characterization test of *unlatched* apply. If a future
  change makes unlatched apply independently monotonic (e.g. a guard inside apply), this test's
  `latest === 5` assertion would need updating — it documents current behavior, not a desired invariant.

- **Out of scope (unchanged):** the compute→write window — `computeRevertedBlock` reads history before the
  latch is taken, so a commit landing between compute and the latched write changes "surviving later
  actions". The consensus-assigned `rev` + the monotonic guard bound the `meta.latest` corruption this
  ticket targets; cross-member *content* determinism under concurrent commits is governed by consensus
  ordering, not one member's wall clock. Not addressed here.

- **No new pre-existing failures.** Full suite was green before and after; `tickets/.pre-existing-error.md`
  was not written (nothing to flag).

## Suggested review focus

- Confirm the two existing latch holders (`commit`, `saveReplicatedBlock`) and the new apply runner all
  resolve to the **identical** key via `commitLatchKey` (drift here re-opens the race silently).
- Sanity-check the deadlock argument: apply holds ≤ 1 block latch at a time; commit's multi-latch
  acquisition is sorted + up-front. Multi-block invalidations acquire/release per block inside the loop.
- Scrutinize the contention test for flakiness (it is designed to be deterministic — see note above — but
  it does use `setTimeout(0)` micro-yields to drive the apply forward to the latch).
- Decide whether the dormant `blockCommitLatch` binding + cascade threading should be wired now or left
  ready (the ticket chose "ready").
