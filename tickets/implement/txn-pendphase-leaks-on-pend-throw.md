description: The bug where a partly-succeeded multi-part write left pieces locked when a step threw is already fixed in the code; add a regression test so a future rewrite can't quietly reintroduce the leak.
files:
  - packages/db-core/src/transaction/coordinator.ts (pendPhase / pendCollection / cancelPhase, ~lines 688-897)
  - packages/db-core/test/coordinator.spec.ts (InstrumentedTransactor + pendPhase describe block, ~lines 53-193)
difficulty: easy
----

# Regression test: a thrown pend failure must still cancel already-pended collections

## Background — the original bug is already fixed

The fix ticket reported that `pendPhase` leaked already-pended collections when
`NetworkTransactor.pend` *threw* (e.g. peers unreachable) rather than returning
`{ success: false }`, because cleanup ran only on the returned-failure path.

That premise no longer holds. Commit `fd169e6` (`txn-perf-parallel-phases`)
rewrote `pendPhase` from a serial per-collection `for` loop into a concurrent
`Promise.allSettled` fan-out. In the current code (`coordinator.ts:688-734`):

- Each collection is pended by `pendCollection`, which **throws** on any failure —
  both a missing collection and a returned `{ success: false }` (it converts the
  latter into `throw new Error(...)` at `coordinator.ts:769-771`).
- `Promise.allSettled` captures every settled result. Fulfilled ones populate
  `pendedBlockIds`; the first rejected one sets `failure`.
- If `failure !== undefined`, `cancelPhase(actionId, pendedBlockIds)` cancels
  **every** successfully-pended collection before returning `{ success: false }`.

So a thrown `transactor.pend` (peers unreachable) now settles as a rejected
outcome exactly like any other failure, and the same cancel-everything cleanup
runs. No pend survives a failed transaction. Bug resolved — incidentally, by a
perf refactor, with no test dedicated to the throw path.

## The gap

`test/coordinator.spec.ts` already tests two failure shapes:

- returned `{ success: false }` from `transactor.pend` (line 149) — siblings cancelled.
- a collection missing from the map, which throws inside `pendCollection` (line 173)
  — siblings cancelled.

But it never tests the ticket's actual scenario: **`transactor.pend` itself
throwing.** `InstrumentedTransactor.pend` (lines 72-87) only ever *returns*
`{ success: false }` on failure; it has no path that throws. That leaves the
exact regression the ticket warned about — a rewrite back to a serial loop with
try/catch-only-on-return — unguarded by tests.

## What to build

Add one test to the `pendPhase` describe block asserting that when
`transactor.pend` **throws** for one collection, `pendPhase` returns
`{ success: false }` and every other (successfully-pended) collection is
cancelled — the same guarantee the returned-failure test asserts.

Extend `InstrumentedTransactor` with a way to force a throw (not a returned
failure) for chosen collection ids — e.g. a second constructor set
`throwCollections` that, when it contains the pended collection id, does
`throw new Error(...)` instead of `return { success: false, ... }`. Keep the
existing `failCollections` (returned-failure) behavior intact so both shapes are
covered side by side.

## Interaction notes (no action, just don't regress them)

- `cancelPhase` (coordinator.ts:881-897) is best-effort and already tested for the
  swallow-and-continue behavior (spec lines 242-280). The new test only needs to
  assert *which* block ids were cancelled, mirroring the line-149 test.
- The tx-9 double-cancel concern from the source ticket is not in play here:
  `cancelPhase` cancels only the *fulfilled* collections, never the failed one,
  so the coordinator's sweep and any transactor-side auto-cancel of the failed
  collection's own batches do not overlap.

## TODO

- Add `throwCollections?: Set<string>` (or equivalent) to `InstrumentedTransactor`
  in `test/coordinator.spec.ts`; in `pend`, throw for a matching collection id
  before the returned-failure branch.
- Add a `pendPhase` test: one collection in `throwCollections`, assert
  `result.success === false`, `result.error` mentions the failing collection, and
  `transactor.cancelledBlockIds` equals the sorted sibling `-tail` ids (mirror the
  line 149-171 test's assertions).
- Run `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore-test.log`
  (or the repo's equivalent — check `packages/db-core/package.json` scripts) and
  confirm the new test passes and nothing regressed.
