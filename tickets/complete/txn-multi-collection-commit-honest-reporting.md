description: When a transaction saves to several collections and one save fails after another already succeeded, the caller was told the whole thing failed and assumed nothing changed — so the two halves silently diverged. The commit now reports which collections actually landed and stops the local cleanup from corrupting the half that committed.
prereq: txn-commitphase-retries-autocancelled-commit
files:
  - packages/db-core/src/transaction/errors.ts (NEW — CoordinatorPartialCommitError)
  - packages/db-core/src/transaction/index.ts (exports the new error)
  - packages/db-core/src/transaction/coordinator.ts (partition threaded through coordinateTransaction/commit/execute)
  - packages/db-core/src/transaction/transaction.ts (ExecutionResult.committedCollections/failedCollections)
  - packages/db-core/src/transaction/session.ts (propagates the structured error unchanged)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (CoordinatorPartialCommitError catch branch)
  - packages/db-core/test/transaction.spec.ts ("Multi-collection partial commit honest reporting" describe)
  - docs/transactions.md ("Session-mode (distributed) commit is not atomic across collections" section)
----

# Complete: multi-collection commit — honest partial-commit reporting

## What shipped

A distributed multi-collection commit runs GATHER → PEND → COMMIT and commits each
collection's pended blocks **independently**. One collection can commit durably while
another fails permanently (a "stale loss" — a racing transaction advanced that
collection's log tail between PEND and COMMIT). Before this change the caller heard only
"failed", assumed a clean abort, and the two halves diverged silently — worse, the local
cleanup re-staged the already-durable collection's actions as still-pending, so tracker
memory disagreed with cluster storage.

This work is the **honest-reporting surface**, not atomicity. The half-commit still
happens; the change makes the failure *report which collections landed* and stops the
local cleanup from corrupting the committed half:

1. **`CoordinatorPartialCommitError`** (new) carries `committedCollections` (durable,
   cannot roll back) + `failedCollections` (reverted for retry) + the underlying reason.
   Session-mode analog of the plugin's legacy `PartialCommitError`.
2. **Partition threaded upward** — `coordinateTransaction` now returns the
   committed/failed sets it already received from `commitPhase` (previously discarded).
3. **`commit()` catch split** — on a non-empty committed set, committed collections get
   the success-path local treatment (`recordCommitted` + `applyCommittedToCache` +
   `tracker.reset` + `clearPendingActions`), failed collections get `restorePending` to
   the pre-append snapshot, `stampData` is cleared, and the new error is thrown. The
   empty-committed path (clean failure) is unchanged: restore every tracker, plain `Error`.
4. **`execute()`** — `ExecutionResult` gained `committedCollections`/`failedCollections`;
   the partial path applies its own success-path treatment (`recordCommitted` +
   `tracker.reset`) to the committed subset.
5. **Bridge** — `commitTransaction`'s catch special-cases `CoordinatorPartialCommitError`:
   tears down transaction state **without** `rollbackTransaction()` (a clean restore would
   cement the divergence) and re-throws.
6. **Docs** — `docs/transactions.md` gained the session-mode non-atomicity note, pointing
   at `1.5-design-multi-collection-atomicity` as owner of the real-2PC-vs-honest-downgrade
   decision.

## Review findings

Adversarial pass over commit 70b0f2a. Read the full implement diff with fresh eyes before
the handoff summary.

**Validation run (all green):**
- `packages/db-core`: `yarn build` (tsc) clean; `test/transaction.spec.ts test/coordinator.spec.ts`
  = **87 passing** (2 new).
- `packages/quereus-plugin-optimystic`: `yarn build` (tsup ESM + DTS) clean — confirms the
  cross-package `CoordinatorPartialCommitError` import and `ExecutionResult`/bridge edits type-check.
- `eslint` on all six touched source/test files: clean.
- No pre-existing failures; `.pre-existing-error.md` not written.

**Correctness — checked, nothing found:**
- *Partition completeness.* `committed ∪ failed` = every participating collection: both
  sets derive from `commitPhase`'s iteration of `pendedBlockIds`, which is built from
  `collectionTransforms`, which is built from `collectionData` — so the `else`
  (`restorePending`) branch in `commit()`'s partial loop provably covers every
  non-committed collection. No collection falls through untreated.
- *`collectionTransforms.get(id)!` safety* (checklist item). The partial branch is reached
  only after the append loop completed without throwing (a throw routes to the restore-all
  catch instead), so `collectionTransforms` holds an entry for every committed collection.
  The non-null assertion is sound.
- *`stampData` lifecycle.* Deleted on the partial path (correctly — a half-committed txn
  must not be later rollback()'d, which would clobber the committed collection's careful
  state) and on success; **retained** on the empty-committed path (correctly — that path is
  cleanly rollback-able, and retaining preserves the pre-existing rollback contract). No leak.
- *Empty-committed path unchanged.* `FlakyCommitTransactor(Infinity)` returns permanent
  `{success:false}` for both collections → empty committed set → plain `Error`, every
  tracker restored. Preserves `txn-failed-commit-leaves-staged-log-entry`'s guarantee. Test
  asserts it is explicitly NOT a `CoordinatorPartialCommitError`.
- *Error propagation.* `session.commit()` awaits `coordinator.commit()` with no try/catch —
  the structured error propagates unswallowed. Confirmed by the passing partial-commit test.
- *Bridge teardown.* The new branch clears exactly the fields `rollbackTransaction()` clears
  (collections, isActive, accumulatedStatements, session, dirtyTrees, savepoints) **minus**
  the session.rollback + dirtyTrees restore it deliberately skips. Matches intent.

**Tests — happy/edge/error paths covered as a floor:** partial (users durable, posts stale)
and empty-committed (all fail) are both exercised end-to-end through `session.commit()`, with
assertions on the error type, the committed/failed sets, per-collection tracker/pending state,
durable readback, and stampData. See the one coverage gap filed below.

**Findings dispositioned:**

- **MAJOR → filed `tickets/backlog/debt-bridge-partial-commit-branch-test.md`.** The bridge's
  `CoordinatorPartialCommitError` catch branch has no *direct* test — covered only by the
  plugin build (type-check) and by mirroring the tested legacy `PartialCommitError` branch.
  A session-mode partial commit driven through the vtab (asserting `rollbackTransaction()` is
  skipped and the error propagates) is the highest-value addition. Filed as `debt-` rather
  than fixed inline: it needs a real session-mode + fault-injection harness (templates exist
  in `legacy-commit-atomicity.spec.ts` + `session-mode-commit.spec.ts`), more than a trivial
  inline fix, and the db-core layer beneath it is fully tested so risk is low today.

- **TRIPWIRE (carried forward from implement, parked in this index).** Both `commit()`'s and
  `execute()`'s committed-subset loops iterate `result.actions` / `collectionData`, not a
  deduped collection set, so if an engine ever emits two `CollectionActions` for the *same*
  collection in one transaction, `recordCommitted` double-bumps that collection's rev. This is
  **pre-existing** — the success paths already do it, and a passing test (transaction.spec.ts
  ~252, two `users-tree` entries) exercises it with no observable harm because nothing asserts
  the rev. Fine now; *if* per-collection rev accounting ever becomes load-bearing, dedupe by
  collection in BOTH the success and failure paths. Parked here (not a code comment) because it
  lives on pre-existing code this ticket didn't author.

- **OBSERVATION (no action — pre-existing, out of scope).** The legacy `PartialCommitError`
  catch branch (`txn-bridge.ts` ~338-345) just re-throws and leaves transaction state active
  (isActive stays true, session non-null), whereas the new `CoordinatorPartialCommitError`
  branch does a full teardown. The new branch is arguably the more correct of the two, but the
  legacy branch is tested (`legacy-commit-atomicity.spec.ts`) and untouched here. Not a
  regression introduced by this ticket; noted for whoever revisits the legacy branch.

**Empty categories:** No correctness/type-safety/resource-cleanup/error-handling defects found
— the audit above lists each aspect actually checked. No conditional concerns beyond the single
tripwire recorded. No docs left stale: `docs/transactions.md`, `errors.ts` doc comment,
`ExecutionResult` doc comment, and inline coordinator comments all reflect the shipped behavior.

## Out of scope (unchanged, owned elsewhere)

This is reporting, **not** atomicity. No automatic reconciliation, no durable coordinator
decision record / 2PC journal, no crash-mid-loop recovery. That decision (real 2PC vs. formal
honest-downgrade) is owned by `1.5-design-multi-collection-atomicity` (`tickets/plan/`).

## Prereq merge note

Built on the current tree; `txn-commitphase-retries-autocancelled-commit` (its review already
landed at eb395f3) also touches the `coordinateTransaction` commit-failure block. The
`{ committedCollections, failedCollections }` partition shape is unchanged by that work, so any
overlap was mechanical. Post-landing validation above confirms no conflict remains.
