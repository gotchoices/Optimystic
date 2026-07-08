description: A transaction's per-collection commit steps used to run one after another; they now run together, and if any one fails all successful ones are cleanly undone.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (pendPhase, pendCollection, commitPhase, commitCollection, cancelPhase)
  - packages/db-core/src/transactor/network-transactor.ts (get:retry loop ~lines 143-178)
  - packages/db-core/test/coordinator.spec.ts (new)
difficulty: medium
----

# Review: parallelize independent per-collection phases and per-batch retries

## What this ticket did

Three spots that did independent work strictly serially now fan out concurrently,
with a **cancel-all-on-failure** policy (previously: cancel-only-those-before-the-
failure, which is a natural consequence of serial iteration). No change to
success/failure *outcomes* — only to latency and to the breadth of the cancel sweep.

### 1. `TransactionCoordinator.pendPhase` (coordinator.ts)

Was: a `for` loop `await`ing `transactor.pend` one collection at a time; on failure,
cancelled only the collections pended *before* the failing one.

Now:
- Extracted a per-collection helper `pendCollection(...)` that resolves to
  `{ collectionId, blockIds }` on success and **throws** the per-collection reason
  on failure.
- `pendPhase` runs them all under `Promise.allSettled`, then partitions the settled
  results into `pendedBlockIds` (every collection that DID pend) + the first failure
  reason.
- On *any* failure it calls `cancelPhase(actionId, pendedBlockIds)` — cancelling
  **every** successfully-pended collection, since with concurrency several may have
  pended in parallel.
- Return contract unchanged: `{ success, error?, pendedBlockIds? }`, `pendedBlockIds`
  keyed by collectionId. The "Collection not found" guard is preserved as a
  per-collection throw.

### 2. `TransactionCoordinator.commitPhase` (coordinator.ts)

Was: a `for` loop, each collection running the inner 3-attempt commit retry serially;
returned on the first collection that ultimately failed.

Now:
- Extracted `commitCollection(...)` that keeps the 3-attempt retry and **always
  resolves** with `{ collectionId, committed, error? }` (success carried in the flag,
  not by throwing).
- `commitPhase` fans them out under `Promise.allSettled` and aggregates
  `committedCollections` / `failedCollections`. If any collection ultimately fails it
  returns `success:false` with the partitioned sets, so the existing targeted cancel in
  `coordinateTransaction` (`cancelPhase(..., commitResult.committedCollections)`) still
  cancels only the not-yet-committed collections. Return shape is unchanged.

### 3. `cancelPhase` (coordinator.ts)

Now fans out its per-collection cancels under `Promise.all`, and each cancel is
`.catch`-wrapped: a cancel fault is logged and swallowed so (a) one failed cancel does
not abort the others, and (b) a cancel failure can never mask the pend/commit failure
that triggered the sweep. `excludeCollections` semantics preserved. `pendPhase` reuses
this method for its cancel-all sweep (single cancel path, no ad-hoc duplicate).

### 4. `NetworkTransactor.get()` second-chance retry (network-transactor.ts)

Was: a `for` loop `await`ing each retryable batch's `findCoordinator` + `processBatches`
one after another; an early throw aborted the remaining retryable batches.

Now: the per-batch retry body runs under `Promise.allSettled` over `retryable`. Each
batch builds its own excluded-peer set and attaches its own `subsumedBy`, so the rounds
are independent per root batch and safe concurrently. First-error-wins preserved: the
outer `error` (from the main `processBatches`) is kept if present; otherwise the first
rejection across the concurrent retries is adopted. Removed a dead `excludedByRoot` map
that was populated but never read.

## Behavioral notes the reviewer should confirm

- **Broadened cancel sweep (intended).** On pend failure, the set of cancelled
  collections is now "all that pended" rather than "those before the failure." This is
  the explicit goal, not a regression — but confirm it matches the 2PC intent
  (pre-decision cancel of everything provisionally pended).
- **get:retry now processes ALL retryable batches even if an early one throws.**
  Previously the serial loop abandoned later batches on the first throw. Concurrent
  execution processes them all, which is strictly *more* thorough recovery; the final
  `missingIds` aggregate-error check still guards completeness. Worth a second look that
  no caller depended on the early-abort.
- **No shared mutable state in the fanned-out bodies (verified).** `getNextRev()` is a
  pure read (`(source.actionContext?.rev ?? 0) + 1`) on each collection's own `source`;
  tracker reset / `recordCommitted` happen *after* the phases in `commit()`/`execute()`,
  not inside pend/commit. Different collections are different objects, so their
  concurrent `getNextRev()` reads do not race. Re-verify if a future change moves any
  tracker write into pend/commit.

## Tests

New `packages/db-core/test/coordinator.spec.ts` drives the private phase methods directly
with an `InstrumentedTransactor` that records peak concurrent in-flight pend/commit calls
and which collections pended/committed/cancelled:

- pendPhase: **N=4 collections pend concurrently** (asserts `pendMaxInFlight === 4`);
  **a mid-fan-out failure cancels all 3 successful pends** (set comparison, order-agnostic);
  a missing collection surfaces as a failure (no throw) and still cancels the sibling.
- commitPhase: N=4 commit concurrently (`commitMaxInFlight === 4`); partition of
  committed vs failed with the failing collection retried exactly 3 times.
- cancelPhase: excludes the already-committed set; swallows a cancel fault and still
  cancels the rest.

The existing `transaction.spec.ts` suites that exercise these phases through the public
`execute()`/`commit()` path (Partial Failure Recovery TEST-2.2.2, 2PC Protocol Edge Cases
TEST-10.2.1, Coordinator Timeout Handling TEST-2.2.1) all still pass, and the network
retry-accounting suite in `network-transactor.spec.ts` still passes.

### Validation run

- `yarn build` (tsc) — clean.
- Full `yarn test` for db-core — **1151 passing, 0 failing** (~8s).

## Known gaps / where to push

- The concurrency assertion is `maxInFlight === N` on a mock whose pend/commit `await`s a
  small `setTimeout`. This proves the fan-out is not serial (serial would give
  `maxInFlight === 1`), but it does not stress *ordering* under partial completion. A
  reviewer wanting more could add an interleaving test where some pends resolve before
  others start failing, asserting the cancel set is still exactly the succeeded set.
- Tests drive the **private** phase methods via `as unknown as {...}` casts. That is
  deliberate (isolates the phase logic from network/Tree setup) but couples the test to
  method names; the public-path coverage in `transaction.spec.ts` is the backstop.
- The get:retry parallelization has **no dedicated concurrency test** — it is covered
  only by the existing functional retry-accounting suite (which still passes). If the
  reviewer wants a concurrency assertion there too, it would need a counting key-network
  + repo that records overlapping retry round-trips, analogous to the coordinator mock.

## Review findings

- **Tripwire (parked as code comment):** the pend/commit fan-outs are *unbounded* — one
  concurrent coordinator round-trip per collection (was 1 serial). Fine now because
  transactions touch few collections; if one ever spans very many, peak in-flight
  round-trips could spike. Parked as a `NOTE:` at the `pendPhase` fan-out in
  `coordinator.ts` (mentions `commitPhase` shares the concern). Not filed as a ticket —
  purely conditional.
- **Behavioral broadening to confirm (see "Behavioral notes"):** cancel-all-on-failure
  breadth in pendPhase, and get:retry now processing all retryable batches even after an
  early throw. Both intended; flagged here so the reviewer verifies no caller relied on
  the old narrower behavior.
