description: A change that touches several collections at once now tells the caller, per collection and overall, whether the whole group of machines holds it or only some of them, the way a single-collection change already does.
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/db-core/src/transaction/durability.ts (`TransactionDurability`, `transactionDurability`, `recordCollectionDurability`)
  - packages/db-core/src/transaction/coordinator.ts (`commit`, `commitAttempts`, `reportSaved`, `commitOnceLatched`, `execute`, `coordinateTransaction`, `commitPhase`, `commitCollection`, `cancelPhase`; `CollectionCommitOutcome`, `CoordinationResult`, `writtenDurability`)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError.durability`)
  - packages/db-core/src/transaction/transaction.ts (`ExecutionResult.durability`)
  - packages/db-core/src/transaction/session.ts (`TransactionSession.commit`)
  - packages/db-core/src/transaction/index.ts (exports)
  - packages/db-core/test/multi-collection-commit-durability.spec.ts
  - docs/internals.md, docs/optimystic.md, docs/transactions.md
----

# What was built

`TransactionCoordinator.commit` resolves to `TransactionDurability | undefined` instead of `void`:

```ts
type TransactionDurability = {
	readonly collections: ReadonlyMap<CollectionId, WriteDurability | undefined>; // every collection written, across all attempts
	readonly overall?: WriteDurability; // mergeDurability over the values; absent when any value is undefined
};
```

- `undefined` means nothing was written (nothing staged, or a retry's replay dropped every staged action) — the same meaning as `Collection.sync`'s `undefined`.
- A collection with an `undefined` class was saved by the refresh between attempts without learning who holds it; `overall` is then absent rather than fabricated.
- Each collection's class comes from its own `CommitSuccess.durability` (`commitCollection` → `commitPhase` → `coordinateTransaction` → `commitOnceLatched`), or from `RefreshReport.ownEntryFinished.durability` for a participant the inter-attempt refresh finished. `commitAttempts` folds the cycle's saved participants with the final attempt's committed set through `recordCollectionDurability` (an unknown class is never upgraded by a second report; two known classes merge to the weaker).
- `CoordinatorPartialCommitError` takes the committed map, keeps `committedCollections` (its keys), and carries `durability` for exactly the committed half.
- `ExecutionResult.durability` is set by `TransactionSession.commit` on success and by `TransactionCoordinator.execute` on success and on its partial return.
- `transactionDurability` and the `TransactionDurability` type are exported from the package root.

The SQL surface (`commitBatchLegacy`, the session branch of `TransactionBridge.commitTransaction`) still discards the value; that is `tickets/plan/5.5-feat-sql-commit-durability-reaches-the-app.md` (and its overlapping backlog twin `feat-a-sql-commit-reports-durability`).

# Review findings

Read the implement diff (`ticket(implement): multi-collection-commit-reports-durability`) before the handoff, then the touched sources around it.

**Checked, no defect found**

- Every exit of `commitAttempts`: success folds `cycle.saved` with the attempt's committed map; the "refresh saved what was left" early return only runs with `cycle.saved.size > 0`, so `transactionDurability` cannot throw on an empty map there; nothing-staged returns an empty map, giving `undefined` only when nothing was saved either.
- Every `CoordinatorPartialCommitError` construction (two sites, both in `coordinator.ts`) is guarded by a non-empty committed map (`reportSaved` returns the bare error when `cycle.saved` is empty; `commitOnceLatched` throws it only inside `committed.size > 0`), so the constructor's `transactionDurability` cannot throw a different error in place of the partial-commit report.
- Merge semantics: per-collection reports fold through `mergeDurability`, whose `torn` union and clamped inputs keep `isFullyDurable(overall)` false for any torn participant; an unknown class poisons `overall` as documented.
- `CommitSuccess.durability` is a required field, so the handoff's "transactor that omits durability" concern is confined to ill-typed test doubles; no guard needed.
- Type narrowing: `CoordinationResult` and `pendPhase`'s new discriminated union remove two `!` assertions without changing behaviour; `cancelPhase` only calls `has` on its exclusion map.
- Await-freedom of the two success folds (`commitOnceLatched`, `execute`) is preserved — the map is returned and `execute`'s `durability` is built after the fold with no `await`.
- Import hygiene: `durability.ts` imports a sibling subtree barrel type-only and `mergeDurability` directly from its module, so the barrel-cycle rule (`packages/db-core/test/barrel-import-cycle.spec.ts`) is not engaged.
- Docs: `docs/internals.md`, `docs/optimystic.md`, `docs/transactions.md` updated and accurate; no remaining prose claims the coordinator reports no durability (grep of "reports no durability" / the old backlog path outside tickets). The `docs/optimystic.md` example sitting one section before `TransactionSession` is introduced is acceptable — the prose points forward ("`TransactionSession`, below").

**Tests**

- The four cases in `multi-collection-commit-durability.spec.ts` each pin a named piece of the contract (per-collection + weakest overall, `undefined` on nothing staged, committed half on a partial landing, no fabricated `overall`) on code with real branching; kept. The added assertion in `coordinator-own-action-replay.spec.ts` pins the one path where the class comes from the refresh; kept. The `coordinator.spec.ts` changes are mechanical type updates; no assertion changed meaning.
- No test added: the paths the handoff reached only by inspection (refresh-saved with unknown class end to end, partial landing retried forward then succeeding or failing) were traced by reading and are covered at the unit level by `recordCollectionDurability`/`transactionDurability` semantics; an end-to-end test for each would need a forked lineage fixture and would mostly restate the fold.

**Fixed in this pass (minor)**

- Removed `recordCollectionDurability` from the package's public exports (`packages/db-core/src/transaction/index.ts`): it is an internal, mutating merge helper used only inside the coordinator, and exporting it widened the API for no consumer.
- `tickets/plan/5.5-feat-sql-commit-durability-reaches-the-app.md` named this ticket's prereq as `feat-multi-collection-commit-reports-durability`, a slug the plan stage renamed; corrected to `multi-collection-commit-reports-durability`, and appended a note that its `files:` claim about the coordinator dropping durability is now stale and that backlog `feat-a-sql-commit-reports-durability` covers the same question and should be folded in.

**Major / tickets filed:** none — no finding met the filing bar.

**Tripwires:** none added. The existing `NOTE:` in `reportSaved` (a participant reported in exactly one list) already covers the only conditional interaction with the durability merge.

**Runs:** `yarn build`, `yarn lint`, `yarn lint:docs`, `yarn typecheck` clean; `yarn workspace @optimystic/db-core test` 1886 passing. Not re-run in review: the quereus plugin suite (its only change was a comment, and the export removal touches nothing it imports), the full db-p2p suite, and `yarn test:integration`.
