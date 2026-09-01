description: The database transaction coordinator now refuses to open a second transaction while one is still open, instead of silently mixing the two transactions' unsaved changes into permanent storage. Review the refusal guards, the retired multi-transaction tests, and run the SQL-adapter package's tests, which this session did not get to.
files:
  - packages/db-core/src/transaction/coordinator.ts (guards in `applyActions` ~113-125, `commit` ~217-226, `execute` ~735-743; helper `openStampOtherThan` ~172; invariant doc on `stampData` ~64-79; rewritten comments at the commitOnceLatched success fold and the execute partial-commit delete)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorConcurrentStampError`)
  - packages/db-core/src/transaction/index.ts (export)
  - packages/db-core/test/coordinator-single-stamp.spec.ts (new — 7 cases)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (5 multi-stamp tests deleted, 1 converted to single-stamp, header rewritten)
  - packages/db-core/test/transaction.spec.ts (2 multi-session tests replaced by 1 refusal test, ~3387)
  - docs/transactions.md (new subsection "The coordinator refuses a second open transaction stamp")
----

# What was built

`TransactionCoordinator` now enforces **at most one open transaction stamp at a time**
(`stampData.size <= 1`, documented as an invariant on the map). A second stamp is refused
with the new `CoordinatorConcurrentStampError`, which carries `openStampId` and
`rejectedStampId` and whose message states the recovery (commit or roll back the open
stamp; a failed commit keeps its stamp open until rolled back; concurrent writers need
their own Collection instances).

Three guards, per the implement ticket's design:

- `applyActions` — throws, placed in the await-free prologue (before entry creation and
  `captureUncaptured`), so guard + registration + capture are one atomic step.
- `commit` — throws, once, before the retry loop. Catches the Tree.stage-then-commit
  caller (no `stampData` entry of its own) while a sibling stamp is tracked.
- `execute` — returns `{ success: false, error }` (its local convention), placed before
  the pre-stage snapshot loop.

The two stale `NOTE:` blocks that named the old hazard (commitOnceLatched success fold;
execute partial-commit delete, which proposed a tombstone) now state the enforced
invariant instead. The tombstone is dead as a plan.

Deliberate behavior change to scrutinize: a CLEAN commit failure keeps its stamp entry
(so `rollback(stampId)` stays a complete recovery), which means an **abandoned failed
commit wedges the coordinator against new stamps until someone rolls it back**. The
error message names this recovery. The Quereus bridge is safe: its session-mode commit
failure path calls `rollbackTransaction()` (txn-bridge.ts ~584), and the partial-commit
path relies on the coordinator having dropped the entry itself.

Intentionally NOT closed (out of scope, documented in code + docs): two coordinators
sharing collection instances (the per-coordinator guard cannot see it —
`coordinator-latch-span.spec.ts` ~438 depends on it staying open), and two callers
staging only via `Tree.stage` (invisible to the coordinator entirely).

# Validation done

- `yarn workspace @optimystic/db-core build` — clean.
- `yarn workspace @optimystic/db-core test` — **1592 passing, 0 failing** (full suite;
  log at `tickets/.logs/1-bug-coordinator-refuses-concurrent-stamps.test.log`). This
  includes `coordinator-latch-span.spec.ts` (the two-coordinator case that must keep
  passing) and the surviving `coordinator-rollback-pending.spec.ts` cases.

New spec `coordinator-single-stamp.spec.ts` covers: the ticket's acceptance repro
(second stamp refused; durable log reads `['A']` then `['A','C']` through a FRESH reader
collection); commit of an untracked stamp refused while a sibling is tracked; execute
returning a failure result naming both stamps; release via rollback and via commit; many
batches under one stamp including the empty-actions Quereus pre-stage barrier; the
failed-commit wedge (refused until rollback, then accepted); partial commit dropping the
stamp (new stamp accepted).

# Known gaps — start here

- **`@optimystic/quereus-plugin-optimystic` tests were NOT run** (session hit its token
  budget right before). The bridge drives one session at a time and rolls back on clean
  commit failure, so no failures are expected — but this is the package whose adapter
  sits directly on the narrowed API. Run
  `yarn workspace @optimystic/quereus-plugin-optimystic test` first; a full workspace
  sweep after would settle the other dependents (db-p2p's
  `client-tx-signature.spec.ts` uses one session per coordinator — should be unaffected).
- The refusal-message assertions in the new spec match on substrings
  (`/[Cc]ommit or roll back/`, stamp ids). Judge whether the message wording is worth
  locking that tightly.
- Two pre-existing unused-variable hints in `transaction.spec.ts` (lines ~1356, ~1794,
  `coordinator` declared but unread) predate this change — surfaced by the editor, not
  introduced here, and `tsc` build is clean.

# Review pointers

- The follow-on implement ticket `coordinator-drop-multi-stamp-replay-machinery`
  (already on the board, sequence 2) retires the now-single-stamp replay machinery in
  `rollback`; it depends on the `stampData.size <= 1` invariant this change enforces.
  Review with that in mind — do not delete the replay code here.
- The guard helper `openStampOtherThan` returns the FIRST non-matching key; with the
  invariant enforced there is at most one, but the code should not be "corrected" to
  collect all keys.
- Docs claim and code comment claim the same contract in three places (errors.ts class
  doc, stampData invariant doc, docs/transactions.md subsection) — check they agree.
