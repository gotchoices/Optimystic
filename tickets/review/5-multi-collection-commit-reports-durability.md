description: A change that touches several collections at once now tells the caller, per collection and overall, whether the whole group of machines holds it or only some of them, the way a single-collection change already does. Review the implementation.
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/db-core/src/transaction/durability.ts (NEW — `TransactionDurability`, `transactionDurability`, `recordCollectionDurability`)
  - packages/db-core/src/transaction/coordinator.ts (`commit`, `commitAttempts`, `refreshBetweenAttempts`, `reportSaved`, `commitOnce`, `commitOnceLatched`, `execute`, `coordinateTransaction`, `pendPhase`, `commitPhase`, `commitCollection`, `cancelPhase`; new module-level `CollectionCommitOutcome`, `CoordinationResult`, `writtenDurability`)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError`)
  - packages/db-core/src/transaction/transaction.ts (`ExecutionResult.durability`)
  - packages/db-core/src/transaction/session.ts (`TransactionSession.commit`)
  - packages/db-core/src/transaction/index.ts (exports)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`DirtyTree.sync` comment only)
  - packages/db-core/test/multi-collection-commit-durability.spec.ts (NEW)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts (one added assertion)
  - packages/db-core/test/coordinator.spec.ts (private-method casts updated for the `Set` → `Map` change)
  - docs/internals.md, docs/optimystic.md, docs/transactions.md
----

# What was built

`TransactionCoordinator.commit` — the write path for a transaction spanning several collections, used by `TransactionSession.commit` and by the Quereus plugin's batched legacy commit — used to return `void`. It now resolves to `TransactionDurability | undefined`:

```ts
type TransactionDurability = {
	readonly collections: ReadonlyMap<CollectionId, WriteDurability | undefined>; // every collection written, across all attempts
	readonly overall?: WriteDurability; // mergeDurability over the values; ABSENT when any value is undefined
};
```

- `undefined` means nothing was written (nothing staged — the read-only stamp — or a retry's replay dropped every staged action), the same hole `Collection.sync` has.
- A collection key with an `undefined` value is saved but its class is unknown (a participant the refresh between attempts finished without re-sending, per `RefreshReport.ownEntryFinished`); `overall` is then absent, never fabricated.
- `CoordinatorPartialCommitError` now takes the committed `Map` in its constructor, keeps `committedCollections` (derived from the map's keys), and gains `durability: TransactionDurability` describing exactly the committed half.
- `ExecutionResult.durability?` is set by `TransactionSession.commit` on success (absent when `commit()` resolved `undefined`) and by `TransactionCoordinator.execute` on success and on its partial-failure return (committed half only).
- `transactionDurability`, `recordCollectionDurability` and the `TransactionDurability` type are exported from the package root.

## Where each class comes from

- `commitCollection` returns the `CommitSuccess.durability` beside `committed: true` (its result is now the discriminated `CollectionCommitOutcome`).
- `commitPhase` builds `committedCollections` as `Map<CollectionId, WriteDurability>`; `coordinateTransaction` returns it on success (new) and failure. Its return is now the named discriminated union `CoordinationResult`, used by both `commitOnceLatched` and `execute`. `pendPhase`'s return also became a discriminated union, which removed two `pendedBlockIds!` assertions.
- `CommitCycle.saved` is `Map<CollectionId, WriteDurability | undefined>`, filled through `recordCollectionDurability` by the refresh (`report.ownEntryFinished.durability`, possibly `undefined`) and by the partial-retry branch of `commitOnceLatched`.
- `commitOnceLatched` / `commitOnce` return the attempt's committed map (empty for nothing-staged). `commitAttempts` folds `cycle.saved` with it and returns `writtenDurability(...)` (undefined when empty); its "refresh saved what was left" early return returns `transactionDurability(cycle.saved)`.
- `reportSaved` merges `cycle.saved` with `err.durability.collections` through `recordCollectionDurability` and hands the merged map to the new constructor.
- `cancelPhase`'s exclusion parameter is now `ReadonlyMap<CollectionId, unknown>` (its only exclusion caller passes the committed map; it only calls `has`).

Every `[...committed]` spread over the old `Set` was revisited: log lines, `execute`'s partial return and both error constructions now use `.keys()` or pass the map. Grep of `committedCollections` / `cycle.saved` in `coordinator.ts` shows no remaining pair-spread.

The two success folds (`commitOnceLatched`, `execute`) stay await-free: the map is returned after the fold, and `execute` builds its `durability` after the fold and the stamp release, with no `await`.

# Tests

New `packages/db-core/test/multi-collection-commit-durability.spec.ts` (`PerCollectionDurabilityTransactor` commits for real on `TestTransactor` and stamps a class per collection, recognised by header block id):

- *reports each collection with its own class, and the weaker one overall* — through `TransactionSession.commit`: `collections` = {A → full, B → majority}, `overall.quorum === 'majority'`, `isFullyDurable(overall) === false`.
- *reports undefined when nothing was staged* — read-only stamp (empty pre-stage barrier) on an already-synced collection: `commit()` resolves `undefined`.
- *reports the committed half on a partial landing* — B's commit throws on all three transport tries, A lands stamped `majority`: `CoordinatorPartialCommitError` with `committedCollections` = [A], `failedCollections` = [B], `durability.collections` = {A → majority}, `overall` = majority.
- *never folds an unknown class into an overall answer* — pure `transactionDurability` over {a → full, b → undefined}: both keys present, `overall` absent; empty map throws.

`coordinator-own-action-replay.spec.ts`, "finishes every half-landed participant of a multi-collection commit": now asserts `commit()`'s result lists both collections with `quorum === 'local'` — the refresh-saved path, the one place a class does not come from `commitCollection`.

`coordinator.spec.ts`: the `commitPhase` / `cancelPhase` cases cast the private methods' types by hand, so their `Set` casts and `[...set]` spreads were updated to the `Map` (`.keys()`), and the `cancelPhase` exclusion case now passes a `Map` like production does. No assertion changed meaning.

Runs: `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` clean; `yarn workspace @optimystic/db-core test` 1886 passing; `yarn workspace @optimystic/quereus-plugin-optimystic test` 1001 passing, 14 pending; `npx tsc --noEmit` in db-core and db-p2p clean; db-p2p's `client-tx-signature.spec.ts` (drives `TransactionSession.commit`) passing. Full db-p2p suite and `test:integration` not run.

# Known gaps and things worth a reviewer's eye

- **Reached only by inspection** (as the plan allowed): the refresh-saved participant with an unknown class flowing through the coordinator (needs a forked lineage end to end); a partial landing retried forward then succeeding (earlier-committed sibling's class carried in `cycle.saved` into the final report); retried forward then failing (`reportSaved` merge with classes); one participant reported twice (merge via `recordCollectionDurability`, documented unreachable at the `reportSaved` NOTE); `execute()`'s partial return carrying the committed half only.
- **A transactor whose success omits `durability`** (type says required, but a hand-rolled test double could return `{ success: true }`): `commitPhase` would store `undefined` under a key typed `WriteDurability`. The fold handles it without crashing — `transactionDurability` treats it as unknown and drops `overall` — but the type lies in that case. All in-repo producers set it; not guarded further.
- `execute()`'s success path calls `writtenDurability`, which returns `undefined` only for an empty committed map; a successful coordination always has at least one committed collection (pend refuses an empty transform set), so in practice `execute` success always carries `durability`.
- The SQL-facing surface is untouched: `commitBatchLegacy` and the session branch of `commitTransaction` in `txn-bridge.ts` still discard the value; the `DirtyTree.sync` comment now points at `backlog/feat-a-sql-commit-reports-durability`.
- `docs/optimystic.md`'s new `TransactionSession` example sits in the *Was it really saved?* section, before the section that introduces `session`; the prose says "(`TransactionSession`, below)".
