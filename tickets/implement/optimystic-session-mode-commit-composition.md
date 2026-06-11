description: Cover + repair session/consensus commit composition for the deferred-DML staging refactor in quereus-plugin-optimystic. Add real-DML tests (session + legacy, main table + index, commit + rollback) and fix the disjoint-collections wiring that makes session-mode commit silently drop staged DML.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts
  - packages/quereus-plugin-optimystic/test/deferred-constraint-rollback.spec.ts
  - packages/quereus-plugin-optimystic/test/index-support.spec.ts
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transaction/session.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/collections/tree/tree.ts
difficulty: hard
----

# Verify + repair session-mode commit composition (TransactionBridge staging DML)

## Origin

The deferred-DML staging refactor (Tree.stage/sync/discardChanges, Collection.discardPending,
TransactionBridge.dirtyTrees/markDirty) landed untested inside an unrelated commit (`05faf5f`). It
compiles green and the **legacy** commit/rollback path is well-covered. This ticket finishes the job
for the **session/consensus** commit path, which the code's own comment admits is uncovered — and
which the research below shows is not merely untested but **wired incorrectly**.

## Research findings (the actual bug)

The staging refactor's correctness comment in `txn-bridge.ts:142-149` asserts:

> "the coordinator's commit() reads `tracker.transforms` directly, so we deliberately do NOT
> tree.sync() here — flushing would reset the trackers out from under consensus."

That sentence assumes the coordinator reads the **same** collection trackers the vtab staged into.
In the current wiring that assumption is false:

- `TransactionCoordinator.commit(transaction)` collects transforms by iterating its **own**
  `this.collections` map (`coordinator.ts:111-121`) — the `Map<CollectionId, Collection>` passed to
  its constructor. If a collection's transforms are empty, it is filtered out; if the whole map is
  empty it hits `collectionData.length === 0 → return /* Nothing to commit */` (`coordinator.ts:123`).
- `QuereusEngine.execute()` runs `db.exec(sql)` and **always returns `actions: []`**
  (`quereus-engine.ts:74,90-93`). The real mutations are staged by `OptimysticVirtualTable.update()`
  into `Tree`/`Collection` instances obtained from **`CollectionFactory`** — a set disjoint from the
  coordinator's map. Index trees are created lazily at DML time with a "throwaway txnState", so they
  can never be pre-registered into a coordinator map built earlier.
- Therefore `session.execute(stmt, [])` → `coordinator.applyActions([], stampId)` tracks nothing, and
  at commit `coordinator.commit()` reads its (empty / disjoint) map → **"Nothing to commit"**. Because
  the bridge also deliberately skips `tree.sync()` in session mode, the staged trees never reach
  storage either. **Net result: a committed session-mode transaction persists nothing — DML is
  silently dropped.**
- This path is also **dormant**: there is no production caller of
  `TransactionBridge.configureTransactionMode()` anywhere in the repo — only one detection test in
  `adapter-integration.spec.ts:443-451` that passes `{} as any` mocks and never commits real DML. The
  intended design (docs/optimystic.md §"Transactions Across Collections", docs/transactions.md) is for
  the coordinator to own the collections the engine applies actions to — true for `ActionsEngine`,
  but the `QuereusEngine` path stages into the factory's collections instead, leaving the coordinator
  blind.

## What is already covered (do not re-do)

- **Legacy flush-at-commit, main table + index**: `index-support.spec.ts` ("should maintain index on
  INSERT/UPDATE/DELETE"). These prove `markDirty` captures index trees in legacy mode — a stale index
  query would fail otherwise.
- **Rollback atomicity (legacy) + reopen + no orphaned index entry**:
  `deferred-constraint-rollback.spec.ts` (subquery CHECK rejection on INSERT/UPDATE/PK-change/DELETE,
  against the `local` transactor + real `FileRawStorage`, asserting in-session + reopen + index entry
  counts).

The genuinely missing coverage is: (a) session/consensus commit + rollback end-to-end with real DML,
and (b) an explicit assertion that `discardChanges`/`discardPending` is a safe no-op on an
already-synced or never-staged tree (today only reached implicitly, and the immediate-CHECK
regression test does NOT exercise it because rejection happens before anything is staged).

## Design for the fix

Two candidate approaches; **Approach B is recommended** (it is the documented intent and preserves
the consensus/validation guarantees the session path exists for):

- **Approach A (reject):** in session mode, flush the `dirtyTrees` via `tree.sync()` like legacy. This
  persists, but bypasses the coordinator's GATHER/PEND/COMMIT consensus and cross-collection atomic
  commit + schema validation — defeating the purpose of session mode. Only acceptable as a documented
  stopgap, not a real fix.

- **Approach B (recommended): make the coordinator operate on the same `Collection` instances the
  vtab stages into.** The coordinator's `collections` map must hold the main-table collection and each
  index collection that DML touches, so `coordinator.commit()` reads the staged transforms and the
  deliberate no-`tree.sync()` is then correct. Concretely this needs:
  - A way to obtain the underlying `Collection` from a `Tree` (currently private on
    `Tree`; `db-core/src/collections/tree/tree.ts:9-13`). Add a minimal accessor (e.g. a package-
    internal getter) rather than reaching through `['collection']`.
  - A way to (lazily) register a collection into the coordinator's map as index trees are created
    (`OptimysticVirtualTable.doInitialize`/`addIndex`, `optimystic-module.ts`). Either give
    `TransactionCoordinator` a `registerCollection(id, collection)` method, or have the plugin pass a
    **live shared `Map`** that both the factory-backed vtab and the coordinator reference, so a tree
    created mid-transaction lands in the coordinator's view before commit.
  - A clear owner for coordinator construction in the plugin's session-mode wiring (today nobody
    constructs one for the plugin). Decide whether `configureTransactionMode` should accept a
    coordinator whose collection map the plugin keeps populated, or whether the plugin builds the
    coordinator from its `CollectionFactory`. Keep `QuereusEngine.execute` returning `[]` (mutations
    flow through the vtab) — the fix is about *where the trackers live*, not about making the engine
    return actions.

  Single-collection commits skip GATHER (`coordinator.ts:608`); a main-table + index transaction is
  multi-collection, so GATHER runs but the `test`/`local` transactor exposes no `queryClusterNominees`
  and the coordinator degrades to single-collection consensus (`coordinator.ts:613-616`). PEND/COMMIT
  then run through the `local`/`test` transactor's `StorageRepo`, so a real-DML session test can drive
  genuine consensus in-process without libp2p.

### Escalation valve (honest-gap handoff)

If completing Approach B turns out to require a larger db-core API change or a product decision about
session-mode ownership that exceeds a focused implement pass, land Phase 1 + Phase 3 green, convert
the Phase 2 session-mode assertions to a clearly-commented `it.skip` (or `it` that documents the
expected-fail), and file a `tickets/backlog/` ticket capturing the open design question. Do not leave
the suite red. Be explicit about this in the review/ handoff.

## TODO

### Phase 1 — Reproduce session-mode commit composition (real DML)
- Add a `session-mode-commit.spec.ts` (or extend `adapter-integration.spec.ts`) that wires a real
  `TransactionCoordinator` + `QuereusEngine` and calls `plugin.txnBridge.configureTransactionMode(...)`
  the way a host would, against the `local` transactor + `FileRawStorage` (mirror the `createDb`
  helper in `deferred-constraint-rollback.spec.ts`).
- Drive an explicit `BEGIN; INSERT/UPDATE/DELETE across the main table AND at least one index;
  COMMIT;` and assert the rows + index entries are durably present **in-session and after reopen**
  (reuse `countTreeEntries`/`reopenCount` patterns). With the bug present this fails (silent drop);
  it is the reproduction.

### Phase 2 — Fix session-mode wiring (Approach B) and make Phase 1 pass
- Implement the shared-collection wiring so `coordinator.commit()` reads the vtab's staged trackers
  (Tree→Collection accessor in db-core, coordinator collection registration, plugin coordinator
  ownership). Keep the bridge's no-`tree.sync()` in session mode.
- Add the session-mode **rollback** test: a subquery-bearing CHECK rejection (or explicit ROLLBACK)
  leaves storage untouched — no staged rows, no orphaned index entries — proving the deferred-
  constraint atomicity fix holds in session mode too.
- Once the path is correct, update the stale comment in `txn-bridge.ts:147-149` (drop the
  `fix/optimystic-session-mode-commit-composition` breadcrumb / make it stage-agnostic and reflect the
  now-tested state).

### Phase 3 — Fill the remaining named gaps (cheap, lands green independently)
- Add a focused unit test asserting `Tree.discardChanges()` / `Collection.discardPending()` is a safe
  no-op on (a) a never-staged tree and (b) an already-synced tree — covering the "reset of an empty
  tracker is a no-op" claim that the existing immediate-CHECK regression test does NOT reach.
- Optionally add an explicit assertion that `markDirtyTrees()` registers index trees (the comment
  notes index trees use a throwaway txnState and don't land in `currentTransaction.collections`); a
  legacy-mode insert-then-query already proves flush, but an explicit dirty-set assertion documents
  intent.

### Validation
- Build the package first (tests import from `dist/`): `yarn workspace
  @optimystic/quereus-plugin-optimystic build`, then `... test` (stream with `tee`, do not silently
  redirect). The package is NOT in the root test fan-out — run it directly.
- Run `db-core` tests if Phase 2 touches `coordinator.ts`/`tree.ts`/`collection.ts`:
  `yarn workspace @optimystic/db-core test`.
- Keep `quereus-plugin-optimystic` green. If a failure is plainly pre-existing and outside this diff,
  follow the pre-existing-error protocol (`tickets/.pre-existing-error.md`).
