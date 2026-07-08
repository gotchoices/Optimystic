description: A transaction's per-collection commit steps used to run one after another; they now run together, and if any one fails all successful ones are cleanly undone.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (pendPhase, pendCollection, commitPhase, commitCollection, cancelPhase)
  - packages/db-core/src/transactor/network-transactor.ts (get:retry loop ~lines 143-176)
  - packages/db-core/test/coordinator.spec.ts
difficulty: medium
----

# Complete: parallelize independent per-collection phases and per-batch retries

## What landed

Three spots that did independent per-collection / per-batch work strictly serially now
fan out concurrently, with a **cancel-all-on-failure** policy on the pend path
(previously: cancel-only-those-before-the-failure, a side effect of serial iteration).
Success/failure *outcomes* are unchanged — only latency and the breadth of the cancel
sweep change.

1. `TransactionCoordinator.pendPhase` — extracted `pendCollection(...)` (throws its
   per-collection reason on failure); `pendPhase` runs all under `Promise.allSettled`,
   partitions into pended set + first failure reason, and on any failure cancels **every**
   successfully-pended collection via `cancelPhase`. Return contract unchanged.
2. `TransactionCoordinator.commitPhase` — extracted `commitCollection(...)` (keeps the
   3-attempt retry, always *resolves* with `{collectionId, committed, error?}`); `commitPhase`
   fans out under `Promise.allSettled` and aggregates committed/failed. The existing targeted
   cancel in `coordinateTransaction` (excluding `committedCollections`) is unchanged.
3. `cancelPhase` — fans cancels out under `Promise.all`, each `.catch`-wrapped so a cancel
   fault is logged + swallowed (cannot mask the triggering pend/commit failure, cannot abort
   siblings). `excludeCollections` semantics preserved; `pendPhase` reuses this method.
4. `NetworkTransactor.get()` second-chance retry — per-batch retry body runs under
   `Promise.allSettled` over `retryable`; each root batch owns its excluded-peer set and its
   own `subsumedBy`. First-error-wins preserved (outer error kept if present, else first
   rejection in retryable order). Dead `excludedByRoot` map removed.

New `packages/db-core/test/coordinator.spec.ts` drives the private phase methods with an
`InstrumentedTransactor` that records peak concurrent in-flight pend/commit and which
collections pended/committed/cancelled (N=4 concurrent pend + commit; mid-fan-out failure
cancels all succeeded pends by set comparison; missing collection surfaces as failure, not
throw; commit partition with the failing collection retried exactly 3x; cancelPhase exclude +
fault-swallow).

## Review findings

**Method — I read the implement diff (fd169e6) first with fresh eyes, then the handoff.**
Scrutinized both source files for SPP/DRY/modularity, concurrency safety, error handling,
resource cleanup, and type safety; re-read every claim in the handoff against the code.

### Correctness — no defects found (verified, not assumed)

- **No shared mutable state across the fan-outs — confirmed at the source.** The handoff
  claims `getNextRev()` is a pure read; verified at `collection.ts:250-252`
  (`return (this.source.actionContext?.rev ?? 0) + 1`) — no mutation. The mutating sibling
  `recordCommitted` runs *after* the phases, not inside pend/commit. Different collections are
  different objects, so concurrent `getNextRev()` reads cannot race.
- **`get()` retry `subsumedBy` writes are per-root-batch.** Each `retryable` entry is a
  distinct `CoordinatorBatch`; `b.subsumedBy = [...]` appends to that object only. `retryable`
  is materialized (`Array.from(allBatches(...))`) *before* the fan-out, so appended retry
  batches are not re-entered mid-loop. Safe — this was already true serially.
- **First-error-wins is deterministic.** Both `pendPhase` (partition loop) and `get()` retry
  iterate the settled array in original order, so the adopted failure reason is stable, not
  timing-dependent.
- **cancel-all-on-failure computes the right set regardless of timing.** `pendedBlockIds` is
  built from all *fulfilled* outcomes; interleaving cannot change which collections pended, so
  the cancel set is exactly "all that pended" whether or not the interleaving test the handoff
  suggested is added.

### Error handling / resource cleanup — sound

- Best-effort cancel (`.catch` + `log`) correctly prevents a cancel fault from masking the
  original failure or aborting sibling cancels. Tradeoff: a *failed* cancel leaks a pended
  block (pre-existing to best-effort cancel; logged). Acceptable and documented.
- `commitCollection` always resolves; the defensive `errors.length > 0` branch in `commitPhase`
  handles a "can't-happen" rejection by treating the collection as failed. If such a rejection
  ever did occur, the collection lands in neither committed nor failed — but the downstream
  cancel excludes only `committedCollections`, so it *would* be cancelled. Safe-by-default; left
  as-is.

### Behavioral broadenings — intended, flagged for the record

- **pendPhase cancel breadth** widened from "collections before the failure" to "all pended".
  Matches 2PC pre-decision cancel intent. No caller inspects *which* subset was cancelled.
- **`get()` retry now processes all retryable batches even after an early throw** (serial
  abandoned later batches on first throw). Strictly more thorough recovery; the `missingIds`
  completeness check still guards the final result. No caller depended on the early-abort.

### Test coverage — adequate; one acknowledged gap left open (with reason)

- Verified lint (`eslint`, exit 0), `yarn build` (tsc, clean), and full db-core `yarn test`
  (**1151 passing, 0 failing, ~9s**).
- The `get()` retry parallelization has **no dedicated concurrency assertion** — it is covered
  functionally by the existing `get retry accounting` suite (`network-transactor.spec.ts`,
  multi-batch retry via `CountingKeyNetwork`), which passes. A peak-in-flight assertion there
  would need a repo mock recording overlapping round-trips (moderate effort) for marginal value
  over the passing functional coverage. **Deliberately not filed** as a ticket — the wiring is
  exercised end-to-end today.
- Phase tests reach private methods via `as unknown as {...}` casts. Deliberate (isolates phase
  logic from network/Tree setup); the public-path suites in `transaction.spec.ts` are the
  backstop. Left as-is.

### Tripwire (already parked, indexed here)

- **Unbounded fan-out** — one concurrent coordinator round-trip per collection (was 1 serial).
  Fine now (transactions touch few collections); a transaction spanning very many would spike
  peak in-flight round-trips. Already parked as a `NOTE:` at the `pendPhase` fan-out in
  `coordinator.ts` (the note also names `commitPhase`). Conditional-only — not a ticket.

**Disposition:** no minor fixes needed inline, no major issues to spin out. Implementation
verified sound as handed off.
