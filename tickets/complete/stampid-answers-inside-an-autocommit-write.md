description: An insert without an explicit transaction that keys a row with `StampId()` used to store NULL (or be refused by a NOT NULL column); it now stores the stamp of the transaction the statement runs in, including on the first statement after a restart.
architecture: docs/internals.md#the-offline-queue
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`hydrateCatalog`, `registerBridgeConnection`), packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`beginTransaction`), packages/quereus-plugin-optimystic/src/functions/transaction-id.ts, packages/quereus-plugin-optimystic/src/functions/commit-outlook.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md, .release-notes.pending.md, packages/quereus-plugin-optimystic/test/transaction-id.spec.ts, packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts, packages/quereus-plugin-optimystic/test/lane-on-entry.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-stall.spec.ts
----

# StampId() answers inside an autocommit write

## What shipped

Quereus 5.6.1, already installed, carries the engine half: `Statement.run` calls `db._ensureTransaction()` before emitting any plan whose physical properties have side effects, so an autocommit write's transaction is open before the statement's `values` row is computed. `StampId()` and `CommitOutlook()` stayed synchronous, and a read-only `select StampId()` in autocommit still answers `NULL` — the engine opens no transaction for a side-effect-free statement. No version bump was needed.

The plugin-side gap this ticket closed is the one the engine change does not cover: Quereus broadcasts that `begin` only to connections registered with the `Database`, and `plugin.hydrate(db)` put the tables back in the engine's catalog while registering none. So the first `insert … values (StampId(), …)` in a restarted process still got NULL, which a `text primary key` refused with `NOT NULL constraint failed: t.id`.

**`hydrateCatalog` now registers one connection** when it added at least one table and the `Database` has no Optimystic connection yet (`OptimysticModule.registerBridgeConnection`). It builds an `OptimysticVirtualTableConnection` directly, under one hydrated table's name, and deliberately does not go through `lookupOrInstantiate` + `ensureConnectionRegistered`: that caches an uninitialized `OptimysticVirtualTable` in the module's table cache, which makes that table's first `connect` return the cached instance and ignore the `tableSchema` Quereus supplies — the schema `connect` is documented to build from. Registering under a real table's name is what lets that table's first touch adopt the connection rather than add a second one.

The options handed to that connection are `hydrateCatalog`'s `deriveDefaultOptions(...)`, whose `collectionUri` is the plugin's schema catalog rather than the table's. That is safe because `TransactionBridge.beginTransaction` reads only the binding out of its options (transactor, key network, libp2p node, signer) and never the URI — and a hydrated table's binding is this session's default anyway, since a catalog record carries none.

## The rule, as documented

Written into `createStampIdFunction`'s doc comment, `createCommitOutlookFunction`'s, README § StampId() Function, the README `CommitOutlook()` paragraph under Offline mode, README § Warm Restart, the `hydrate` jsdoc in `plugin.ts`, and docs/offline-sync.md § Using the outlook before committing:

- Inside an explicit `begin` — that transaction's stamp, from the `begin` on.
- In an autocommit **write** statement, once the `Database` has any Optimystic connection registered (any Optimystic table created, touched, or restored by `hydrate`) — the stamp of the transaction Quereus opens for that statement, whether or not the statement writes an Optimystic table.
- In an autocommit **read** (`select StampId()` alone) — `NULL`.
- On a `Database` with no Optimystic table — `NULL`.

`CommitOutlook()` follows the same rule.

One externally visible behaviour change: a host that counts `db.getConnectionsForTable(...)` after `hydrate` now sees one connection on one hydrated table. It is called out in the `hydrate` jsdoc and the README.

## Tests

| Test | What it pins |
| --- | --- |
| `transaction-id.spec.ts` › Autocommit statements › "stores the stamp of the transaction the write statement runs in" | The reproduction, at the layer it was reported from: an autocommit `insert … values (StampId(), …)` stores a non-NULL id, and that id equals the `transactionId` the commit's own `onCommitDurability` report carries — so it is the statement's transaction, not merely some string. |
| `transaction-id.spec.ts` › Autocommit statements › "stores a different stamp for each statement" | Each autocommit statement is its own transaction (two inserts, two distinct stamps). |
| `transaction-id.spec.ts` › "StampId() in a hydrated Database" › "answers the statement transaction stamp for the first write after hydrate" | The hydration half: a second `Database` over shared storage, `hydrate`, then the first statement is the autocommit insert. Verified by the implementer to fail without the fix with exactly the reported `NOT NULL constraint failed: stamped.id`. |
| `committed-read-isolation.spec.ts` › "first-EVER touch of a table as a committed read works and registers nothing" (amended) | Also pins "hydrate registers one connection, not one per hydrated table": it hydrates two tables, asserts exactly one is unclaimed, and runs the committed-vs-live contrast on the unclaimed one, so the 0 → 0 → >0 contrast that proves the committed path skips registration is preserved rather than rebased away. |

`offline-outlook.spec.ts`, `lane-on-entry.spec.ts` and `committed-read-stall.spec.ts` had cases amended rather than added: explicit `begin … commit` wrappers (and the comments explaining them) dropped from single-statement `StampId()` cases that only carried them because of this bug, and two post-`hydrate` connection counts turned from `0` into a captured baseline, since hydrate may now have claimed the table they examine. Their real claims are unchanged.

## Review findings

Read the `ticket(implement): stampid-answers-inside-an-autocommit-write` diff before the handoff.

### Checked

- **The central assumption the handoff flagged** — that `beginTransaction` reads only the binding out of the options it is handed, never `collectionUri`. Confirmed by reading `beginTransaction` and every options consumer it reaches: `getOrCreateTransactor` → `getTransactorKey` (`transactor:keyNetwork`), `getPeerId` → `getNodeKey` (`networkName:port`), `getBlockDurabilityNotifier`, `getSigner`. None reads the URI. The assumption holds today and is now recorded where it could break (below).
- **Connection naming against the engine's convention.** Quereus's own module names its connections `schema.table` (`MemoryVirtualTableConnection`); this plugin names them bare, at all three of its registration sites. `registerBridgeConnection` follows the plugin's existing convention, which is what makes adoption by the table's first touch work. The consequence — the engine's drop-path eviction (`removeConnectionsForTable`, which compares against `schema.table`) has never matched an Optimystic connection, so a dropped table's connection stays registered and a re-created same-named table adopts it — is pre-existing at every site, untouched by this diff, and harmless precisely because of the binding-only property above. No ticket: the condition under which it would stop being harmless is the one the new tripwire names.
- **The multi-connection commit and rollback broadcasts.** Commit: the handoff's tripwire is accurate — every connection after the first finds the bridge's transaction inactive and begins-and-commits an empty one. Rollback: the engine runs those in parallel, so the bridge's `rollbackTransaction` runs once per connection over the same snapshots. Both are long-standing (any two-table transaction produces two connections) and the rollback path is covered by `deferred-constraint-rollback.spec.ts`, which rolls back a two-table transaction. No ticket; the rollback half is now in the same `NOTE:`.
- **Which transactor a transaction binds to.** The new connection does not change it beyond what a multi-table `Database` already does: `TransactionState.transactor` is whichever connection the engine begins first, and collection opening still resolves from each table's own options.
- **Hydration edge paths.** Repeat `hydrate` adds no table and so registers nothing; a `hydrate` that finds every persisted table already in the catalog registers nothing, which is correct because the declaring path registered one; registration happens before the offline-queue restore and opens no transaction of its own, since no engine transaction is active during `hydrate`.
- **Every repo doc that mentions `StampId()`** — `docs/architecture.md`, `docs/optimystic.md`, `docs/transactions.md`, `docs/internals.md`, `docs/offline-sync.md`, the plugin README — for the superseded "NULL outside a transaction" rule. One stale sentence found (below); the rest are either generic ("stable from BEGIN to COMMIT") or test-inventory lines that stayed accurate through the amended specs.
- **The board**, for an open ticket claiming these sites: none. The size of `optimystic-module.ts` is already filed as `debt-optimystic-vtab-class-is-too-big-to-review`, so the 42 lines this change adds to it get no new ticket.

### Found and fixed in this pass

- **The registration guard was scoped per table name while the invariant it protects is per `Database`.** `registerBridgeConnection` asked `getConnectionsForTable(firstHydrated.tableName)`, so a host that declared an Optimystic table before hydrating — which already has a connection listening, and so already answers `StampId()` correctly — got a second one registered beside it, paying the empty begin-and-commit of the `commit` tripwire on every later transaction for reach it already had. Now `getAllConnections()`, with the reason in the jsdoc. The README and `plugin.ts` jsdoc, which both stated the registration unconditionally, say "and the `Database` has no Optimystic connection yet".
- **A stale doc sentence the diff missed.** docs/offline-sync.md § the `queued` status said the delivery is "how an autocommit statement's caller learns the id it never selected with `StampId()`" — exactly the thing that is no longer true. Rewritten to "without having stored `StampId()` in a column", with a pointer to the rule.
- **The user-visible behaviour change was missing from the release notes.** `.release-notes.pending.md` already describes this feature for the unreleased version, but attributed all of it to the engine: nothing told a reader that `hydrate` now leaves a connection registered, which is the one thing a host can observe. A paragraph was added beside the existing one, saying what registers, when it does not, and that `select StampId()` alone is still `NULL`.

### Tripwires recorded (not tickets)

- `NOTE:` on `TransactionBridge.beginTransaction` — it reads only the binding out of `options`, never `collectionUri`, and `registerBridgeConnection` depends on that because the connection hydration registers carries the schema catalog's options rather than any table's. The handoff had this reasoning at the consumer only; it now sits, greppable, at the site that would break it, naming the fix (give that connection a table's options).
- The existing `NOTE:` on `OptimysticVirtualTableConnection.commit` gained the rollback half: a rollback is broadcast the same way and the engine runs those in parallel, so the bridge's `rollbackTransaction` runs once per connection over the same snapshots, which the same consolidation would make one pass.

### Tests

Reviewed as code, not as a floor. All four kept, none added, none cut.

- "stores a different stamp for each statement" was weighed for cutting as a restatement of the engine's autocommit semantics, and kept: it is the one case that fails if the bridge ever leaves its transaction open across autocommit statements, which is a plausible regression mode of exactly this change and one the reproduction test would not catch.
- The amended `committed-read-isolation.spec.ts` case carries two claims in one test. Accepted: splitting would duplicate the whole two-`Database` shared-storage setup for one assertion, and the new claim is a precondition of the old one rather than a separate behaviour.
- No test was added for the narrowed guard. "Declare first, then hydrate, and no extra connection appears" is registration wiring on an unusual host order — the documented warm-restart order is `hydrate` first — and the invariant it refines is already pinned by the isolation spec. Nothing else fixed in this pass is testable: two are comments and one is prose.

### Not filed, and why

No major findings and no tickets. Every concern the adversarial pass turned up resolved into one of three things: an assumption that verifies (the options binding), a pre-existing property of the plugin's connection naming that this change neither introduces nor worsens, or a cost already named by a tripwire. Nothing found serves a current-release anchor or names a class-level invariant that is not already on the board.

### Commands run

Full suites, after the fixes above, from `packages/quereus-plugin-optimystic`: `yarn build`, `yarn test` — **1394 passing, 14 pending, 0 failing**, plus `test:smoke` ok on `quereus@5.6.1`. From the repo root: `yarn typecheck`, `yarn lint`, `yarn lint:docs`, `yarn lint:deps` — all clean. `transaction-id`, `committed-read-isolation` and `hydrate-restores-declared-table` re-run after the doc-only rebuild, 40 passing.

`yarn test:integration` and `yarn check:rn` not run, by the project rule's conditions: the change touches connection registration and documentation in the SQL plugin, not networking, cohort assembly, reactivity or matchmaking, and it adds no import to code that ships to React Native. Nothing depends on `quereus-plugin-optimystic`, so no dependent package's suite applies.

No pre-existing failures surfaced.
