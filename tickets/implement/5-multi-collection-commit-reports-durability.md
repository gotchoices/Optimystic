description: A change that touches several collections at once should tell the caller, per collection and overall, whether the whole group of machines holds it or only some of them, the way a single-collection change already does. Today the multi-collection commit answers with a bare "it worked".
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/db-core/src/transaction/durability.ts (NEW — `TransactionDurability` and its fold)
  - packages/db-core/src/transaction/coordinator.ts (`commit`, `commitAttempts`, `refreshBetweenAttempts`, `reportSaved`, `commitOnce`, `commitOnceLatched`, `execute`, `coordinateTransaction`, `commitPhase`, `commitCollection`, the `CommitCycle` type)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError`)
  - packages/db-core/src/transaction/transaction.ts (`ExecutionResult`)
  - packages/db-core/src/transaction/session.ts (`TransactionSession.commit`)
  - packages/db-core/src/transaction/index.ts (exports)
  - packages/db-core/src/network/durability.ts (`mergeDurability`, reused as-is)
  - packages/db-core/src/collection/collection.ts (`RefreshReport.ownEntryFinished.durability`, read only)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`DirtyTree.sync` comment only)
  - packages/db-core/test/multi-collection-commit-durability.spec.ts (NEW)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts (one added assertion)
  - docs/internals.md, docs/optimystic.md, docs/transactions.md
----

# What this builds

`Collection.sync` answers with the `WriteDurability` of what it committed (`packages/db-core/src/network/struct.ts`): whether every machine in the block's cohort holds the write (`full`), a strict majority (`majority`), only this machine (`local`), or a machine whose cohort never resolved (`unrouted`). `TransactionCoordinator.commit` — the path for a write that spans several collections, used by `TransactionSession.commit` and by the Quereus plugin's batched legacy commit — returns `void`, so its caller cannot tell a fully held transaction from one only its own machine holds. A `NOTE:` at `commit` says so.

The per-collection answer already exists: every successful `transactor.commit` inside `commitCollection` returns a `CommitSuccess` whose `durability` is required, and the refresh between attempts records a saved participant's durability in `RefreshReport.ownEntryFinished.durability`. The coordinator drops both. This ticket keeps them and reports them.

## The design decisions (settled)

**1. The answer is per collection, with one overall class derived from it.** A new type in a new file `packages/db-core/src/transaction/durability.ts`:

```ts
/** What a multi-collection commit wrote, and who holds it. */
export type TransactionDurability = {
	/** Every collection this commit durably wrote, across all of its attempts, with who holds it.
	 *  A key present with an `undefined` value means the collection IS saved, but the layer that
	 *  recognised it as saved could not say who holds it (see "unknown class" below). Test with
	 *  `has`, never with `get(...) !== undefined`, for "was it written". Never empty. */
	readonly collections: ReadonlyMap<CollectionId, WriteDurability | undefined>;
	/** `mergeDurability` over every value in `collections` — the weakest class, so a caller that
	 *  reads only this is reading the binding constraint. ABSENT when any collection's class is
	 *  unknown: the overall answer is never fabricated, and a caller testing
	 *  `overall !== undefined && isFullyDurable(overall)` then shows the transaction as pending. */
	readonly overall?: WriteDurability;
};

/** Builds a TransactionDurability from what each collection reported. Throws on an empty map
 *  (same reason mergeDurability does: something was written, or there is no report at all). */
export function transactionDurability(collections: ReadonlyMap<CollectionId, WriteDurability | undefined>): TransactionDurability;

/** Merges one more report for a collection into a per-collection map: absent → set; either side
 *  `undefined` → `undefined` (unknown dominates); both known → `mergeDurability([prev, next])`. */
export function recordCollectionDurability(into: Map<CollectionId, WriteDurability | undefined>, id: CollectionId, d: WriteDurability | undefined): void;
```

Why weakest-wins is right for `overall`, despite the original worry that it might not be: the worry was about the coordinator ending with some collections committed and others dropped. That case never produces a *successful* return — it throws `CoordinatorPartialCommitError` (decision 3). On a successful return every participant is saved, so "is the whole transaction held by everyone" is exactly "is every collection held by everyone", which is the weakest-wins merge. `mergeDurability` also unions `torn` across collections, which is right: a block one collection's commit abandoned is abandoned for the transaction. Per-collection detail lives in `collections`; `overall.otherCohorts` is whatever `mergeDurability` produces and needs no special handling.

Rejected: a single class with no per-collection breakdown (loses which collection is behind, which a repair or display needs); a per-collection map with no overall (every simple caller would re-implement the fold, and some would get the unknown case wrong).

**2. `commit()` resolves to `TransactionDurability | undefined`; `undefined` means nothing was written.** This mirrors `Collection.sync` exactly: a commit with nothing staged (the read-only stamp, or every staged action dropped by a conflict filter during a retry's replay) does no pend and no commit and has no class to report. Every other successful return carries a `TransactionDurability`.

**3. A partial landing reports the committed half's durability on the error.** `CoordinatorPartialCommitError` gains `readonly durability: TransactionDurability`, describing exactly its committed collections. Its constructor takes the committed map instead of the committed id list: `constructor(committed: ReadonlyMap<CollectionId, WriteDurability | undefined>, failedCollections, reason?)`, and keeps `committedCollections` as a field derived from the map's keys (every existing reader of `committedCollections` is unchanged; the only two `new CoordinatorPartialCommitError(` sites are in `coordinator.ts`; no test constructs one). The map is never empty for this error, so `transactionDurability` cannot throw there.

**4. `ExecutionResult` carries it, as `durability?: TransactionDurability`.** This settles the question the plan ticket raised. Rule: present whenever something was written — `TransactionSession.commit` on success (absent when `commit()` resolved `undefined`), and `TransactionCoordinator.execute` on success and on its partial-failure return (there it describes exactly `committedCollections`). Absent on a failure where nothing landed. Document the field beside `committedCollections` on `ExecutionResult`.

**5. Unknown class is reachable, rarely, and is reported as unknown.** A participant saved by the refresh between attempts reports `ownEntryFinished` with `durability` absent in two cases, both documented in `Collection.completeOwnEntry` and `Collection.settleUnfinished` (the status-read fallback on a forked lineage, and a lineage answer whose log-block cohort could not vouch). `cycle.saved` must record that participant with an `undefined` value, not leave it out (it IS saved and must be in `collections`), and `overall` is then absent.

## Where each participant's class comes from

The coordinator collects one `Map<CollectionId, WriteDurability | undefined>` per commit, through `recordCollectionDurability`:

- **`commitCollection`** — on success, return `durability: commitResult.durability` beside `committed: true`. `commitPhase` builds `committedCollections` as a `Map<CollectionId, WriteDurability>` instead of a `Set` (it is only ever built from successes, so every value is known), and `coordinateTransaction` passes it through on both its success return (add `committed` there — today success returns `{ success: true }` only) and its failure return.
- **A successful attempt** (`commitOnceLatched`'s success fold) — returns the attempt's committed map to `commitOnce`, which returns it to `commitAttempts`. `commitOnce`'s nothing-staged early return returns an empty map.
- **A partial landing retried forward** (the `coordResult.staleLoss` branch of `commitOnceLatched`) — records each committed collection's class into `cycle.saved` instead of adding bare ids.
- **A partial landing on a hard failure** — builds the error from `coordResult.committedCollections`' map (plus nothing else: `cycle.saved` is merged later by `reportSaved`).
- **The refresh between attempts** — `refreshBetweenAttempts` records `report.ownEntryFinished.durability` (possibly `undefined`) into `cycle.saved` instead of adding a bare id.

`CommitCycle.saved` therefore becomes `Map<CollectionId, WriteDurability | undefined>`. Its doc comment's claim that "a successful attempt … records nothing here" stays true — the success path's map is returned, not stored. `commitAttempts` resolves to:

- on `commitOnce` success: `cycle.saved` folded with the attempt's map (via `recordCollectionDurability`); `undefined` if the combined map is empty, otherwise `transactionDurability(combined)`.
- on the early return where the refresh saved what was left (`cycle.saved.size > 0 && stagedCollections().length === 0`): `transactionDurability(cycle.saved)`.

`reportSaved` merges `cycle.saved` with `err.durability.collections` when `err` is itself a partial (today it merges id sets; it now merges maps through `recordCollectionDurability`), and passes the merged map to the new constructor.

A collection reported twice in one commit (saved by a refresh, then committed again by a later attempt because it held actions staged after its first attempt began — the case the `NOTE:` in `reportSaved` calls unreachable) merges through `recordCollectionDurability`: unknown dominates, otherwise weakest-wins. Do not add code for that case beyond what the helper does.

## Surfaces

- `TransactionCoordinator.commit(transaction, options?): Promise<TransactionDurability | undefined>`. Replace the `NOTE:` on `commit` (which points at this ticket) with documentation of the return and of `undefined`.
- `TransactionSession.commit` — `const durability = await this.coordinator.commit(...)`; return `{ success: true, ...(durability === undefined ? {} : { durability }) }`.
- `TransactionCoordinator.execute` — build `durability` from `coordResult.committedCollections` on success and on partial failure, per decision 4.
- Export `TransactionDurability`, `transactionDurability` and `recordCollectionDurability` from `packages/db-core/src/transaction/index.ts`, so they reach the package root.
- `txn-bridge.ts`: `commitBatchLegacy` and the session branch of `commitTransaction` keep discarding the value — the SQL-facing surface is `backlog/feat-a-sql-commit-reports-durability`. Update the `DirtyTree.sync` comment, which currently points at this ticket, to point at that one instead. `commitBatchLegacy` awaits `coordinator.commit(...)` without using its value, which needs no change.

## Docs

- `docs/internals.md`, *Commit Path*: the closing sentence of the `WriteDurability` paragraph ("`TransactionCoordinator.commit` is the one write path that reports no class") becomes a description of `TransactionDurability`: per collection, `overall` as the weakest, absent when a class is unknown, `undefined` for nothing written, and the partial-commit error carrying the committed half's.
- `docs/optimystic.md`, *Was it really saved?*: replace the "reports no durability yet" paragraph with a short `TransactionSession` example reading `result.durability?.overall` through `isFullyDurable`, plus the one-line rule that an absent `overall` on a present `durability` means "saved, but who holds it is unknown — show as pending".
- `docs/transactions.md`, *Honest-reporting contract* inside "Session-mode (distributed) commit is not atomic across collections either": one sentence that the error's `durability` says how well the committed half landed.
- Run `yarn lint:docs`.

## Edge cases & interactions

- **Nothing staged** (read-only stamp; or a retry's replay dropped every action) → `commit()` resolves `undefined`; `TransactionSession.commit` returns no `durability`. Verified by a test (below).
- **Two collections, different classes** → `collections` names both with their own classes; `overall` is the weaker. Verified by a test.
- **A collection whose commit abandoned blocks** (`torn` on its report) → `overall.torn` contains them and `isFullyDurable(overall)` is false even if every quorum is `full`. Holds by `mergeDurability`'s existing union; verified by inspection (it is `mergeDurability`'s own contract, already tested there).
- **Refresh-saved participant with a known class** → appears in `collections` with the re-send's class. Verified by one added assertion in `coordinator-own-action-replay.spec.ts` (below).
- **Refresh-saved participant with unknown class** → appears with `undefined`, `overall` absent. Verified by a pure test of `transactionDurability` (below); the coordinator side is verified by inspection (record the `undefined`, do not skip the key) because reaching it end to end needs a forked lineage.
- **Partial landing on a hard failure** → `CoordinatorPartialCommitError.durability.collections` names exactly the committed collections with their classes; `committedCollections` still lists the same ids. Verified by a test.
- **Partial landing retried forward, then success** → the earlier-committed collection appears in the final `collections` with the class from the attempt that committed it, not missing. Verified by inspection of the fold in `commitAttempts`; the shape is the same `cycle.saved` read the hard-failure test exercises.
- **Partial landing retried forward, then failure** → `reportSaved` merges `cycle.saved` (with classes) into the error. Verified by inspection.
- **A participant reported by both `cycle.saved` and a later attempt** → merged by `recordCollectionDurability`; unknown dominates. Verified by inspection; documented unreachable today.
- **`execute()` partial return** → `durability` describes `committedCollections` only, never the failed ones. Verified by inspection.
- **`Set` → `Map` for `committedCollections`**: every reader of the old `Set` must be revisited, not just retyped. `[...committed]` on a `Map` spreads `[id, durability]` pairs, not ids — `commitOnceLatched` (both partial branches and its log lines) and `execute`'s partial return both spread it today; use `[...committed.keys()]`. `cancelPhase(…, excludeCollections?: Set<CollectionId>)` only calls `has`; widen its parameter to `ReadonlySet<CollectionId> | ReadonlyMap<CollectionId, unknown>` or pass `new Set(map.keys())`. The compiler will not catch a spread into a `CollectionId[]`-typed slot if it is inferred loosely, so grep `committedCollections` and `committed` in `coordinator.ts` after the change. Verified by the hard-partial test (`committedCollections` deep-equals `[A]`) and by inspection.
- **Await-free folds**: the success fold in `commitOnceLatched` and in `execute` must stay await-free (their `NOTE:`s say why). Building the returned map adds no `await`; check this in review.
- **No behaviour change**: the same commits succeed, fail, retry and roll back as before; only return values and one error field widen. The existing coordinator suites passing unchanged is the check.

## Tests (the few that pay)

New `packages/db-core/test/multi-collection-commit-durability.spec.ts`, using a `DelegatingTransactor` subclass in the style of `StampedDurabilityTransactor` in `packages/db-core/test/write-durability-reaches-the-writer.spec.ts` — commit for real on the inner `TestTransactor`, then replace `durability` on a success. Stamp per collection by recognising the collection's header block id (the collection id) in `request.blockIds`, which a brand-new collection's first commit always includes; or by `request.tailId` if that proves simpler.

- *Two collections, stamped `full` and `majority`*: `commit()` resolves with `collections` = {A → full stamp, B → majority stamp} and `overall.quorum === 'majority'`, `isFullyDurable(overall) === false`. Through `TransactionSession.commit`, `result.durability` is the same value.
- *Nothing staged*: `commit()` of a transaction that staged nothing resolves `undefined`.
- *Hard partial landing*: B's commit throws on every try (three transient failures exhaust `commitCollection`'s retry), A's lands with a stamped class → `CoordinatorPartialCommitError` whose `durability.collections` has exactly A with its stamp, and `committedCollections` deep-equals `[A]`.
- *Pure fold*: `transactionDurability` over {A → full, B → undefined} has `overall` absent and both keys in `collections`; over an empty map it throws.

In `packages/db-core/test/coordinator-own-action-replay.spec.ts`, the case "finishes every half-landed participant of a multi-collection commit": capture `commit()`'s result and assert both `idA` and `idB` are in `collections` with `quorum === 'local'` (what the inner `TestTransactor` reports for the refresh's re-send). This pins the refresh-saved path, the one place the class comes from somewhere other than `commitCollection`.

No other new tests. Do not test the exports, the `ExecutionResult` field's presence beyond the one session assertion above, or `recordCollectionDurability` separately (its branches are exercised through the cases above and by inspection).

## TODO

- Add `packages/db-core/src/transaction/durability.ts` with `TransactionDurability`, `transactionDurability`, `recordCollectionDurability`; export from `transaction/index.ts`.
- `commitCollection` returns the success's `durability`; `commitPhase` builds a committed `Map`; `coordinateTransaction` returns it on success and failure.
- `CommitCycle.saved` → `Map<CollectionId, WriteDurability | undefined>`; update `refreshBetweenAttempts`, the partial-retry branch of `commitOnceLatched`, the early-return check in `commitAttempts`, and their doc comments.
- `commitOnce` / `commitOnceLatched` return the attempt's committed map; `commitAttempts` and `commit` return `TransactionDurability | undefined`.
- `CoordinatorPartialCommitError` takes the committed map, gains `durability`, keeps `committedCollections`; update both construction sites and `reportSaved`'s merge.
- `ExecutionResult.durability`; populate in `TransactionSession.commit` and `TransactionCoordinator.execute` (success and partial).
- Replace the `NOTE:` on `TransactionCoordinator.commit`; repoint the `DirtyTree.sync` comment in `txn-bridge.ts` at `feat-a-sql-commit-reports-durability`.
- Write the new spec and the one added assertion.
- Update `docs/internals.md`, `docs/optimystic.md`, `docs/transactions.md`; `yarn lint:docs`.
- `yarn build`, `yarn typecheck`, `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/quereus-plugin-optimystic test` (the bridge compiles against the widened types).
