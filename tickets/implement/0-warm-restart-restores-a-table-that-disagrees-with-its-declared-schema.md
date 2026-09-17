description: When a database restarts, the plugin rebuilds each table from its saved record and puts it back into its schema, but the rebuilt table is missing things the original declaration had (per-statement context values, the spelling of column types) and is still wired to the storage connection the previous session used. Since a recent change put those rebuilt tables back into their own schemas, re-declaring the schema meets these incomplete copies, and a downstream application fails to open.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`hydrateCatalog` ~4120; `parseTableSchema` ~3865 reads `vtabArgs` for transactor / networkName / keyNetwork)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`storedToTableSchema` ~1079, `tableSchemaToStored` ~1170, `columnSchemaToStored`, `serializeExpression`; `StoredColumnSchema` / `StoredTableSchema` / `PersistedTableSchema` shapes and `toPersistedSchema` / `toStoredSchema`)
  - packages/quereus-plugin-optimystic/test/same-named-tables-across-schemas.spec.ts (harness to copy: shared `MemoryRawStorage`, `openSession`, `plugin.hydrate`)
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts (existing hydrate contract)
  - packages/quereus-plugin-optimystic/README.md ("Warm Restart — plugin.hydrate(db)" section claims re-declaring is not required)
  - ../quereus/packages/quereus/src/schema/table.ts (`TableSchema`, `ColumnSchema.declaredType`, `MutationContextDefinition`, `RowConstraintSchema`)
difficulty: hard
repro: verified
----

# Background

`plugin.hydrate(db)` is called on startup, before `apply schema`, so that the declarative diff finds tables that already exist in storage and emits nothing. It reads every catalog record and registers a rebuilt `TableSchema` (`SchemaManager.storedToTableSchema`) into Quereus's in-memory catalog.

Until `1208af4b` (same-named-tables-in-two-schemas-share-storage), hydrate registered every table into the host's **current** schema (`main`). Sereus declares everything in named schemas (`CadreControl`, `Strand`, `App`), so its hydrated copies sat unused in `main`, and `apply schema CadreControl` created the real tables from DDL — the plugin's create path then adopted the existing storage. `1208af4b` correctly put each table back into its **own** schema. Now `apply schema` diffs against the rebuilt copy, and the copy is not what the declaration produces.

**Introducing commit: `1208af4b`.** Established by reading the diff, not by building the older commit: the only behavioural change to hydrate is the target schema (`targetSchemaName` → the record's `schemaName`); `6302f2e8` only adds a comment and tests. The defects below existed before it, for tables declared in `main`.

# What the rebuilt table gets wrong (all verified 2026-09-16 with a scratch spec on the current tree)

Harness: two `Database`s over one `MemoryRawStorage` via the `local` transactor, as in `same-named-tables-across-schemas.spec.ts`. Session 1 declares and writes; session 2 calls `plugin.hydrate(db)` then re-runs the same declaration.

**Arm 1 — declared type spelling (sereus's nine `SET DATA TYPE int` failures).**

```sql
declare schema CadreControl {
  table CadrePeer ( PeerId text primary key, UpdatedAt int not null, Note varchar(20) )
}
apply schema CadreControl;
```

Session 2 fails with `ALTER TABLE CadreControl.CadrePeer ALTER COLUMN UpdatedAt SET DATA TYPE int` / `Module for table 'CadrePeer' does not support ALTER COLUMN`. Without hydrate it passes. The catalog stores `affinity: col.logicalType.name` (`INTEGER`), and hydrate rebuilds `logicalType` from that and drops `declaredType`. Quereus's differ compares the declared string `int` against `logicalType.name` `INTEGER`.

Important: the **same failure happens with no restart at all** — declare, then re-declare in the same process — and on a plain Quereus memory table `diff schema` reports the same `SET DATA TYPE int` / `varchar(20)` (memory tables accept the no-op retype, so it stays hidden). That comparison is a Quereus bug, tracked in `blocked/quereus-differ-treats-type-aliases-as-a-retype`. **This arm cannot turn green from this repo alone.** What this repo owes: persist and restore `declaredType`, so the rebuilt column matches the DDL-created column exactly and the Quereus fix (whichever form it takes — comparing logical types, or comparing `declaredType`) makes the warm restart a no-op.

**Arm 2 — table-level features the catalog does not carry (sereus's `context.ManagerKey isn't a column`).**

```sql
declare schema app { table M ( id integer primary key, k text ) with context (ManagerKey text) }
apply schema app;
```

After hydrate + re-apply, `findTable('M','app').mutationContext` is `undefined`; the declaration's context is gone and no error is raised, so any CHECK or default referencing `context.ManagerKey` fails at write time. The differ does not repair it because it does not compare mutation contexts.

A named CHECK (`constraint Pos check (n > 0)`) did come back after re-apply — the differ re-added it — but that is the differ's doing, not hydrate's: hydrate hard-codes `checkConstraints: []`. Audit every `TableSchema` / `ColumnSchema` field against what the record carries. From reading `storedToTableSchema`, candidates not restored: `checkConstraints` (unnamed CHECKs may not be re-added by the differ — check), `mutationContext`, `foreignKeys`, `tags` (table and column), `declaredType`, `generatedColumnDependencies` / generated expressions, and `defaultValue` for non-literal defaults (`serializeExpression` stores `{ type: 'complex', raw }`, which hydrate hands back as if it were an AST node — check whether a hydrated table with `default (…expression…)` inserts correctly).

The README's warm-restart section says "Re-declaring the table is not required for enforcement". That is only true of uniqueness today; a host that hydrates and never re-declares runs without its CHECKs and contexts.

**Arm 3 — the rebuilt table keeps the previous session's connection settings (sereus's handover reading back an empty set).**

Session 1 sets default vtab args `{ transactor: 'local', networkName: 'era1', … }` and declares `app.N`; session 2 sets `{ transactor: 'network', networkName: 'era2', … }` and hydrates. `findTable('N','app').vtabArgs` is `{ transactor: 'local', keyNetwork: 'test', networkName: 'era1' }` — the writer's. `parseTableSchema` reads the transactor and network from those args, so the hydrated table opens through the old era's transactor. Sereus's `strand-transactor-handover.spec.ts` writes with `local`, restarts with `network`, and reads nothing. Before `1208af4b` the declaration created the table with the current session's args. (The empty read itself was inferred from this, not traced in sereus.)

The record cannot currently tell an argument written explicitly in `using optimystic(...)` from one filled in from the session's defaults. The collection URI (`args['0']`, or the default location) is identity and must stay; transactor, key network, network name, port are how *this process* reaches storage, not what the table is. Pick one and say why in the handoff:
- (preferred) stop persisting session-binding arguments in the catalog record (keep only identity-bearing ones), and have hydrate fill them from the current session's defaults exactly as a fresh `create` would. This also removes a source of catalog bytes varying between machines/eras for the same declaration — relevant to sereus relying on byte-identical catalogs (`backlog/more-design/6.5-partition-healing`). Check how defaults reach a created table (`db` default vtab args merged into `vtabArgs`, and the plugin's `auxData` fallbacks) so hydrate reproduces that merge.
- or keep them in the record and overlay the current session's defaults at hydrate.

Watch the storage-adoption guard (`findRecordForUri` / `recordUriOf`) and `mergePersistedSchemas`: both read `vtabArgs`.

# The rule to hold

A table rebuilt by hydrate must be indistinguishable from the table the same declaration creates in the current session (vtab instance fields aside). Enforce it with one general test, not per-field cases: declare a table exercising every feature (non-`main` schema, alias types `int`/`varchar(20)`/`bigint`, a timestamp-like type, named and unnamed CHECKs, `with context`, an FK, table and column tags, literal and expression defaults, a generated column, a unique index, a partial index); snapshot its `TableSchema` from a DDL-created session; hydrate into a fresh session with *different* default vtab args; compare field by field (normalize away `vtabModule`, `vtabAuxData`, AST `loc`). A new `TableSchema` field added to Quereus later should make the test fail until handled — e.g. compare all keys, with an explicit ignore list.

Additionally, `diff schema <name>` after hydrate should be empty for a declaration using only canonical type names (`integer`, `text`, …). Keep the alias-type case out of that diff assertion until the Quereus fix lands, but keep it in the field-equality test (where `declaredType` must match). Do not skip or loosen anything to get green.

# Boundaries

- Do not work around arm 1 by giving the module an `alterTable` that swallows retypes, and do not touch Quereus's migration loop. The Quereus comparison is tracked separately.
- Keep `1208af4b`'s guarantees: same-named tables in different schemas keep separate storage and catalog records; hydrate keeps putting each table in its own schema; `same-named-tables-across-schemas.spec.ts` stays green.
- Catalog content must stay deterministic from the declaration alone (sereus writes it on every machine at launch and relies on byte-identical content). Anything newly persisted — AST expressions especially — must be serialized deterministically: strip `loc`, stable key order if the serializer does not already guarantee it.
- No compatibility with records written by earlier builds is owed (AGENTS.md; the README already documents a format break for this plugin version). Say in the README if the record shape changes.
- Storage-op cost: sereus pins warm-start storage operations (`control-start-storage-op-budget.spec.ts`, 46 ops). Hydrate must not start writing the catalog.

# Related

- `fix/1-a-node-cannot-read-a-row-it-just-committed` (prereq on this ticket): a joining machine that hydrates a strand another era or machine wrote would bind its tables to the writer's transactor / network name (arm 3). That could plausibly explain a node failing to read its own committed row. Note in the handoff whether arm 3's fix changes that picture.

# TODO

- Add the failing specs: the three arm shapes above (non-`main` schema, restart via hydrate, re-apply, rows present), and the field-equality round-trip test.
- Arm 1: persist `declaredType` per column and restore it in `storedToTableSchema`.
- Arm 2: audit `TableSchema`/`ColumnSchema` fields; persist and restore mutation contexts, CHECKs, FKs, tags, defaults and generated expressions faithfully (deterministic serialization); fix `serializeExpression`'s lossy `complex` form or stop using it.
- Arm 3: hydrated tables bind to the current session's transactor / network settings; decide whether binding args leave the record.
- Update README's warm-restart section to match what hydrate actually guarantees.
- `yarn lint`, `yarn build`, `yarn workspace @optimystic/quereus-plugin-optimystic test`.
- Handoff: sereus should re-run its eleven cadre-core tests (listed in sereus's `tickets/.pre-existing-error.md`) and two restart integration scenarios, then a five-run rerun of its device-shape join scenario. State plainly that the nine `SET DATA TYPE int` failures also need `blocked/quereus-differ-treats-type-aliases-as-a-retype`.
