description: A cluster member used to permanently record an agreed transaction as "done" before actually doing the work, so a temporary error made it skip that transaction forever on retry; it now records "done" only after the work succeeds.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts
difficulty: medium
----

# Review: persistent "executed" marker now written only after apply succeeds

## What was wrong

In `handleConsensus` (`cluster/cluster-repo.ts`), a consensus-approved transaction was
recorded as executed in **two** places, both **before** its operations were applied:

- in-memory guard: `this.executedTransactions.set(messageHash, executedAt)`
- durable marker: `this.stateStore?.markExecuted(...)` (fire-and-forget)

The apply loop ran afterward. Its catch block rolled back **only** the in-memory marker
(`executedTransactions.delete`). The durable marker stayed. Because the state-store
interface has no `unmarkExecuted`, a redelivery of the same consensus record found the
durable marker (`wasTransactionExecutedAsync`) and short-circuited — silently dropping
the operation on that member forever.

Two apply-failure paths hit this: a transient thrown fault inside
`applyConsensusOperation` (e.g. storage I/O), and a propagated genuine commit fault
(`success:false` with a bare `reason`). A **process crash mid-apply** hit the same drop
with no catch block involved at all — the eager durable write had already been issued.

## What changed

Single-move fix, **no interface change**: the durable `markExecuted(...)` call was moved
from **before** the apply loop to **after** it completes without throwing
(`cluster-repo.ts:835-846`). The eager in-memory `set` (line 819) and the catch-block
`delete` (line 831) are unchanged — the in-memory guard is what provides the synchronous
check-and-set that prevents the concurrent apply-window race, and it must stay eager.

Why the post-apply ordering is safe (not just for the caught fault, but for the crash
window between "apply succeeded" and "durable write landed"): re-applying an
already-applied consensus transaction on restart is **idempotent by design** — the
"ahead" divergence path in `applyConsensusOperation` tolerates it as a no-op
(`StorageRepo.commit` returns `success:false` with `missing`, logged `divergence:'ahead'`;
a re-`pend` is logged and tolerated). So the window converges rather than dropping.

Stale placement comments were reworded to match: the `@pitfall` block on `handleConsensus`
and the inline comment above the in-memory `set`.

### Rejected alternative (documented in the original ticket)

Adding `unmarkExecuted(...)` to the interface + calling it in the catch. Rejected because
it does not close the crash-mid-apply window and grows the interface for a guarantee the
post-apply ordering gives for free.

## How to validate

Package: `packages/db-p2p`. Run: `yarn workspace @optimystic/db-p2p test` (min reporter;
use `test:verbose` for per-test names). Full suite result on this branch: **1127 passing,
36 pending, 0 failing**. Build/typecheck: `yarn workspace @optimystic/db-p2p build` (clean;
tsconfig includes `test/`, so the spec is type-checked too).

New tests live in `test/cluster-repo.spec.ts` under `describe('duplicate execution
prevention')`:

- **`does not persist the durable executed marker when apply throws, and redelivery
  re-runs the dropped operation`** — the core reproduction. Injects a shared
  `MemoryTransactionStateStore` and a new `ThrowOncePendRepo` (a `MockRepo` subclass whose
  `pend` throws a transient fault once, before recording the call). Drives a single-peer
  cluster to consensus so `applyConsensusOperation` throws; asserts `handleConsensus`
  rethrew, the in-memory guard rolled back, and `stateStore.wasExecuted(hash) === false`.
  Then redelivers the full consensus record against a fresh non-throwing repo sharing the
  same store (post-restart) and asserts the pend **re-runs** (`pendCalls.length === 1`) and
  the durable marker is now set.
- **`a second in-flight consensus delivery for the same hash does not double-apply`** —
  two concurrent `update(fullConsensusRecord)` calls; asserts exactly one apply
  (`pendCalls.length === 1`). Guards the concurrent apply-window race that the eager
  in-memory guard exists to close.

**Verified the repro genuinely catches the bug**: temporarily restoring the eager durable
write made the first new test fail with `expected true to equal false` (durable marker
stuck), then it passed again once the fix was restored.

## Known gaps / where to look hardest (tests are a floor, not a ceiling)

- **Coverage is single-peer only.** All new (and pre-existing) dedup tests drive a
  one-member cluster. The crash-mid-apply path and multi-operation transactions (a record
  with several `operations` where operation *k* throws after *k-1* applied) are argued safe
  by the idempotency reasoning above but are **not exercised by a test**. A reviewer wanting
  more confidence could add a multi-op record whose second op throws and assert the durable
  marker is absent + redelivery re-runs the whole record (relying on per-op idempotency for
  the already-applied first op).
- **The crash window is covered by *argument*, not by a test.** There is no test that
  kills the process (or aborts) between "apply succeeded" and "`markExecuted` resolves".
  The safety claim rests entirely on `applyConsensusOperation`'s "ahead" idempotency. If a
  reviewer doubts that idempotency holds for every operation kind (`get`, `cancel`, `pend`,
  `commit`, `invalidate`), that is the thing to pressure-test — the fix's correctness
  depends on it.
- **The genuine-commit-fault path** (`success:false` with a bare `reason`, the `throw new
  Error(...)` in the `commit` branch) reaches the same catch and is covered by the same
  reasoning, but the new tests trigger the fault via a thrown `pend`, not via that specific
  commit branch. Behaviorally identical at the catch, but not independently asserted.
- **`markExecuted` remains fire-and-forget.** A durable-store write failure after a
  successful apply is only logged; on restart such a transaction re-runs (idempotently).
  That is intentional and consistent with prior behavior — flagged so it is not mistaken
  for a regression.

## Review findings

- Tripwire noticed, no code parked: the fix's correctness depends on
  `applyConsensusOperation` staying idempotent for re-applied consensus ops. This is
  already documented in the method's own doc-comment ("ahead" divergence tolerated as a
  no-op) and now cross-referenced from the `markExecuted` comment in `handleConsensus`, so
  no new `NOTE:` was added — but if a future operation kind is added that is *not*
  idempotent on re-apply, this fix's crash-window safety regresses. Recorded here as the
  index entry; the reasoning lives at the `handleConsensus` durable-write comment
  (`cluster-repo.ts:835-846`).
