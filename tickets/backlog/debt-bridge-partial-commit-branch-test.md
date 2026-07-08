description: The Quereus adapter has code that handles a "half-committed" distributed transaction specially, but nothing exercises that code — add a test so it can't silently break.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (the CoordinatorPartialCommitError catch branch ~346-362)
  - packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts (template: injects a commit-failing transactor, asserts no clean rollback)
  - packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts (template: enableSessionMode helper wires a real coordinator/engine into the bridge)
  - packages/db-core/src/testing/test-transactor.ts (SelectiveCommitFailTransactor pattern lives in transaction.spec.ts; could be promoted here)
difficulty: medium
----

# Add a bridge-level test for the session-mode partial-commit path

## Background

When a distributed (session-mode) transaction touches several collections (a main
table plus its index collections) and one collection's commit fails *permanently*
while another already committed durably, `TransactionCoordinator.commit()` throws
`CoordinatorPartialCommitError`. The Quereus adapter's `TransactionBridge.commitTransaction`
catches this and, unlike a clean failure, tears down transaction state **without**
calling `rollbackTransaction()` — a clean restore would re-stage the already-durable
collection's actions as pending and cement a memory/storage divergence.

That catch branch (`txn-bridge.ts` ~346-362) currently has **no direct test**. It is
covered only by:
- the plugin build (it type-checks), and
- being a near-exact mirror of the legacy `PartialCommitError` branch just above it,
  which *is* tested by `legacy-commit-atomicity.spec.ts`.

The db-core layer beneath it (the coordinator's partial-commit split) is thoroughly
tested in `db-core/test/transaction.spec.ts`. So the risk is low today — but if the
bridge branch's teardown drifts from what a real partial commit needs, nothing catches it.

## What to build

A plugin-level test that drives a **real** session-mode partial commit through the vtab
and asserts the bridge behavior:

- Set up session mode against `FileRawStorage` (or in-memory) using the `enableSessionMode`
  helper from `session-mode-commit.spec.ts`, with an indexed table so the commit spans
  the main collection + at least one index collection.
- Wrap the transactor so exactly one collection's `commit()` returns a permanent
  `{ success: false }` (a stale loss) while the others commit durably — mirror the
  `SelectiveCommitFailTransactor` pattern from `transaction.spec.ts` (identify the poison
  collection at PEND time via the inserted block header's `collectionId`), and the
  commit-failing-transactor injection from `legacy-commit-atomicity.spec.ts`.
- Assert:
  - the commit rejects with `CoordinatorPartialCommitError` (names committed vs failed),
  - `rollbackTransaction()` is **not** invoked (spy, or assert the durably-committed
    collection's rows are still readable — a rollback would have re-staged them),
  - the bridge tears down transaction state (`isActive === false`, `session === null`,
    savepoints/dirtyTrees cleared) so the connection isn't left with a stuck transaction.

## Why debt, not a bug

The branch is currently correct (type-checks, mirrors a tested branch, and the db-core
layer it depends on is fully tested). This is a missing-coverage guard, not a live defect.
