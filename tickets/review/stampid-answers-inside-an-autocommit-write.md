description: An insert without an explicit transaction that keys a row with `StampId()` used to store NULL (or be refused by a NOT NULL column); it now stores the stamp of the transaction the statement runs in, including on the first statement after a restart.
architecture: docs/internals.md#the-offline-queue
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`hydrateCatalog`, `registerBridgeConnection`), packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/src/functions/transaction-id.ts, packages/quereus-plugin-optimystic/src/functions/commit-outlook.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md, packages/quereus-plugin-optimystic/test/transaction-id.spec.ts, packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts, packages/quereus-plugin-optimystic/test/lane-on-entry.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-stall.spec.ts
----

# StampId() answers inside an autocommit write

## What shipped

Quereus 5.6.1 was already installed and already carries the engine half: `Statement.run` calls `db._ensureTransaction()` before emitting any plan whose physical properties have side effects, so an autocommit write's transaction is open before the statement's `values` row is computed. `StampId()` and `CommitOutlook()` stayed **synchronous**, and a read-only `select StampId()` in autocommit still answers `NULL` (the engine opens no transaction for a side-effect-free statement). No version bump was needed.

The plugin-side gap this ticket closed was the one the engine change does not cover: Quereus broadcasts that `begin` only to connections registered with the `Database`, and `plugin.hydrate(db)` put the tables back in the engine's catalog while registering none. So the first `insert … values (StampId(), …)` in a restarted process still got NULL.

**`hydrateCatalog` now registers one connection** when it added at least one table (`OptimysticModule.registerBridgeConnection`). Two details worth a reviewer's eye:

- It builds an `OptimysticVirtualTableConnection` **directly** and registers it under one hydrated table's bare name. It deliberately does **not** go through `lookupOrInstantiate` + `ensureConnectionRegistered` (the route the implement ticket sketched): that caches an uninitialized `OptimysticVirtualTable` in the module's table cache, which makes that table's first `connect` return the cached instance and ignore the `tableSchema` Quereus supplies — the schema `connect` is documented to build from. Two cases in `test/init-retry-after-transient-failure.spec.ts` caught exactly that (a hand-built column-less placeholder was never stamped). The direct registration leaves the table cache untouched.
- The options handed to that connection are `hydrateCatalog`'s `deriveDefaultOptions(...)`, whose `collectionUri` is the plugin's schema catalog, not the table's. That is safe because `TransactionBridge.beginTransaction` reads only the binding out of its options (transactor, key network, signer, peer id) and never the URI — and a hydrated table's binding is this session's default anyway, since a catalog record carries none. **This is the assumption most worth re-checking**: if `beginTransaction` ever starts reading `collectionUri`, this connection would begin the bridge against the catalog's collection.
- Registering under a real table's name is what lets that table's first touch **adopt** the connection (`ensureConnectionRegistered` reuses an Optimystic connection already registered for the name) instead of adding a second one.

**Tripwire recorded** (not a ticket): a `NOTE:` on `OptimysticVirtualTableConnection.commit` records that every connection after the first takes the begin-and-commit-an-empty-transaction path at each commit, so each extra registered connection costs one empty begin+commit per later transaction — a `TransactionSession.create` included in session mode. It names the fix if it ever matters (make `commit` a no-op for a transaction a sibling connection already committed) and says this is why hydration registers one connection, not one per table.

## The rule, as documented

Written into `createStampIdFunction`'s doc comment, `createCommitOutlookFunction`'s, README § StampId() Function, the README `CommitOutlook()` paragraph under Offline mode, README § Warm Restart (the `hydrate` paragraph), the `hydrate` jsdoc in `plugin.ts`, and docs/offline-sync.md § Using the outlook before committing:

- Inside an explicit `begin` — that transaction's stamp, from the `begin` on.
- In an autocommit **write** statement, once the `Database` has any Optimystic connection registered (any Optimystic table created, touched, or restored by `hydrate`) — the stamp of the transaction Quereus opens for that statement, whether or not the statement writes an Optimystic table.
- In an autocommit **read** (`select StampId()` alone) — `NULL`.
- On a `Database` with no Optimystic table — `NULL`.

`CommitOutlook()` follows the same rule.

## Use cases to test and validate

- `insert into t (id, body) values (StampId(), 'a')` with no surrounding `begin`, into a table with a `text primary key` — stores the stamp. This was the reported refusal (`NOT NULL constraint failed: t.id`).
- The same statement as the **first** statement of a fresh `Database` over existing storage, after `plugin.hydrate(db)` and with no `create table` and no prior touch of the table.
- Two such autocommit statements in a row — different stamps.
- `select StampId()` alone in autocommit — still `NULL` (the existing case was kept, with a comment saying why).
- An explicit `begin` — unchanged in every respect.
- Any host that counts `db.getConnectionsForTable(...)` after `hydrate` now sees one connection on one hydrated table. That is the one externally visible behaviour change, and it is called out in the `hydrate` jsdoc and the README.

## Tests

| Test | What it pins |
| --- | --- |
| `transaction-id.spec.ts` › Autocommit statements › "stores the stamp of the transaction the write statement runs in" | The reproduction, at the layer it was reported from: an autocommit `insert … values (StampId(), …)` stores a non-NULL id, and that id **equals** the `transactionId` the commit's own `onCommitDurability` report carries — so it is the statement's transaction, not merely some string. |
| `transaction-id.spec.ts` › Autocommit statements › "stores a different stamp for each statement" | Each autocommit statement is its own transaction (two inserts, two distinct stamps). |
| `transaction-id.spec.ts` › "StampId() in a hydrated Database" › "answers the statement transaction stamp for the first write after hydrate" | The hydration half: a second `Database` over shared storage (`buildSharedLocalTransactor`), `hydrate`, then the **first** statement is the autocommit insert. Verified to fail without the fix with exactly the reported `NOT NULL constraint failed: stamped.id`. |
| `committed-read-isolation.spec.ts` › "first-EVER touch of a table as a committed read works and registers nothing" (amended) | Now also pins "hydrate registers ONE connection, not one per hydrated table": it hydrates two tables, asserts exactly one of them is unclaimed, and runs the committed-vs-live contrast on the unclaimed one — so the 0 → 0 → >0 contrast that proves the committed path skips registration is preserved rather than rebased away. |

No test was added for the `NOTE:` tripwire or for the doc wording.

### Tests changed, not added

- `offline-outlook.spec.ts` — dropped the `begin; … commit` from the two single-statement `StampId()` cases that only had it because of this bug ("an insert under StampId() into a table with no fresh tag", "a message under StampId() referencing a conversation"), plus the stale comment on the first. The multi-statement cases keep theirs, and the two cases that use `stampIdOf(db)` to learn the id keep their explicit transaction because that read needs one.
- `lane-on-entry.spec.ts` — same: the first case's two single-statement inserts lost their explicit transactions and the comment that said `StampId()` answers null in autocommit, which is no longer true.
- `committed-read-stall.spec.ts` — two cases took the post-`hydrate` connection count as a baseline instead of asserting `0`, since hydrate may now have claimed the table they examine. Their real claims (the committed read registers nothing of its own; the bridge's collection registry and the open writer transaction stay untouched) are unchanged. A `connectionsOf` helper replaced two inline casts.

## Known gaps / what a reviewer should push on

- **The `options` the bridge connection carries** (above). The reasoning is "`beginTransaction` reads only the binding", verified by reading `beginTransaction`. It is a standing assumption, not an enforced one — there is no test that would fail if `beginTransaction` started reading `collectionUri`.
- **Which hydrated table gets claimed** is `listTables()` order (first wins). Nothing depends on *which* one, but two specs now phrase themselves around the fact that one is claimed. The isolation spec discovers the unclaimed table at run time rather than assuming an order; the stall spec takes a baseline. Neither hard-codes a name.
- **`tables === 0` registers nothing.** A `hydrate` that finds persisted tables already in the catalog (the host declared them itself first) registers no bridge connection — correct, because the declaring path registered one, but it is a path no test exercises directly.
- **Full suite not run** (project rule: review runs it). Commands run are listed below; the specs run include every spec in this package that calls `plugin.hydrate(...)`, since `hydrateCatalog` changed.

## Commands run

From `packages/quereus-plugin-optimystic`:

- `yarn build`
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js <file>` over: `transaction-id`, `offline-outlook`, `lane-on-entry`, `catalog-hydration`, `committed-read-isolation`, `committed-read-stall`, `committed-read-interleave`, `init-retry-after-transient-failure`, `entry-identity`, `hydrate-restores-declared-table`, `secondary-unique-hydrate`, `same-named-tables-across-schemas`, `stale-hydrated-table`, `schema-catalog-open-semantics`, `schema-batch`, `local-transactor-read-cache`, `index-backfill-cost`, `offline-restore`, `offline-mode-network-ack`, `offline-mode-reads`, `session-mode-commit`, `materialized-view-follows-other-writers`, `alter-table-arms`, `deferred-constraint-rollback`, `drop-table-orphan-rows`, `external-commit-visibility-after-rollback`, `index-maintenance-invariant`, `insert-pk-uniqueness`, `legacy-commit-atomicity`, `oldkeyvalues-compact-shape`, `read-error-cause-passthrough`, `read-pull-mechanism`, `savepoint-rollback`, `schema-catalog-index-durability`, `schema-redeclare-column-identity`, `update-pk-move-uniqueness`, `two-node-index-interleaving-sweep`, `two-node-index-mutation-sweep`, `write-description`, `commit-durability` — all passing.

From the repo root: `yarn typecheck`, `yarn lint:docs`, `yarn lint:deps` — all clean.

No pre-existing failures surfaced.
