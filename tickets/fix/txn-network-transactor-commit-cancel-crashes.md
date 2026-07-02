description: Two related failure-path defects in the network commit code: an automatic cleanup step is fired without catching its errors, so a failed commit can crash the whole process, and a separate spot assumes a piece of failure data is always present and crashes with a type error when it isn't, hiding the real reason the commit failed.
files:
  - packages/db-core/src/transactor/network-transactor.ts (fire-and-forget cancel ~line 573; cancelBatch ~line 480; commitBlock missing-flatMap ~line 577)
  - packages/db-core/src/network/struct.ts (StaleFailure.missing is optional, ~line 61)
difficulty: easy
----

# Network transactor commit/cancel path: unhandled rejection + non-null-assert crash

Two small but severe defects on the same failure path in `NetworkTransactor`.

## Part A — fire-and-forget cancel can crash the process (was tx-5)

`Promise.resolve().then(() => this.cancel({...}))` (~line 573) has no `.catch`.
`cancel()` calls `findCoordinator`, which rejects precisely when a commit just failed
(peers unreachable) — producing an unhandled promise rejection, which is fatal in
modern Node. The analogous `void Promise.resolve().then(() => this.cancelBatch(...))`
(~line 480) has the same shape.

Fix: append a `.catch(e => log('cancel failed: %o', e))` (or equivalent) to both so a
cancel failure is logged, not fatal.

## Part B — commitBlock non-null-asserts optional `missing` (was tx-6)

`commitBlock` does `.flatMap(b => (b.request!.response! as StaleFailure).missing!)`
(~line 577), but `StaleFailure.missing` is optional (`network/struct.ts:61`). A
reason-only stale failure yields `undefined` elements, and `distinctBlockActionTransforms`
destructures them → TypeError that masks the real stale-failure reason. The pend path
already filters this (~line 486); the commit path does not.

Fix: apply the same `.filter((x): x is ActionTransforms => x !== undefined)` before
the transforms are consumed.

## Expected behavior

A failed commit logs and cleans up without crashing the process, and a reason-only
stale failure surfaces its real reason instead of a TypeError.

Severity: HIGH (Part A) / MEDIUM (Part B). Both are small, localized, and share the
same commit-failure region — hence one ticket.
