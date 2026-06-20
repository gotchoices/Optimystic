description: When a transaction that wrote to more than one collection is automatically undone as part of a cascade, only one of its collections actually gets undone — the others are silently left with the bad data still committed.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/test/cascade.spec.ts
difficulty: medium
----

# Fix: cascade reverts a multi-collection dependent in only one of its collections

## Symptom

`cascadeInvalidate` (`packages/db-p2p/src/dispute/cascade.ts`) dedups invalidated transactions by
`actionId` alone (`invalidatedIds: Set<ActionId>`). In Optimystic a transaction that touches multiple
collections is written to **every** affected collection's log under the **same** `actionId`
(`TransactionCoordinator.commitToCollection` calls `log.addActions(..., transaction.reads)` per
collection; the actionId is `transaction.id`). Each collection's log entry carries that collection's own
`blockIds` (the blocks the transaction wrote *there*) but the same full read set.

When such a transaction is a cascade read-dependent, it appears as a separate `CascadeCandidate` for each
collection it spans (same `actionId`, different `collectionId`/`blockIds`/`rev`). The engine processes the
first one (lowest `(rev, collectionId)` per the sort), calls `applyInvalidation` against that one
collection's log + blockIds, then adds `actionId` to `invalidatedIds`. Every other collection-entry for the
same transaction is then skipped at the top of the candidate loop
(`if (invalidatedIds.has(cand.actionId)) continue;`) and at `collectCandidates`' exclusion
(`invalidatedIds.has(action.actionId)`). **Result: the transaction's writes in all but one collection are
never reverted, and no child `InvalidationEntry` is appended there — the bad revisions stand, undetected.**

This is a silent partial reversal: the cascade reports the dependent as `invalidated`, the operator sees no
escalation, but a subset of the transaction's blocks remain committed-but-invalid.

## Reproduction (confirmed during 7.6 review)

A two-collection harness where one transaction `t2` writes block `P` in collection `A` (rev 3) and block
`Q` in collection `B` (rev 2), both reading the root's invalidated `X@2`. After
`cascadeInvalidate`, collection `A` holds only the root invalidation entry (1 total) — `t2`'s `P` write was
never reverted — while only collection `B` got `t2`'s child entry. Expected: both collections carry a
child invalidation entry for `t2` (A: root + t2 = 2; B: t2 = 1). Add this as a regression test in
`cascade.spec.ts`.

## Required behaviour

A multi-collection dependent must be reverted in **every** collection it wrote to: each collection-entry of
the transaction gets its own `applyInvalidation` (against that collection's log and its local `blockIds`),
producing one child `InvalidationEntry` per collection, and each collection's reverted blocks must feed the
frontier.

## Specification / direction

- The "have I already reverted this entry" identity is per **`(collectionId, actionId)`**, not `actionId`
  alone. The candidate-loop skip, the `collectCandidates` exclusion, and the children dedup should key on
  the pair so that the same transaction's entry in a *different* collection is still processed.
- Preserve the existing single-collection semantics that the current tests cover: the diamond case (one
  entry, one collection, matched against two ancestors) must still evaluate exactly once; the idempotent
  restart must still dedup per collection-entry (no duplicate child entries on re-run).
- The forward-DAG guard (`assertForwardOnly`) is already per-collection (it only compares revs within the
  same collection), so it is unaffected — but confirm cross-collection edges of the *same* transaction don't
  trip it.
- Tests to add: the multi-collection-dependent reversal above; an idempotent restart of a multi-collection
  dependent (re-run produces no duplicate child entries in either collection); a multi-collection dependent
  under `maxCascadeTransactions` (decide and document whether the horizon counts the transaction once or
  once-per-collection-entry — the root counts once today).

## Scope notes

The engine is not yet wired into a live composition root (handoff gap #4), so this is a latent defect rather
than a live data-loss bug today — but it must be closed before the cascade is wired, because multi-collection
transactions are a first-class Optimystic primitive and a partial reversal violates the same
all-or-nothing guarantee the root reversal relies on.
