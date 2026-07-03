description: When saving a change to a table plus its indexes (or two tables at once) in the default single-node mode, a failure partway through can permanently persist some of the trees and not others, leaving the data out of sync with no recovery; narrow that window and stop the misleading fake rollback.
prereq: optimystic-savepoint-noop-tracker-rollback
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/collection/collection.ts, docs/transactions.md
difficulty: medium
----

# Implement: legacy-mode commit atomicity across trees

## Problem

Legacy (default, no-coordinator) commit flushes each dirty tree with a separate
`await tree.sync()` (`txn-bridge.ts:228-238`), and each `tree.sync()` is its own
`collection.updateAndSync()` — a full pend+commit against the transactor
(`tree.ts:104-108`, `collection.ts:361`). If the flush of tree N+1 fails, the
`catch` calls `rollbackTransaction()`, which in legacy mode restores the
**in-memory** snapshot of **every** dirty tree — including trees `1..N` that were
**already durably committed** to storage this commit.

Two durable consequences:

1. **Split persistence.** Trees `1..N` stay written; tree `N+1..` do not. A table
   and its secondary index (or two tables mutated in one SQL transaction) diverge
   on disk with no recovery path.
2. **Misleading in-memory "rollback".** For the already-synced trees `1..N`,
   `rollbackTransaction` restores the pre-transaction in-memory snapshot — so the
   in-memory view now **disagrees with storage** (memory says "not applied",
   storage says "applied"). The caller is told the transaction rolled back; it did
   not.

## What is and isn't achievable

True durable all-or-nothing across independent block clusters is the job of the
distributed consensus path (GATHER/PEND/COMMIT across critical blocks, see
`docs/transactions.md`). Locally, `StorageRepo.commit` is per-block and even the
coordinator's `commitPhase` commits critical blocks via `Promise.all` — so a
post-first-commit failure is a narrow-but-real window everywhere. A **local** fix
cannot deliver perfect durability atomicity; it can (a) **narrow the window** so
the common failures (conflict/validation at pend) happen before anything is
durably committed, and (b) **stop lying** about rollback when partial persistence
has already happened.

## Direction

### Required (minimum, honest failure)

- On a mid-commit flush failure in legacy mode, do **not** silently restore the
  in-memory snapshots of trees that were already synced this commit (that is what
  diverges memory from storage). Track which trees in the `dirtyTrees` loop
  (`txn-bridge.ts:235-237`) have completed `sync()`. If the failure occurs after
  at least one tree synced, surface an explicit, loud error (e.g.
  `PartialCommitError`) naming the persisted vs. unpersisted trees, and skip the
  misleading in-memory restore of the persisted ones. If the failure is on the
  **first** tree (nothing persisted yet), the existing snapshot-restore rollback
  is correct — keep it.
- Document the limitation loudly at the commit site (`txn-bridge.ts:228`) and in
  `docs/transactions.md`: legacy multi-tree commit is not durably atomic across
  trees; a failure after the first tree's flush leaves partial persistence.

### Preferred (narrow the window: pend-all-then-commit-all)

Restructure legacy commit to a two-phase shape mirroring the coordinator:

1. **Pend** every dirty tree's staged transforms to the transactor (no commit).
2. If all pends succeed, **commit** every tree; if any pend fails, **cancel** all
   pended trees and roll back in-memory (clean — nothing durably committed).

This moves the likely failure (stale-read/conflict/validation, which surfaces at
pend) entirely before any durable commit, so those cases become truly
all-or-nothing. Only a failure during the commit sweep remains partial — and that
is the same residual window the distributed path has.

Feasibility notes for the implementer:
- `collection.updateAndSync()` bundles pend+commit; check whether
  `collection.sync()` (`collection.ts:250`, "Push our pending actions to the
  transactor") exposes a pend-only / stage-to-transactor step that can be split
  from the commit, or whether the transactor's `pend` then `commit`
  (`collection-factory.ts:221-226` local transactor delegates to
  `StorageRepo.pend`/`commit`) can be driven directly across the registered
  collections.
- An alternative to hand-rolling two-phase: construct a `TransactionCoordinator`
  locally from the transactor + the bridge's existing `collectionRegistry`
  (`getCollectionRegistry()`, already maintained unconditionally) and route legacy
  commit through `coordinator.commit(transaction)` with a minimal locally-built
  `Transaction` record (no engine/validation needed for a single-node
  `LocalTransactor`). This reuses the session-mode machinery that already reads
  `tracker.transforms` and folds committed state into the cache. Weigh this
  against the simpler direct pend/commit sweep; pick one, document the tradeoff in
  the PR/handoff.

If the preferred two-phase restructuring proves too large or risky for one pass,
ship the **required** minimum (honest failure + loud docs) and file a follow-up
`backlog/feat-` ticket for the two-phase narrowing, referencing this analysis.

## Edge cases to cover in tests

- Two dirty trees (main table + one index, or two tables in one txn); inject a
  transactor whose `commit` (or `pend`, for the two-phase variant) fails on the
  **second** collection. Assert:
  - two-phase: nothing persisted (pend failure path), in-memory clean, error
    surfaced.
  - required-minimum path (commit-sweep failure after first tree): the persisted
    tree's storage is NOT silently reverted in-memory, and a clear partial-commit
    error is raised (no false "rolled back" success).
- Reopen the storage (as `deferred-constraint-rollback.spec.ts` does) to assert
  on-disk state matches the reported outcome.
- Confirm the deferred-constraint whole-transaction rollback path (constraint
  throws before commit, nothing synced) still rolls back cleanly.

## TODO

- [ ] Write a failing regression test first using an injected transactor that
  fails `commit` (and, for two-phase, `pend`) on the second collection. Model
  harness on `deferred-constraint-rollback.spec.ts` (real `local` +
  `FileRawStorage`, or a custom transactor via
  `collectionFactory.registerCustomTransactor`). Confirm current `main` leaves
  split persistence + false-success rollback.
- [ ] Implement the required minimum: track synced trees in the legacy commit
  loop; on post-first-tree failure raise an explicit partial-commit error and skip
  the misleading in-memory restore of already-synced trees.
- [ ] Evaluate + (if feasible in scope) implement the preferred pend-all-then-
  commit-all restructuring (direct two-phase over the registry, or route through a
  locally-constructed coordinator). If deferred, file a `backlog/feat-` follow-up
  citing this ticket.
- [ ] Document the residual limitation loudly at `txn-bridge.ts` commit site and
  in `docs/transactions.md`.
- [ ] Build `@optimystic/db-core` then `@optimystic/quereus-plugin-optimystic`
  and run the plugin suite (stream with `tee`); confirm regressions pass and
  nothing else regresses.
