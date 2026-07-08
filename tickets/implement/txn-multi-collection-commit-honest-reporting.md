description: When a transaction saves to several collections, some can be permanently saved while a later one fails — but the caller is told the whole thing failed, so it assumes nothing changed and the two halves silently diverge. Make a partial commit report honestly which collections landed, and stop the local cleanup from corrupting the committed half.
prereq: txn-commitphase-retries-autocancelled-commit
files:
  - packages/db-core/src/transaction/coordinator.ts (coordinateTransaction ~539-592; commit ~107-225; execute ~354-461; commitPhase ~740-787)
  - packages/db-core/src/transaction/transaction.ts (ExecutionResult ~139-148)
  - packages/db-core/src/transaction/session.ts (commit ~117-147)
  - packages/db-core/src/index.ts (export the new error type)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (session-mode commit catch ~296-350; existing legacy PartialCommitError ~54-72)
  - packages/db-core/test/coordinator.spec.ts (commitPhase partition test ~216-239)
  - packages/db-core/test/transaction.spec.ts (coordinator.commit end-to-end)
  - docs/transactions.md (add a session-mode partial-commit section, mirroring the legacy one)
difficulty: hard
----

# Multi-collection commit: honest partial-commit reporting

## Scope of THIS ticket

Deliver the **honest-reporting** path only — the defensible minimum that both possible
outcomes of the design decision need. It surfaces *which collections durably committed*
when a multi-collection commit fails partway, and stops the local cleanup from corrupting
the collections that did commit.

**Out of scope:** real cross-collection two-phase commit, a durable coordinator
decision record / 2PC journal, and crash-mid-loop recovery. That is owned by the design
ticket `1.5-design-multi-collection-atomicity` (`tickets/plan/`). Do **not** re-derive that
design here. The honest-reporting surface built here is required *regardless* of which
model that plan picks — its own "Expected behavior" says: "regardless of which is chosen,
the failure result must surface `committedCollections` so callers know reconciliation is
required." So this work is not wasted whichever way the plan lands, and it does not wait on
that decision. (It is deliberately **not** a `prereq:` of this ticket for that reason —
parking the minimum behind an unresolved design decision would leave the half-commit bug
live indefinitely.)

## The bug (reproduced)

A multi-collection commit runs GATHER → PEND → COMMIT. The COMMIT phase commits each
collection's pended blocks independently (`commitPhase`, `coordinator.ts:740-787`, fanned
out per collection). A per-collection commit can *permanently* fail — e.g. a racing
transaction advanced that collection's log tail between PEND and COMMIT (a stale loss) —
while the other collections commit successfully.

`commitPhase` already handles this correctly at its own layer: it returns a partition
`{ committedCollections, failedCollections }` (`coordinator.ts:786`). The existing test
`coordinator.spec.ts:216` ("partitions committed vs failed…") proves the partition is
produced. **The bug is everything upstream of `commitPhase` throwing that partition away:**

1. **Partition dropped.** `coordinateTransaction` (`coordinator.ts:576-585`) receives the
   partition, uses `committedCollections` only to *exclude* those collections from the
   cancel sweep, then returns a bare `{ success: false, error }`. The identity of the
   committed collections is discarded.

2. **Local trackers corrupted for the committed half.** `commit()`'s catch
   (`coordinator.ts:199-207`) restores **every** collection's pre-append pending snapshot —
   including the collections that *did* durably commit. For a committed collection this
   re-stages its already-durable actions as though still pending: local tracker memory now
   disagrees with storage (the action is durable on the cluster but the tracker thinks it
   is un-committed). This is the same memory/storage divergence the legacy path's
   `PartialCommitError` exists to prevent (`txn-bridge.ts:44-52`), but here it is
   *introduced* by the rollback rather than avoided.

3. **Plain throw loses the signal.** `commit()` re-throws `new Error("Transaction commit
   failed: …")` — no structured data about which collections landed. `execute()`'s failure
   path returns an `ExecutionResult` with no committed-collection field either.

4. **Caller assumes a clean abort.** In the Quereus bridge, `commitTransaction`'s catch
   (`txn-bridge.ts:346-349`) treats *any* session-mode throw as "nothing durably
   committed" and runs `rollbackTransaction()` — a clean snapshot-restore. When the commit
   half-landed, that is exactly wrong: it restores the committed collections' in-memory
   state too, cementing the divergence and reporting a rollback that did not happen. Note
   the bridge *already* does the right thing for the legacy path: it special-cases
   `PartialCommitError` and propagates instead of clean-rolling-back (`txn-bridge.ts:338-344`).
   Session mode needs the same treatment for its own partial-commit signal.

Net: caller is told "failed", assumes clean abort, and the committed collections diverge
permanently with no signal that reconciliation is needed. Severity HIGH.

## Design: mirror the legacy `PartialCommitError` at the db-core coordinator layer

The plugin already models honest partial-commit reporting for the *legacy* single-node
path with `PartialCommitError` (`txn-bridge.ts:54-72`): a loud, structured error naming
`persisted` vs `unpersisted` sets, and a caller that propagates it rather than falsely
rolling back. Build the session-mode / distributed-consensus analog in **db-core** (the
coordinator layer must not depend on the plugin).

### 1. Thread the partition out of `coordinateTransaction`

Change `coordinateTransaction`'s failure return so a commit-phase failure carries the
partition:

```
Promise<{ success: boolean; error?: string;
          committedCollections?: Set<CollectionId>;
          failedCollections?: Set<CollectionId> }>
```

On the `!commitResult.success` branch (`coordinator.ts:576-585`), after the targeted
`cancelPhase`, return `{ success: false, error, committedCollections:
commitResult.committedCollections, failedCollections: commitResult.failedCollections }`.
(A PEND-phase failure means nothing committed — leave those sets empty/undefined there.)

### 2. New structured error in db-core

Add a `CoordinatorPartialCommitError` (name to taste; keep it distinct from the plugin's
`PartialCommitError` to avoid import confusion, or hoist a shared base — implementer's
call, but do NOT make db-core depend on the plugin). It carries
`committedCollections: readonly CollectionId[]` and `failedCollections: readonly
CollectionId[]` plus the underlying error/message, with a message that states plainly that
N collections committed durably and cannot be rolled back and reconciliation is required.
Export it from `packages/db-core/src/index.ts`.

### 3. Fix `commit()`'s catch to split committed vs failed local handling

When `coordResult` fails with a **non-empty** `committedCollections`, the catch must NOT
uniformly restore pending. Instead, per collection:

- **Committed collections** → run the *success-path* local treatment so tracker memory
  matches durable storage: `recordCommitted(transaction.id)`,
  `applyCommittedToCache(collectionTransforms.get(id)!)`, `tracker.reset()`,
  `clearPendingActions()`. (These are exactly lines `216-221`; `collectionTransforms` is in
  scope in the catch.)
- **Failed / never-committed collections** → restore the pre-append pending snapshot as
  today (`restorePending(preCommitSnapshots.get(id)!)`), so a retry re-appends cleanly.

Then throw the new `CoordinatorPartialCommitError` naming both sets.

When `committedCollections` is **empty** (PEND failed, or a clean whole-transaction commit
failure), keep today's behavior exactly: restore *all* trackers, throw a plain error. This
preserves the guarantee from the sibling ticket `txn-failed-commit-leaves-staged-log-entry`
(a genuinely clean failure leaves every tracker pristine for retry).

Also clean up `stampData` for the partial case (the success path deletes it at
`coordinator.ts:224`) so a half-committed transaction is not left tracked.

### 4. `execute()` path

`execute()` is not snapshot/restore-wrapped (deliberately — see the note at
`coordinator.ts:380-388`) and is not the retryable entry point, so it needs less. But it
must still stop lying to its caller: on a `coordResult` failure with a non-empty
`committedCollections`, surface that set. Add `committedCollections?: CollectionId[]` (and
optionally `failedCollections?`) to `ExecutionResult` (`transaction.ts:139-148`) and
populate it on the failure return (`coordinator.ts:437-440`). For the committed subset,
apply the same success-path local treatment (`recordCommitted` + `tracker.reset()`, as at
`coordinator.ts:443-449`) so execute()'s committed collections aren't left mis-tracked
either. Keep it lightweight; do not add snapshot/restore to execute() in this ticket.

### 5. Bridge: don't clean-rollback a session-mode partial commit

`session.commit()` (`session.ts:117-147`) currently lets `coordinator.commit()`'s throw
propagate untouched — good; let the new `CoordinatorPartialCommitError` bubble through it
unchanged (do not swallow it into a `{ success:false }` return, or the structured signal is
lost). In the bridge's `commitTransaction` catch (`txn-bridge.ts:337-349`), add a branch
alongside the existing legacy `PartialCommitError` branch: if the error is a session-mode
partial commit, **do not** call `rollbackTransaction()`; tear down transaction state and
re-throw (mirror lines `338-344`). Only fall through to `rollbackTransaction()` when the
failure is genuinely clean (empty committed set / plain error).

### 6. Docs

Add a section to `docs/transactions.md` next to the existing "Legacy (single-node) commit
is not atomic across trees" note, describing the session-mode / distributed partial-commit
window and the honest-reporting contract (`committedCollections` on the failure). Reference
`1.5-design-multi-collection-atomicity` as the owner of the still-open decision between
real 2PC and an honest atomic-intent downgrade. Do **not** edit `docs/correctness.md`
Theorem 3 — its rewrite is owned by the design ticket.

## Coordination with the prereq

`txn-commitphase-retries-autocancelled-commit` (implement/) edits `commitCollection` (retry
rule) and the `coordinateTransaction` commit→cancel handoff. It lands first; build on its
corrected `commitPhase` partition semantics (stale = 1 attempt, transient = 3). It does not
change the *shape* of the `{ committedCollections, failedCollections }` partition this
ticket threads upward, so the two are complementary — expect a small merge around
`coordinator.ts:576-585` only.

## TODO

- Add `CoordinatorPartialCommitError` (db-core) carrying committed + failed collection id
  sets and the underlying reason; export from `packages/db-core/src/index.ts`.
- Widen `coordinateTransaction`'s return type; on commit-phase failure return the
  `committedCollections`/`failedCollections` partition alongside `success:false`.
- Rewrite `commit()`'s catch (`coordinator.ts:199-207`): split committed vs failed local
  handling (committed → success-path fold-to-cache + reset + clearPending; failed →
  restorePending), delete `stampData` for the transaction, then throw
  `CoordinatorPartialCommitError`. Preserve the empty-committed path (restore all + plain
  throw) unchanged.
- Add `committedCollections?` (and optional `failedCollections?`) to `ExecutionResult`;
  populate on `execute()`'s failure return and apply the success-path local treatment to
  the committed subset there.
- Confirm `session.commit()` lets the structured error propagate (no swallow).
- Bridge `commitTransaction` catch: add a session-mode partial-commit branch that
  propagates without `rollbackTransaction()`, mirroring the legacy `PartialCommitError`
  handling; keep clean-rollback only for the genuinely-clean case.
- Tests (db-core):
  - Extend `coordinator.spec.ts` / `transaction.spec.ts` to drive `coordinator.commit()`
    end-to-end with a transactor that commits some collections and permanently fails one
    (reuse/extend `InstrumentedTransactor`, which already forces per-collection commit
    failure). Assert: throws `CoordinatorPartialCommitError`; the error names the correct
    committed vs failed sets; the committed collections' trackers were folded to cache and
    reset (NOT restored to pending); the failed collection's tracker was restored;
    `stampData` was cleared.
  - Assert the empty-committed (PEND-failed or clean commit-failure) path still restores
    every tracker and throws a plain error — no regression to
    `txn-failed-commit-leaves-staged-log-entry`.
- Build + test db-core, streaming output: from `packages/db-core`, run
  `yarn build 2>&1 | tee /tmp/build.log` then `yarn test 2>&1 | tee /tmp/test.log`
  (or narrower `vitest run test/coordinator.spec.ts test/transaction.spec.ts`). Also build
  the quereus plugin package to catch the `ExecutionResult`/bridge changes:
  `yarn build 2>&1 | tee /tmp/plugin-build.log` from
  `packages/quereus-plugin-optimystic`.
