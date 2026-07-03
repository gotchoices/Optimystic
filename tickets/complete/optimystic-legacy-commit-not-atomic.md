description: In the default single-node mode, a save that writes a table plus its indexes could fail halfway and leave some trees written and others not while lying that it "rolled back"; this makes that failure loud and honest instead of silent, and documents the remaining limit.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts, docs/transactions.md, tickets/backlog/feat-optimystic-legacy-commit-two-phase.md
difficulty: medium
----

# Complete: legacy-mode commit atomicity across trees

## What shipped

Legacy (default, no-coordinator) commit flushes each dirty tree (main table + each
secondary index) with an independent `tree.sync()`. If tree N+1's flush fails after
tree N already committed to storage, trees `1..N` stay durably written and `N+1..`
do not. The old failure path called `rollbackTransaction()`, which restored the
in-memory snapshot of **every** dirty tree — including the already-committed ones —
producing both a false "rolled back" report and a memory/storage divergence.

The **honest-failure minimum** (per the implement ticket's "Required" scope):

- **`commitDirtyTreesLegacy()`** (`txn-bridge.ts`) replaces the blanket sync loop.
  Failure on the first tree (nothing persisted) → re-throw → ordinary clean
  snapshot-restore rollback. Failure after ≥1 tree synced → restore only the
  never-synced trees, leave the durably-committed trees' in-memory state alone,
  tear down the transaction, throw a loud **`PartialCommitError`**.
- **`PartialCommitError`** — new exported error class naming persisted vs.
  unpersisted collection ids + underlying reason. Exported from `src/index.ts`.
  `commitTransaction`'s catch detects it and skips `rollbackTransaction`.
- **`DirtyTree.describe?()`** — optional; `Tree.describe()` returns its collection
  id (used only to name trees in the error; falls back to `tree#<index>`).
- **Docs** — loud blockquote at the top of `docs/transactions.md`.
- **Backlog** — `feat-optimystic-legacy-commit-two-phase.md` for the deferred
  pend-all-then-commit-all narrowing.

The larger "preferred" two-phase restructuring was deliberately deferred (see the
backlog ticket) — the residual on-disk split window still exists but is now loud.

## Review findings

Reviewed the full implement diff (`bfccca7`) with fresh eyes before the handoff
summary, against SPP/DRY/modularity/error-handling/type-safety/resource-cleanup and
happy/edge/error/regression/interaction test coverage.

**Verified correct:**

- **Sweep control flow** — first-tree-fail → clean rollback; post-first-tree-fail →
  `PartialCommitError` with only unsynced trees restored and persisted trees left
  matching storage. `commitTransaction`'s catch correctly skips `rollbackTransaction`
  on `PartialCommitError`. Teardown in the partial path mirrors `rollbackTransaction`
  minus the persisted-tree restore.
- **Tree ordering** — `markDirtyTrees()` (`optimystic-module.ts:740`) marks the main
  collection before index trees, and `dirtyTrees` is insertion-ordered, so the sweep
  flushes main first. This is the invariant the second-tree-failure test relies on;
  confirmed at the source, not assumed.
- **Type safety** — `describe?()` optional so test doubles need not implement it;
  `Tree.describe()` structurally satisfies it. Plugin `typecheck` exits 0.
- **Tests** — the two shipped tests are discriminating (target exactly the two
  documented pre-fix symptoms: main silently reverted + false rollback). Both pass.
- **Docs** — `docs/transactions.md` blockquote read in full; accurately describes
  first-tree vs. post-first-tree behavior and the residual window. Backlog ticket is
  well-formed and captures the deferred work with a real feasibility analysis.

**Gates run (all green):**

- `yarn workspace @optimystic/db-core run build` + plugin build — succeed.
- Plugin `typecheck` — exit 0.
- Focused spec `legacy-commit-atomicity.spec.ts` — 2/2 passing.
- Full plugin suite (`test/**/*.spec.ts`) — **293 passing, 11 pending, 0 failing**.
- `eslint` on all changed files — exit 0.

**Fixed inline (minor):** none required — no correctness/style defects found in the
diff.

**Filed as new ticket(s) (major):** none. The one substantive deferral (the
two-phase narrowing) was already filed by the implementer as
`feat-optimystic-legacy-commit-two-phase` in `backlog/`; reviewed and accepted as
correctly scoped.

**Recorded as tripwire (conditional):**

- *Failing tree assumed fully unpersisted.* `commitDirtyTreesLegacy` labels the
  failing tree as "unpersisted" and reverts its in-memory state. That is correct
  while a single tree's flush is all-or-nothing (a conflict/stale rejection cancels
  its pend before any block commits). It stops holding if one collection's OWN
  commit spans multiple block commits and fails mid-loop — `StorageRepo.commit`
  emits per-block eagerly, so that tree would itself be split and reverting its
  memory reintroduces divergence for it. This is the same intra-collection residual
  the distributed coordinator already carries, and only trips on a mid-block-loop
  commit failure of a large single-collection flush — conditional, not reachable by
  the current failure modes. Parked as a `NOTE:` comment at the restore site in
  `txn-bridge.ts` (not a ticket).
- *Quereus xRollback-after-failed-xCommit assumption.* The partial path sets
  `isActive = false`; if Quereus called `xRollback` afterward, `rollbackTransaction`
  would throw "No active transaction". The full suite passing (and the pre-existing
  code sharing the assumption) is evidence it does not. Already documented by the
  implementer in the handoff; no new parking needed.

**Checked, accepted as-is (not defects):**

- *Only main-table + secondary-index shape is tested; "two tables in one txn" has no
  dedicated test.* The code path is identical (two entries in `dirtyTrees`, swept in
  order), and the tree provenance does not change the sweep logic. Adding an
  explicit multi-statement-transaction test would exercise Quereus begin/commit
  routing not otherwise covered here and risks a flaky addition for zero new
  coverage of the changed code. Accepted as an equivalent case.
- *`PartialCommitError` uses `reason` rather than standard `Error.cause`.* Chosen to
  also expose `persisted`/`unpersisted` arrays for programmatic reconciliation.
  Reasonable for the stated caller-reconciliation contract.
- *No automatic reconciliation of a surfaced split.* By design — local mode cannot
  un-commit. The error hands recovery to the caller/operator.

**Pre-existing tripwire (untouched):** the savepoint snapshot-cost note in
`txn-bridge.ts` (O(collections × staged-transforms) per statement) predates this
work and remains valid; no change.
