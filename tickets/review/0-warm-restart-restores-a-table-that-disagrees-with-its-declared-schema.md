description: A database that restarts now rebuilds each stored table exactly as its declaration would create it in the new session (types as spelled, per-statement context values, checks, defaults, generated columns, foreign keys, tags) and connects it through the new session's storage settings rather than the previous session's. The reviewer should confirm the field-by-field guarantee holds and that nothing else relied on the connection settings that are no longer stored.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (record shape: `StoredTableSchema`, `StoredColumnSchema`, `StoredCheckConstraint`, `StoredForeignKey`, `StoredMutationContextVar`; `persistExpression`; `storedToTableSchema`, `storedToColumnSchema`, `tableSchemaToStored`, `indexSchemaToStored`; `assertPositionsInRange`)
  - packages/quereus-plugin-optimystic/src/schema/table-identity.ts (`SESSION_BINDING_VTAB_ARGS`, `identityVtabArgs`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`resolveBinding`, `parseTableSchema`, `deriveDefaultOptions`, `sessionDefaultVtabArgs`, `hydrateCatalog`; `addIndex` now persists an index through `indexSchemaToStored`; the load arm of `doInitialize` for a connect without columns uses `storedToColumnSchema`)
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts (new: the field-equality round trip, the three arm shapes, and a no-writes check)
  - packages/quereus-plugin-optimystic/test/shared-local-transactor.ts (new shared harness; `catalog-hydration.spec.ts` and `same-named-tables-across-schemas.spec.ts` now import it instead of carrying their own copy)
  - packages/quereus-plugin-optimystic/README.md ("Warm Restart" section rewritten for the new record contract)
  - tickets/backlog/bug-optimystic-unique-ignores-collation-and-partial-predicate.md (filed: a pre-existing enforcement gap found while writing the spec)
difficulty: medium
----

# What changed

**The catalog record now carries everything the declaration determines.** `StoredTableSchema` gained `checkConstraints`, `foreignKeys`, `mutationContext`, `tags`, `synthesizedPrimaryKey`, `generatedColumnDependencies` and `generatedColumnTopoOrder`; `StoredColumnSchema` gained `declaredType`, `collationExplicit`, `generatedExpr`, `generatedStored` and `tags`, and its `defaultValue` is now the full expression tree instead of the old lossy `{ type: 'literal' }` / `{ type: 'complex', raw }` forms (the latter was handed back to the engine as if it were an expression node, so a hydrated table with an expression default could not insert). Unique constraints and indexes carry their `tags`. Every field is omitted when the table has none, so tables without a feature persist the same bytes as before.

**Expressions are persisted deterministically.** `persistExpression` in `schema-manager.ts` clones an expression tree with every `loc` (parser position) removed and object keys sorted, and is applied to defaults, generated expressions, CHECK bodies and partial-index / partial-constraint predicates. Nothing is re-encoded, so hydrate hands the tree back as is. The `addIndex` path in `optimystic-module.ts` used to build the persisted index inline with the raw predicate; it now goes through `indexSchemaToStored` (made public), which is what removed the one schema rewrite the first read of a hydrated table used to make.

**Hydrate rebuilds the whole table.** `storedToTableSchema` restores every field above, re-infers each column's logical type from its declared spelling with the same `inferType` CREATE TABLE uses, builds the column index map with the engine's own `buildColumnIndexMap`, names an index-derived unique constraint after its index (as the engine does), and leaves `indexes` absent rather than `[]` for an index-free table (the shape a declared table has). The generated-column dependency map and topological order are persisted rather than recomputed because the engine does not export that analysis and the INSERT / UPDATE planners read the order to compute generated columns at all.

**Session binding is no longer stored.** `identityVtabArgs` in `table-identity.ts` strips `transactor`, `keyNetwork`, `networkName`, `port` and `cache` from a table's `using optimystic(…)` arguments before they are persisted; the collection URI and `encoding` stay. `hydrateCatalog` overlays the current session's `default_vtab_args` (only when this module is the session's `default_vtab_module`) under the record's identity args, which is what `create table` without a `using` clause would get, and opens the catalog itself through the same resolution (`resolveBinding`, shared by `parseTableSchema` and `deriveDefaultOptions`, so the two cannot drift). The storage-adoption guard's `recordUriOf` still reads the URI from the record.

# The answer to the garden tender's question (arm 1)

The plugin cannot make the `SET DATA TYPE int` failures go away on its own, and here is precisely why. The engine's declarative differ (`computeColumnAttributeChange` in `@quereus/quereus/src/schema/schema-differ.ts`) compares the declaration's spelling (`int`) against the live table's catalog rendering, and that rendering (`tableSchemaToCatalog` in `@quereus/quereus/src/schema/catalog.ts`) always emits `logicalType.name` (`INTEGER`); it never reads `ColumnSchema.declaredType`. So a rebuilt column carrying `declaredType: 'int'` is compared exactly as a freshly declared one is, and the ticket already established that a freshly declared table hits the same retype on a second `apply schema` in one process. The comparison has to change in Quereus (`tickets/blocked/quereus-differ-treats-type-aliases-as-a-retype`), and the fix there does not depend on anything here.

What this repo owed, and now does: the declared spelling is persisted and restored, and the logical type is re-inferred from it, so the rebuilt column is identical to the declared one. Whichever form the Quereus fix takes (comparing inferred logical types, which its working tree does, or comparing `declaredType`), the warm restart is a no-op. The new spec asserts the spelling round trip for `text` / `int` / `varchar(20)` / `timestamp` and deliberately does not assert on re-applying an alias-typed declaration.

# The Quereus working tree these results were produced against

`git -C ../quereus rev-parse HEAD` is `ff1c619c632910d3bbacf4f0ad1f8c9f00b678c8`, and the working tree holds the **uncommitted** differ fix (`packages/quereus/src/schema/schema-differ.ts` and `test/schema/differ-alter-column.spec.ts` modified, plus an untracked completed-ticket file). Its `dist` was stale against those sources, and this repo's test guard refuses a stale sibling build, so I rebuilt Quereus from that working tree; every test run below therefore exercised the uncommitted fix. By construction the new spec should not depend on it: the field-equality, context and binding tests never re-apply an alias-typed declaration, the `diff schema` assertion uses canonical type names only, and the spelling test does not re-apply at all. I did not verify that by checking out Quereus's committed HEAD (the sibling tree is not mine to alter), so treat "passes without the fix" as reasoned, not observed.

# Arm 3: the decision and its tradeoff

Binding arguments are never persisted, whether they came from the session's defaults or from an explicit per-table `using optimystic(transactor = …)`. The record cannot tell the two apart (the engine hands the module either the clause's arguments or the session defaults wholesale, never a merge), and the ticket preferred this option. The consequence, documented in the README: a binding written explicitly in one table's `using` clause applies to the session that runs that DDL; after a restart the table binds like every other. Sereus binds through session defaults, so it is unaffected. If a host ever needs a per-table binding that survives restart, the record would need an explicit "spelled in the clause" marker written at create time.

One behaviour change beyond the ticket's letter: `hydrate` used to open the catalog tree with the plugin's registration config only, while the tables it hydrated bound through their (persisted) arguments. It now opens the catalog through the session's `default_vtab_args` when this module is the default module, then the registration config, which is the same resolution the tables get. A host that set the two inconsistently would have had the catalog and the tables on different transactors before; now they agree.

On `fix/1-a-node-cannot-read-a-row-it-just-committed`: before this change a machine hydrating a strand another era or machine wrote bound every hydrated table to the writer's transactor, key network and network name. The new spec's binding test reproduces the sereus symptom exactly (with the old code, the later era read back an empty set through the writer's key). Whether that is also the cause behind fix/1 is plausible but not shown here.

# Byte determinism and storage cost

The record is a function of the declaration alone: expression trees are position-free with sorted keys, tags are copied in declaration order, session binding is absent. `hydrate` writes nothing, and the first read of a hydrated table writes nothing (both asserted with a counting transactor). A record written by an earlier plugin version is not read with any shim; the README's one-time-upgrade caveat covers it (open once with the DDL executing).

# Validation

All from `packages/quereus-plugin-optimystic` unless noted; Quereus rebuilt first as described above.

- `yarn build` (tsup, with declaration output), then `npx tsc --noEmit`: clean.
- `yarn lint` (repository root): clean. `yarn lint:docs`: 46 documents, all citations resolve.
- New spec, run alone: 6 passing. Before the fix, all 6 failed for the reasons the ticket predicts, and the no-writes test reproduced sereus's empty read (a hydrated table bound to the writer's era returned no rows).
- Catalog-related existing specs (`catalog-hydration`, `same-named-tables-across-schemas`, `secondary-unique-hydrate`, `schema-catalog-index-durability`, `schema-batch`, `schema-redeclare-column-identity`, `secondary-unique-migration`, `schema-migration`, `quereus-engine`, `schema-catalog-open-semantics`): 127 passing.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` (full suite plus smoke): 964 passing, 13 pending, 0 failing, about 3 minutes.
- Not run: `yarn check` (the full release gate), `yarn test:integration`, and builds of the other workspaces (none changed).

# Use cases for the reviewer

- **Field equality.** `declare schema app { table Every … }` with alias types, a collated column, literal and expression defaults, named and unnamed CHECKs, a stored generated column, a foreign key with an action, column and table tags, a table-level UNIQUE, a `with context` variable, a partial index and a partial unique index. Session 1 (era1) declares and writes; session 2 (era2) hydrates over the same storage; session 3 (era2) declares over empty storage. The hydrated and declared `TableSchema`s compare deep-equal after dropping `vtabModule` / `vtabAuxData`, stripping `loc`, and turning Maps into entry lists. A `TableSchema` field the engine adds later fails this until hydrate carries it.
- **No-op re-apply.** Same shape with canonical type names: after hydrate, `declare schema` then `diff schema app` is empty, `apply schema app` leaves the catalog entry unchanged, and inserts still get defaults, generated values, CHECKs and UNIQUE.
- **Type spelling.** `PeerId text, UpdatedAt int, Note varchar(20), Seen timestamp` come back with `declaredType` `['text', 'int', 'varchar(20)', 'timestamp']` and logical types `TEXT / INTEGER / TEXT / TIMESTAMP`.
- **Contexts.** `table M { …, constraint Gate check (context.ManagerKey = 'k') } with context (ManagerKey text)`: after hydrate and re-apply, an insert without the envelope fails with `requires mutation context variable 'ManagerKey'`, a wrong key fails on `Gate`, the right key inserts.
- **Binding.** Session 2 registers two counting transactors over one store, its own era's key and the writer's; after hydrate, reads and the write go through its own, the writer's sees zero calls, and `vtabArgs` equals the session's defaults (plus the explicit URI for a table that spelled one).
- **Storage ops.** `hydrate` makes no `pend` / `commit`; the first `select` on a hydrated table makes none either.

# Known gaps and things worth a second look

- The field-equality test compares two engine-built tables, so a field the engine fails to set on create is invisible to it. It also does not cover a maintained table (materialized view) backed by optimystic, which this plugin does not support.
- `mutationContext` variables persist their logical type name only; the engine's `MutationContextDefinition` has no declared-spelling field, so nothing is lost relative to what CREATE produces.
- The load arm of `doInitialize` for a `connect` whose caller supplied no columns now rebuilds columns through `storedToColumnSchema` (it used to drop everything but the basics). No spec exercises that arm; I could not find a live path that reaches it with an empty column list, so it is a fidelity improvement without a test.
- `persistExpression` passes a blob literal's `Uint8Array` and a bigint literal through untouched, and the JSON catalog encoding cannot represent either. Pre-existing exposure (the old code stored literal values the same way); noted as a `NOTE:` on the function.
- Uniqueness enforcement ignores a column's `collate nocase` and a partial unique index's predicate, on freshly declared tables too, while Quereus's memory tables honour both. Filed as `backlog/bug-optimystic-unique-ignores-collation-and-partial-predicate` (repro verified, table in the ticket); the new spec inserts an exact-case duplicate and never a duplicate under the partial index, and says so.
- Records now carry `synthesizedPrimaryKey`; only the sibling `lamina` adapter reads it, per the engine's field comment.

# What sereus should do next

Re-run its eleven cadre-core tests (listed in sereus's `tickets/.pre-existing-error.md`) and its two restart integration scenarios, then five runs of the device-shape join scenario. Expect the `context.ManagerKey isn't a column` failure and the transactor-handover empty read to be gone. The nine `SET DATA TYPE int` failures stay red until the Quereus differ fix in `blocked/quereus-differ-treats-type-aliases-as-a-retype` is committed and consumed; nothing in this repo can clear them, and nothing here waits on that fix.

# Notes for the reviewer (garden tender, 2026-09-16 night)

1. **Catalog bytes must be identical across machines — test it, don't infer it.** A downstream app
   (sereus) writes the catalog alone on every machine at every strand launch and relies on byte-identical
   content (see `backlog/more-design/6.5-partition-healing`). This change put far more into each record:
   declared type spellings, CHECK and default expression trees, `with context` variables, foreign keys,
   tags, generated-column order. "Position-free and key-sorted" is the right intent. Please establish it
   with an assertion: the same declaration applied in two independent databases, and applied in a
   different statement order where that is legal, produces byte-identical catalog records. Watch for
   anything that captures source positions, object identity, insertion order or session state.
2. **Storage-operation cost on warm start.** Sereus pins cold/warm control-database start in a budget
   spec (46 on warm start, per its report). The records are larger; the handoff says hydrate makes no
   writes and a first-read schema rewrite was removed. State the before/after operation count on a warm
   start so the dependent can re-measure deliberately rather than meet a red budget.
3. **A behaviour change that other consumers may rely on.** "A per-table binding written explicitly in a
   `using` clause now applies only to the session that runs the DDL." Session-binding arguments are no
   longer persisted. That is defensible — the stale-binding defect was exactly this — but it changes what
   an explicit `using optimystic(..., transactor: ...)` means after a restart. Confirm the README states
   it where a user will meet it, and that no in-repo caller depends on the old persistence.
4. **Quereus provenance.** The implementer rebuilt quereus's `dist` from the sibling working tree
   (quereus HEAD `ff1c619c6` plus an **uncommitted** type-alias fix), so every run here included that
   fix. The new spec is said not to depend on it. Verify that claim: the spec's assertions must hold
   whether or not quereus has the alias fix, since the published plugin range will not carry it yet.
