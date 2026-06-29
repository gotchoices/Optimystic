description: Made the transaction-reversal code take the same per-block lock as normal writes, so a reversal and a write to the same block can no longer overwrite each other's record of which version is current.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/invalidation.spec.ts
----

# Invalidation apply now holds the per-block commit latch — COMPLETE

## Summary of the landed change

The invalidation-apply path (`applyInvalidation`) used to do a read-modify-write of a block's
`meta.latest` (via `saveReplica`/`saveDeletion`) under **no** outer latch, while normal commit
(`StorageRepo.commit` → `internalCommit.setLatest`) and churn re-replication
(`StorageRepo.saveReplicatedBlock`) both serialize that RMW on `StorageRepo.commit:<blockId>`. Because
`internalCommit.setLatest` is unconditional and the staleness guard protecting it runs *only while
holding that latch*, an invalidation advancing `latest` outside the latch was invisible to the guard and
could be clobbered back down — a lost-update / non-monotonic `meta.latest` regression.

The fix threads the **same** commit latch into the apply path, scoped to just the compensating write
(matching `saveReplicatedBlock`'s scope):

- **`storage-repo.ts`** — `commitLatchKey(blockId)` (single source of truth for the key, now used by
  `commit()` and `saveReplicatedBlock()` in place of inline literals) and `withBlockCommitLatch(blockId, fn)`
  (acquire → run → release in `finally`).
- **`invalidation.ts`** — `InvalidationContext` gained optional `withBlockCommitLatch`; a `runLatched`
  helper wraps **only** the `saveDeletion`/`saveReplica` write. No runner injected → unlatched (today's
  behavior, keeps unit tests / non-`StorageRepo` hosts working).
- **`cascade.ts`** — `CollectionEnv` gained the same optional field, forwarded into each cascade child's
  apply context.
- **`libp2p-node-base.ts`** — imported and bound `withBlockCommitLatch` as `blockCommitLatch`, ready to
  thread into the `onInvalidate` sink / cascade env the instant either is wired (currently `void`-marked).

The change is dormant on a live node today (no `onInvalidate` sink / cascade driver wired), so it fixes a
**latent** bug ahead of activation.

## Review findings

**Verdict: accepted as-is. No code changes made in review; no new tickets filed.** The implementation
matches the planned design exactly (the plan's chosen seam, latch scope, and deadlock argument), the
build is clean, lint passes (no-op script), and the full suite is green.

### What was checked

- **Build** — `cd packages/db-p2p && yarn build` (tsc): clean, no errors. `tsconfig.json` does **not**
  set `noUnusedLocals`, so the `void blockCommitLatch;` marker is speculative future-proofing, not
  required today.
- **Lint** — root `yarn lint` is `echo 'Lint not configured for all packages'` (no ESLint config exists);
  passes trivially. Flagged here so it is not mistaken for real coverage.
- **Tests** — full `db-p2p` suite: **1062 passing, 37 pending, 0 failing**. The new
  `applyInvalidation → per-block commit latch (lost-update guard)` block (3 tests) was run **3×** in
  isolation with **zero flakiness** (the contention test's `setTimeout(0)` micro-yields are gated on a
  deterministic `reachedWrite` flag, and the apply promise provably cannot resolve while the external
  latch is held — so the `applied === false` assertion cannot race). The
  `cohort-topic cold-start: parent unreachable` console line is a log emitted *inside* a passing
  negative-path test, not a failure (confirmed).
- **Key-drift (the silent re-open risk)** — confirmed all three latch holders resolve to the identical
  key via `commitLatchKey`: `commit()` (storage-repo.ts:366), `saveReplicatedBlock()` (storage-repo.ts:497),
  and `withBlockCommitLatch` (storage-repo.ts:36); the test imports the same `commitLatchKey`/`withBlockCommitLatch`.
- **Monotonic-guard premise** — verified `saveReplica`/`saveDeletion` (block-storage.ts:141, 190) carry
  monotonic guards but under the disjoint inner `BlockStorage.saveReplica:<id>` latch, while
  `internalCommit.setLatest` (storage-repo.ts:560) is unconditional with its guard in commit's partition
  step (storage-repo.ts:390) under the outer latch. Wrapping apply in the outer latch closes the race in
  **both** interleavings: apply-first → commit's partition sees `latest ≥ rev` and rejects as stale;
  commit-first → apply's monotonic guard no-ops or advances. Sound.
- **Deadlock argument** — apply acquires/releases per block inside the loop (holds ≤ 1 block latch at any
  instant); commit acquires a batch's latches sorted + up-front. No "hold A wait B while holding B wait A"
  cycle is possible. Confirmed.
- **Caller completeness** — `find_references(applyInvalidation)` shows the only production caller is
  `cascade.ts` (now threaded); the rest are the definition and tests. No missed production call site.
- **Cascade wiring** — `cascade.ts:357` forwards `env.withBlockCommitLatch` into the child apply context;
  type-correct, and existing cascade specs (which omit the field → `undefined` → unlatched) still pass.
- **Docs** — re-read every touched file's doc comments; they accurately describe the new reality
  (`commitLatchKey`, `withBlockCommitLatch`, the `InvalidationContext`/`CollectionEnv` fields, and the
  `saveReplicatedBlock` rationale). No stale docs found.

### Findings (minor — disposition recorded, no code change)

1. **Dormant `void blockCommitLatch;` binding in `libp2p-node-base.ts` (implementer asked for a ruling).**
   Kept. The implement ticket's TODO explicitly says: *"If that seam is not yet wired… add the helper
   alongside `createBlockStorage` so it is ready… and note it in the review handoff."* The binding does
   exactly that, is well-commented, and triggers no lint/type failure today (no `noUnusedLocals`). I
   considered replacing it with a comment-only pointer to the exported helper; decided against — the
   construction-site binding documents intent where the wiring will land and costs nothing. Reasonable
   either way; not worth churn.

2. **Cascade latch wiring is type-level only, not behaviorally tested.** Accepted. The behavioral coverage
   lives at the `applyInvalidation` seam (the 3 new tests prove the runner contends on the real latch and
   serializes against a real commit). The cascade path is dormant and merely forwards an optional field;
   adding a cascade-level concurrency test now would test the harness, not new production behavior. If/when
   the cascade driver is wired live, an integration test should cover a child write under a real latch.

3. **Test 2 (`WITHOUT the latch …`) intentionally asserts the bug.** Accepted as a characterization test;
   it is clearly labeled. Note for future maintainers: if unlatched apply is ever made independently
   monotonic, that test's `latest === 5` assertion documents *current* behavior, not a desired invariant,
   and would need updating.

### Out of scope (acknowledged, no ticket filed)

The **compute→write window** (`computeRevertedBlock` reads block history before the latch is taken, so a
commit landing between compute and the latched write changes "surviving later actions") is **not** a
regression introduced here — it is a cross-member *content*-determinism concern governed by consensus
ordering, not one member's wall clock, and is explicitly bounded out by both the plan and the handoff. A
single-node monotonic latch cannot address cross-member ordering, so a new ticket would be noise; it
remains an open architectural boundary tracked in the consensus-ordering discussion, not here. The
`meta.latest` corruption this ticket targets (the lost update) is fully closed by the consensus-assigned
`rev` + the monotonic guard now running under the shared latch.

### Pre-existing failures

None. The full suite was green before and after; `tickets/.pre-existing-error.md` was not written.

## How it was validated

```
cd packages/db-p2p && yarn build        # tsc, clean
cd packages/db-p2p && yarn test         # 1062 passing, 37 pending, 0 failing
# new latch tests run 3× in isolation — no flakiness
```
