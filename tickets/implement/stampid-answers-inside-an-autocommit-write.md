description: An insert run outside an explicit transaction that keys or tags a row with `StampId()` stores NULL, or is refused by a NOT NULL column, because the id is computed before the transaction starts; once Quereus starts the transaction first, make sure Optimystic's transaction is open by then too, and fix the docs and tests.
prereq: quereus-begins-a-write-statements-transaction-before-evaluating-it
architecture: docs/internals.md#the-offline-queue
files: packages/quereus-plugin-optimystic/src/functions/transaction-id.ts, packages/quereus-plugin-optimystic/src/functions/commit-outlook.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts (`hydrateCatalog`, `lookupOrInstantiate`, `OptimysticVirtualTable.ensureConnectionRegistered`), packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md, packages/quereus-plugin-optimystic/test/transaction-id.spec.ts, packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts
difficulty: medium
repro: verified
----

# StampId() answers inside an autocommit write

## The bug

```sql
create table t (id text primary key, body text) using optimystic('tree://test/t');
insert into t (id, body) values (StampId(), 'a');   -- no surrounding begin
-- NOT NULL constraint failed: t.id
```

Reproduced with the `test` transactor (a scratch spec, since deleted). `StampId()` (`createStampIdFunction` in `packages/quereus-plugin-optimystic/src/functions/transaction-id.ts`) answers NULL unless `TransactionBridge.getCurrentTransaction()` is active, and the bridge's transaction opens when Quereus calls the vtab connection's `begin` (`OptimysticVirtualTableConnection.begin`). The ticket's first guess was that `begin` comes late. It does not: Quereus calls it from `runInsert`'s `_ensureTransaction()`, before any row reaches the vtab. The rows of a `values` list are computed earlier still, as scheduler instructions that feed the insert instruction, so `StampId()` runs before the statement has a transaction at all. `insert … select StampId(), 'a'` already works, because its rows are pulled after the transaction began. The full table of shapes, and the Quereus change this needs, are in the prereq.

`CommitOutlook()` (`createCommitOutlookFunction` in `packages/quereus-plugin-optimystic/src/functions/commit-outlook.ts`) uses the same guard and fails the same way.

## What changes once the prereq lands

The prereq is expected to land as its recommended option: Quereus begins a write statement's implicit transaction before evaluating it. That broadcasts `begin` to every connection registered with the `Database`, so the bridge is open before `values` is computed, as long as an Optimystic connection is registered by then. If Quereus instead publishes `DatabaseInternal.ensureTransaction()`, make both functions async: when the bridge has no active transaction and `db._isExecuting()`, await it, then answer as today. A prototype of that worked.

**The remaining gap: the first statement after `hydrate`.** A connection is registered at `create table` and at a table's first touch (`OptimysticModule.connect`, inside `runInsert`'s `getVTable`). After a restart, `plugin.hydrate` puts the tables back in the engine's catalog but registers no connection. So the first `insert … values (StampId(), …)` in a new process begins Quereus's transaction with no Optimystic connection listening, and `StampId()` is still NULL. A prototype confirmed that half: with the transaction begun early, the hydrated case still failed. Close it in `hydrateCatalog`: when it adds at least one table, instantiate one of them without initializing it (`lookupOrInstantiate`, which does no I/O) and call `ensureConnectionRegistered`. One connection is enough, because every Optimystic connection drives the same `TransactionBridge`, and every hydrated table has the session's default options (`deriveDefaultOptions` in `hydrateCatalog`), so the bridge begins with the transactor any of them would use. Do not register one per hydrated table. `OptimysticVirtualTableConnection.commit` begins and commits an empty bridge transaction when the bridge is no longer active, which is what every connection after the first does at a commit. So each extra registered connection adds one empty begin and commit to every later transaction, a call to `TransactionSession.create` included in session mode. Leave a `NOTE:` at `commit` recording that cost.

**What `StampId()` answers, as decided here:**

- Inside an explicit transaction: its stamp, as today.
- In an autocommit statement, once any Optimystic connection is registered with the `Database` (any Optimystic table created, touched or hydrated in it): the stamp of that statement's transaction. This holds whether or not the statement writes an Optimystic table, just as an explicit `begin` already gives every transaction a stamp. Under the recommended option, a read-only `select StampId()` in autocommit stays NULL, because Quereus opens no transaction for it. Under the alternative, it answers a fresh stamp for each statement. Write down whichever one shipped.
- A `Database` with no Optimystic table: NULL. There is no Optimystic transaction to name.

`CommitOutlook()` follows the same rule.

## TODO

- Read the prereq's resolution, confirm which Quereus capability shipped, and bump `@quereus/quereus` (dev and peer ranges, and `engines.quereus`, kept equal; see AGENTS.md § Dependencies).
- Add the reproduction to `test/transaction-id.spec.ts`: an autocommit `insert into t (id, body) values (StampId(), 'a')` stores a non-NULL id that equals the transaction id the commit-durability report carries, or at least differs between two such statements. Add one case after `hydrate` in a new `Database` over shared storage, using the helper pattern in `test/catalog-hydration.spec.ts` (`buildSharedLocalTransactor`). If the alternative option shipped, update the existing "should return NULL when not in a transaction" case to the new answer.
- If the alternative option shipped: make `createStampIdFunction` and `createCommitOutlookFunction` async and await `ensureTransaction()` as described. Quereus resolves an async scalar (`MaybePromise<SqlValue>` in `@quereus/quereus/src/runtime/emit/scalar-function.ts`).
- `hydrateCatalog`: register one connection when it added a table. Put a `NOTE:` at `OptimysticVirtualTableConnection.commit` about the empty begin and commit each extra connection costs.
- Docs: `StampId()`'s doc comment, README § StampId() Function, and the `CommitOutlook()` paragraph in README § Offline mode (it says "outside one it answers `NULL`, like `StampId()`"), plus the matching sentence in docs/offline-sync.md §Using the outlook before committing. State the rule above. Keep the README's `values (StampId(), :body)` example, which becomes true.
- Drop the explicit `begin; … commit` that exists only for this from `test/offline-outlook.spec.ts`: the single-statement cases at "an insert under StampId() into a table with no fresh tag is assured", with its comment "in an autocommit statement StampId() is evaluated before the…", and "a message under StampId() referencing a conversation". Keep the ones that group several statements. `test/write-description.spec.ts` uses memory tables and a description hook, not a commit, and needs no change.
- Run `yarn build` and then `yarn test` in `packages/quereus-plugin-optimystic`.
