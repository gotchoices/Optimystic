description: When a transaction saves to several collections and one save fails after another already succeeded, the caller was told the whole thing failed and assumed nothing changed — so the two halves silently diverged. The commit now reports which collections actually landed and stops the local cleanup from corrupting the half that committed.
prereq: txn-commitphase-retries-autocancelled-commit
files:
  - packages/db-core/src/transaction/errors.ts (NEW — CoordinatorPartialCommitError)
  - packages/db-core/src/transaction/index.ts (export the new error)
  - packages/db-core/src/transaction/coordinator.ts (coordinateTransaction return type + commit-phase-failure return ~576-600; commit() partition-aware catch ~199-262; execute() failure path ~437-465)
  - packages/db-core/src/transaction/transaction.ts (ExecutionResult.committedCollections/failedCollections ~139-160)
  - packages/db-core/src/transaction/session.ts (unchanged — confirmed it propagates the structured error)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (commitTransaction catch: new CoordinatorPartialCommitError branch ~337-370)
  - packages/db-core/test/transaction.spec.ts (new "Multi-collection partial commit honest reporting" describe)
  - docs/transactions.md (new "Session-mode (distributed) commit is not atomic across collections" section)
difficulty: hard
----

# Review: multi-collection commit — honest partial-commit reporting

## What this ticket delivered

A multi-collection commit runs GATHER → PEND → COMMIT, and the COMMIT phase commits each
collection's pended blocks **independently**. One collection can commit durably while
another fails permanently (e.g. a racing transaction advanced that collection's log tail
between PEND and COMMIT — a "stale loss"). Before this change the caller was told only
"failed", assumed a clean abort, and the two halves diverged silently — worse, the local
cleanup re-staged the *already-durable* collection's actions as still-pending, so local
tracker memory disagreed with cluster storage.

This work is the **honest-reporting surface** — the defensible minimum. It does NOT make
the commit atomic; the half-commit still happens. It makes the failure *report which
collections landed* and stops the local cleanup from corrupting the committed half.

Concretely:

1. **`CoordinatorPartialCommitError`** (new, `db-core/src/transaction/errors.ts`,
   exported from `src/index.ts`) — carries `committedCollections` (durable, cannot be
   rolled back) and `failedCollections` (reverted for retry) plus the underlying reason.
   It is the session-mode / distributed analog of the plugin's legacy `PartialCommitError`.

2. **Partition threaded upward.** `coordinateTransaction` now returns
   `{ committedCollections?, failedCollections? }` on a commit-phase failure (it already
   received the partition from `commitPhase`; it used to discard it).

3. **`commit()` catch split.** On a failure with a **non-empty** committed set, the catch
   no longer uniformly restores pending. Per collection: committed → success-path local
   treatment (`recordCommitted` + `applyCommittedToCache` + `tracker.reset` +
   `clearPendingActions`) so memory matches storage; failed → `restorePending` to the
   pre-append snapshot for a clean retry. Then it clears `stampData` and throws the new
   error. The **empty-committed** path (PEND failed, or a clean whole-commit failure) is
   unchanged: restore every tracker, throw a plain `Error` — preserving the sibling
   ticket `txn-failed-commit-leaves-staged-log-entry`'s guarantee.

4. **`execute()` path.** `ExecutionResult` gained `committedCollections?` /
   `failedCollections?`. `execute()` populates them on a partial failure and applies the
   success-path local treatment (`recordCommitted` + `tracker.reset`, mirroring its own
   success path) to the committed subset. It is deliberately *not* snapshot/restore-wrapped
   (matching the pre-existing asymmetry documented at coordinator.ts ~380-388).

5. **Bridge.** `TransactionBridge.commitTransaction`'s catch gained a
   `CoordinatorPartialCommitError` branch alongside the existing legacy `PartialCommitError`
   branch: it tears down transaction state **without** calling `rollbackTransaction()`
   (a clean restore would cement the divergence) and re-throws.

6. **Docs.** `docs/transactions.md` gained a "Session-mode (distributed) commit is not
   atomic across collections" note mirroring the legacy one, pointing at
   `1.5-design-multi-collection-atomicity` as the owner of the still-open real-2PC-vs-
   honest-downgrade decision.

## How it was validated

- `packages/db-core`: `yarn build` (tsc) clean; **full `yarn test` = 1158 passing, 0
  failing**. Targeted `test/coordinator.spec.ts test/transaction.spec.ts` = 85 passing.
- `packages/quereus-plugin-optimystic`: `yarn build` (tsup ESM + DTS) clean — confirms the
  `ExecutionResult`/bridge changes and the cross-package `CoordinatorPartialCommitError`
  import type-check.
- No pre-existing failures surfaced; `.pre-existing-error.md` not written.

### New tests (`test/transaction.spec.ts`, describe "Multi-collection partial commit …")

A `SelectiveCommitFailTransactor` wraps `TestTransactor` and forces the COMMIT of exactly
one collection to fail permanently (returned `{success:false}` — a stale loss) while the
others commit durably. It identifies the poison collection at PEND time via the inserted
blocks' `header.collectionId` (set by `TransactorSource.createBlockHeader`).

- **Partial commit** — asserts `coordinator.commit()` (via `session.commit()`) throws
  `CoordinatorPartialCommitError`; the error names committed=`['users']`, failed=`['posts']`;
  the committed collection's pending was **cleared** (not restored) and its durable value
  reads back through the folded cache; the failed collection's tracker + pending were
  **restored** to the pre-append snapshot; `stampData` was cleared.
- **Empty-committed** — with every commit failing (`FlakyCommitTransactor(Infinity)`),
  asserts a **plain** `Error` (explicitly NOT `CoordinatorPartialCommitError`), every
  tracker restored, nothing durably committed.

## Where to look hardest (honest gaps — treat tests as a floor)

- **This is reporting, not atomicity.** The divergence still occurs; there is NO automatic
  reconciliation, no durable coordinator decision record / 2PC journal, and no
  crash-mid-loop recovery. All of that is explicitly out of scope and owned by
  `1.5-design-multi-collection-atomicity` (`tickets/plan/`). Confirm the reviewer does not
  expect atomicity here.

- **The bridge branch has no *direct* test.** It is covered only by the plugin's build (it
  type-checks) and by mirroring the already-proven legacy `PartialCommitError` branch. No
  plugin-level test drives a real session-mode partial commit through the vtab to assert
  `rollbackTransaction()` is skipped and the error propagates. If you want belt-and-braces,
  a bridge-level test is the highest-value addition. (Weighed against: the db-core layer
  the bridge depends on IS thoroughly tested, and the branch is a near-exact copy of the
  legacy one.)

- **Only the *returned stale* (permanent) commit-failure class is exercised end-to-end.**
  The test intentionally does NOT assert commit attempt counts, so it stays robust to the
  prereq `txn-commitphase-retries-autocancelled-commit` landing (which changes stale=1 vs
  transient=3 retry semantics). A *thrown transient* failure that still ends non-empty-
  committed is not directly driven here — but the partition logic keys off
  `committedCollections`/`failedCollections`, which are populated identically regardless of
  the failure class, so the honest-reporting path is class-agnostic. Verify that reasoning.

- **`execute()`'s committed-subset treatment mirrors its success path, which re-records if
  an engine emits two `CollectionActions` for the *same* collection in one transaction**
  (both the success path at coordinator.ts ~443-449 and my failure path iterate
  `result.actions`, not a deduped collection set, so `recordCommitted` double-bumps the
  rev). This is **pre-existing** — the success path already does it, and a passing existing
  test (transaction.spec.ts ~252, two entries for `users-tree`) exercises it without
  observable harm because nothing asserts the rev. I mirrored the existing behavior rather
  than diverging from it. Tripwire, not a bug: fine now; if per-collection rev accounting
  ever becomes load-bearing, dedupe `result.actions` by collection in BOTH paths. Parked
  here (findings index) rather than as a code comment, since it lives on pre-existing code
  this ticket didn't author.

## Coordination with the prereq (kept as `prereq:` on purpose)

`txn-commitphase-retries-autocancelled-commit` (implement/) also edits `commitCollection`
(retry rule) and the `coordinateTransaction` commit→cancel handoff. This work was built on
the **current** tree (prereq not yet landed) and touches the same
`coordinateTransaction` commit-failure block (coordinator.ts ~576-600 — I widened its
return). Expect a **small textual merge there** when the prereq lands; the *shape* of the
`{ committedCollections, failedCollections }` partition is unchanged by the prereq, so the
merge is mechanical. The prereq is carried forward as a `prereq:` so this review is run
against the merged result, not before it.

## Suggested review focus checklist

- [ ] `commit()`: the non-empty-committed branch uses `collectionTransforms.get(id)!` — is
      it always populated for committed collections? (Yes: the partial branch is reached
      only after the append loop completed without throwing; a throw routes to the
      restore-all catch instead. Confirm.)
- [ ] `commit()`: `stampData.delete` happens for the partial case (parity with the success
      path's cleanup) — confirm no leak.
- [ ] Bridge: teardown fields match the legacy `PartialCommitError` branch and
      `rollbackTransaction`'s non-restore cleanup; confirm nothing that needs clearing is
      missed and that `rollbackTransaction()` is genuinely skipped.
- [ ] `session.commit()` still lets the structured error propagate (no swallow into
      `{success:false}`). Confirmed by the passing partial-commit test.
