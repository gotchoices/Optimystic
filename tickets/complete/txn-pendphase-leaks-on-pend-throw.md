description: Regression test ensuring a thrown transactor.pend failure still triggers cleanup of already-pended sibling collections.
files:
  - packages/db-core/test/coordinator.spec.ts (InstrumentedTransactor + pendPhase describe block, ~lines 53-200)
  - packages/db-core/src/transaction/coordinator.ts (pendPhase / pendCollection, lines 688-774 — read-only, verified correct)
----

## What was done (implement stage)

Added one regression test plus a small `InstrumentedTransactor` extension in
`packages/db-core/test/coordinator.spec.ts`:

- **`InstrumentedTransactor`** gained an optional third constructor param
  `throwCollections: Set<string>`. In `pend()`, a matching collection id now
  `throw`s instead of returning `{ success: false }`. The existing
  `failCollections` (returned-failure) path is untouched — both failure shapes
  coexist.
- **New test** `'cancels every successfully-pended collection when transactor.pend
  throws for one collection'`: 4 collections, `c2` throws; asserts
  `result.success === false`, `result.error` contains `c2`, and the three sibling
  `-tail` block ids are cancelled.

## Review findings

**Checked**

- **Implement diff, fresh eyes** — read `git show 4d11e06` before the handoff.
- **Does the test exercise the real path?** Verified against
  `coordinator.ts:688-774`. A thrown `transactor.pend` propagates directly out of
  `pendCollection` (line 768, no try/catch), settles as a rejected outcome in the
  `Promise.allSettled` fan-out (line 706), sets `failure` (line 720), and triggers
  `cancelPhase` over every fulfilled sibling (line 729). The throwing collection
  never reaches `pendedCollections`, so it is correctly absent from the cancel set.
  The test is a genuine guard, not a tautology — a future rewrite to a serial loop
  with try/catch only on the returned-failure branch would let the throw escape and
  fail this test.
- **Distinct from the returned-failure test?** At the `pendPhase` level both
  failure shapes converge to a rejected settled outcome, so the observable result
  is identical. The added value is coverage of the throw path *inside the
  transactor* — the exact regression vector (peers unreachable → `pend` throws) the
  fix ticket flagged. Confirmed worth keeping.
- **Lint / tests** — ran `coordinator.spec.ts` via mocha: **8 passing**, 0 failing,
  including the new test.
- **Cleanup / cancel semantics** — the failed collection is never double-cancelled
  (`cancelPhase` sweeps only fulfilled collections); the tx-9 double-cancel concern
  the fix ticket raised does not apply here.

**Found + fixed (minor, inline)**

- The new test's comment read *"The three collections that pended before the throw
  must all be cancelled."* — misleading: the pends fan out concurrently, so
  settle-before-throw ordering is non-deterministic (the sibling returned-failure
  test at lines 173-175 frames this correctly). Rewrote the comment to state that
  every collection that *did* pend is cancelled and that the comparison is a set
  because ordering is not deterministic. Comment-only; no behavior change,
  re-run not required.

**Major / tickets filed** — none. Implementation was already correct (fixed
incidentally by the `txn-perf-parallel-phases` refactor); this ticket was
test-coverage only and its scope is met.

**Tripwires** — none newly recorded. The pre-existing unbounded-fan-out `NOTE` at
`coordinator.ts:703-705` (bound peak in-flight round-trips if a transaction ever
spans very many collections) already lives at its site; nothing in this change
affects it.

**Considered, deliberately not changed** — the three `pendPhase` failure tests
(returned-failure, throw, missing-collection) share near-identical boilerplate and
could be parameterized. Left as-is: the explicit mirroring is more readable than a
table-driven abstraction here, and DRYing test setup would obscure the three
distinct failure shapes each case is meant to document.

## Test run

`mocha test/coordinator.spec.ts` (@optimystic/db-core) — **8 passing**, 0 failing.
