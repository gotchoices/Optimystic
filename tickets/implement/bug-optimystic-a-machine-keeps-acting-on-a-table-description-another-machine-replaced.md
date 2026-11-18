description: A machine that is already running keeps using its old description of a shared table after another machine changes it, so its writes can leave rows out of an index it does not know about or break a rule it has not seen, with no error on either machine. A transaction that wrote under an out-of-date description will now be refused at commit with a schema error, and the machine will take the new description, so the retried statement follows it.
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
prereq: optimystic-an-update-keeps-values-of-columns-its-description-does-not-name
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitTransaction`, `offlineRoute`, `markDirty`, `afterFailedCommit`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`markDirtyTrees`, `owesCatalogRecord`, `viewOfCatalogEntry`, `viewOverRecord`, `followTagChanges`, `hydrateCatalog`, `instantiateTable`, `lookupOrInstantiate`, the module's `tables` map), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`getSchemaFresh`, `getDroppedSchemaRecord`, `viewOverRecord`, `toPersistedSchema`, `storedToTableSchema`, `canonicalizeRecordOrder`), packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/stale-hydrated-table.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md, docs/transactions.md, @quereus/quereus/src/runtime/stale-catalog-guard.ts (`assertCatalogMatchesModule`, the engine's own `StatusCode.SCHEMA` precedent), @quereus/quereus/src/core/statement.ts (plan invalidation on `table_modified`)
difficulty: hard
repro: verified
----

## The defect

Each machine copies table descriptions from the shared catalog into its engine when it hydrates, and nothing tells it about a later change. A table instance builds its row codec and its `IndexManager` from that description once, at initialization. Nothing compares the description a write used with the one the catalog holds now.

Reproduced at HEAD with two sessions over one `MemoryRawStorage` through the `local` transactor (harness of `packages/quereus-plugin-optimystic/test/stale-hydrated-table.spec.ts`), B having run `select * from main.t` before A's change:

- **An index misses a row.** A creates `main.t (id integer primary key, a integer null)` with row `(1, 5)`, then `create index t_a on main.t (a)`. B runs `insert into main.t (id, a) values (2, 7)`. A's `select id from main.t where a = 7` returns nothing, and `plugin.verifyIndexes(a.db, 't')` reports one missing entry for `t_a` (row `[2, 7]`).
- **A value is erased.** A adds column `y` and sets it on row 1; B updates `a` on row 1; A reads `y = null`. This arm is closed structurally by the prereq (`optimystic-an-update-keeps-values-of-columns-its-description-does-not-name`); this ticket's check also refuses it, as a description difference.

The same holds for every rule a description carries: a CHECK, a NOT NULL, a UNIQUE constraint or a partial index's predicate added on A is not applied to B's writes. And a table A dropped is still written by B, into storage no record describes.

`SchemaManager.viewOverRecord` already leaves an index over a column this machine does not know out of the instance, with a `NOTE:` naming this ticket; docs/internals.md §A first touch writes only what the table owes says such an index "goes unmaintained here until the machine restarts or re-applies the schema".

## Decision: refuse, then follow

A write planned under an older description is refused at commit, and the machine then takes the record's description into its engine and its table instance, so the statement's retry is planned and maintained under it. Following silently instead (re-deriving the write under the new description) is not possible: Quereus has already planned and run the statement against its own catalog entry, positions included, and the row values it handed over are in that layout.

This is the engine's own vocabulary. Quereus refuses a connect whose catalog entry disagrees with the module's instance with `StatusCode.SCHEMA` and "this connection's definition of it is stale" (`assertCatalogMatchesModule` in `@quereus/quereus/src/runtime/stale-catalog-guard.ts`). Use `StatusCode.SCHEMA` (17) here too, as a `QuereusError` subclass so the vtab's and bridge's rethrow paths pass it through unwrapped, with a message naming the table and saying another machine changed (or dropped) its description and that the statement can be retried.

### Where the check runs: at commit, once per transaction

In `TransactionBridge.commitTransaction`, before any commit route runs (session, offline seal, legacy), for each optimystic table the transaction staged a write into. One fresh read of the catalog serves all of them (`SchemaManager.getSchemaFresh` per table, over one catalog tree refresh). Commit, not statement start, because the check has to be as late as possible: a statement checked at its start can commit long after, inside an explicit transaction. A read-only transaction is not checked; reading under an older description returns a consistent view, and nothing is written.

The bridge does not know descriptions, so the vtab hands it a per-table check when it first marks its trees dirty in a transaction (`OptimysticVirtualTable.markDirtyTrees` → `TransactionBridge.markDirty`, or a new registration beside it). The check answers one of:

- **current** — the record describes the table as this instance does. Commit proceeds.
- **replaced** — the record describes it differently. Refuse.
- **dropped** — the catalog holds a gravestone (`getDroppedSchemaRecord`). Refuse, naming the drop.
- **unknown** — no live record and no gravestone. Commit proceeds: `getSchema`'s contract is that "nothing" can be an unreadable catalog, and refusing on it would refuse every write while the catalog is unreachable. Note this at the site.

A table that owes its record (`owesCatalogRecord`) is checked as current: its instance's description is the one about to be written, and initialization, which writes it, always runs before a write stages.

### What "describes the table differently" compares

Everything a write must honour, nothing it need not. Compare the instance's working description (`viewOverRecord` of its engine entry, the shape `doInitialize` honours) with the record, both in the persisted name-keyed form (`toPersistedSchema`) and canonical order (`canonicalizeRecordOrder`), on:

- columns (names in order, type, nullability, default, collation, generated), the primary key, indexes (name, columns, unique, predicate), uniqueness constraints, CHECKs, foreign keys.

Not compared: tags (a tag change never refuses a write; `followTagChanges` already saves them), `orphanedIndexes`, vtab module and arguments, `droppedAt`. An index the view left out because it covers a column this machine does not know is a difference, since the record lists it and the instance does not maintain it. That is the reproduced case.

The comparison must be exact after a refresh: a description built from the record compares equal to the record, or every write to the table is refused forever. Records that differ from the engine's entry only in form (out of canonical order, written before uniqueness metadata existed) must compare equal; canonicalizing both sides does that. Pin it with the test below.

### The refresh

After the refusal has rolled the transaction back (not inside the commit, where the trees are still being restored), for each refused table:

- **Engine catalog.** Build the engine entry from the record exactly as `OptimysticModule.hydrateCatalog` does (`storedToTableSchema` with the session's vtab arguments), register it with `schema.addTable`, and announce it with `db.schemaManager.getChangeNotifier().notifyChange({ type: 'table_modified', schemaName, objectName, oldObject, newObject })`, passing `addTable`'s return value as `newObject` (Quereus asserts this). Quereus invalidates every prepared statement that depends on the table (`@quereus/quereus/src/core/statement.ts`), so a retry re-plans. The module's own `table_modified` listener (`followTagChanges`) hears it and must write nothing: `tagsToSave` judges against the record, which already holds every tag, so it adopts; verify.
- **Table instance.** Retire the instance in the module's `tables` map and let the next statement instantiate one from the new engine entry (`lookupOrInstantiate` → `instantiateTable`), which builds its codec and `IndexManager` from the record, the new indexes included (their trees exist, built by the machine that created them). Retiring must release what initialization registered (collections with the bridge, the change subscription, a network watch) without touching storage or the record, the way DROP TABLE's `destroy` does not; find or factor that teardown.
- **Dropped.** Remove the table from the engine catalog and announce `table_removed`, so the next statement fails as on a machine that never had the table. Do not write anything.
- **Materialized views** over a refreshed table are not touched; Quereus's own `table_modified` handling decides what a view needs.

### Offline mode

A locally acknowledged transaction (`offlineRoute` kind `'local'`) is sealed into the offline queue and may commit much later. Check it at seal time under the same rule when the catalog is readable, and skip the check when the read fails because the cohort is unreachable (the cases `isCohortUnreachableRead` accepts), with a `NOTE:` saying that a transaction queued offline is not checked against a description change made while it waited. Do not add a check to the drain.

### What this does not close

A transaction whose check ran just before another machine's change landed still commits under the old description. For a CHECK, a NOT NULL or a new column that window is one commit's network duration. For CREATE INDEX it is the whole index build on the other machine, because that machine populates the index from the rows it reads and writes the record only afterwards: a row written elsewhere during the build is neither read by the build nor maintained by its writer. That is backlog `bug-optimystic-a-write-during-another-machines-index-build-can-miss-the-index`; reference it in a `NOTE:` at the check.

## Cost

One catalog read per committing write transaction, whatever the number of tables it wrote: one refresh of the catalog tree (one request when idle on a networked node, none on a member of the catalog's cohort inside its read-repair window), then a lookup per table. Measure it in the existing write-cost spec (`test/two-node-write-request-count.spec.ts`) and update that spec's expected count and the docs that quote it. If the extra request is unacceptable there, the fallback is to remember the catalog's revision and skip the read when the catalog's log tail shows nothing newer; leave it as a `NOTE:` unless the measurement demands it.

## Tests

In `test/stale-hydrated-table.spec.ts` (or a sibling spec named for this rule), each with B having read the table before A's change:

- The reproduced index case: B's insert is refused with `StatusCode.SCHEMA`; B's retry of the same statement succeeds; A's `where a = 7` finds row 2; `verifyIndexes` on a third session reports nothing missing.
- A CHECK A added (`alter table … add constraint small check (a < 100)`): B's insert of `a = 200` is refused with `SCHEMA`, and its retry is refused by the CHECK.
- A dropped the table: B's insert is refused, B's next statement on the table fails as on a table that does not exist, and a third session's hydrate finds no table.
- No false refusal: a tag change on A (`alter table … set tags`) does not refuse B's write; and B's write after a refresh, and on a table whose record was written before uniqueness metadata or out of canonical order, commits (whichever of these the existing fixtures can produce).

## TODO

- Add the per-table description check (the vtab side) and its registration with the bridge on first dirtying in a transaction.
- Run the checks in `commitTransaction` ahead of every route; refuse with a `StatusCode.SCHEMA` `QuereusError` subclass; make sure `afterFailedCommit` rolls back as for any failure before anything was sent.
- After the rollback, refresh the engine catalog and retire the instance for each replaced table; remove each dropped one.
- Offline seal-time check, skipped when the catalog is unreachable, with its `NOTE:`.
- Factor the instance teardown that releases registrations without touching storage, if none exists.
- Tests above; update `two-node-write-request-count.spec.ts` for the measured request.
- Docs: rewrite the sentence in docs/internals.md §A first touch writes only what the table owes about the index that "goes unmaintained here until the machine restarts", add the commit check and its cost to docs/transactions.md, add the refusal to the README's Limitations and to its error list, and replace the `NOTE:` on `SchemaManager.viewOverRecord` (it names this ticket) with one describing the check.
- `yarn build`, `yarn typecheck`, `yarn test` in `packages/quereus-plugin-optimystic`, the plugin's integration specs with `OPTIMYSTIC_INTEGRATION=1`, `yarn lint:docs`.
