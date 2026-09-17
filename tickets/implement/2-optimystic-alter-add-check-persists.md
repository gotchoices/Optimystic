description: When a later schema version adds a named CHECK rule to an existing table, save it in the table's catalog record, so a restarted machine still enforces it and the record matches a machine that installed the new version fresh.
prereq: optimystic-catalog-record-canonical-list-order
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (module class ~L3616 holds `tables` / `schemaManagers`; new `alterTable`)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`storeStoredSchema`, `checkConstraintToStored`, the APPLY SCHEMA catalog batch)
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts
  - packages/quereus-plugin-optimystic/README.md ("Warm Restart" — the stated limitation to remove)
  - ../quereus/packages/quereus/src/runtime/emit/add-constraint.ts (`runAddCheckEngineSide`, `runAddConstraintViaModule`)
  - ../quereus/packages/quereus/src/runtime/emit/alter-table.ts (~L433 renameColumn: module-routed when `alterTable` exists, else engine-side schema-only)
  - ../quereus/packages/quereus/src/vtab/module.ts (~L500 `alterTable`, ~L716 `SchemaChangeInfo`)
  - ../quereus/packages/quereus/src/vtab/memory/layer/manager.ts (~L3071 `addCheckConstraint`, the reference behaviour)
repro: verified
----

# Problem

Version 1: `table t { id integer primary key, a integer null }`. Version 2 adds `constraint pos check (a > 0)`. `apply schema` emits `ALTER TABLE s.t ADD constraint pos check (a > 0)`. The optimystic module implements no `alterTable`, so Quereus takes `runAddCheckEngineSide`: the CHECK goes into the engine's in-memory catalog only. Reproduced 2026-09-17:

| step | CHECKs on the table | `insert (…, a = -1)` |
| --- | --- | --- |
| migrating session | `pos` | refused |
| restart, `hydrate` only | none | accepted |
| restart, `hydrate` then `apply schema` again | `pos` | refused |

The migrating machine's record also lacks `pos`, while a fresh apply of version 2 stores it, so the two machines' catalog bytes differ.

Only *named* table-level CHECKs reach this path. Unnamed table-level CHECKs and column-level CHECKs added by a later version are never emitted by Quereus's differ at all, for memory tables too (verified) — that is upstream, filed as `blocked/quereus-differ-ignores-unnamed-constraint-additions`, and not this ticket's.

# Fix

Implement `alterTable` on the optimystic module (the `VirtualTableModule` in `optimystic-module.ts`).

- **`addConstraint`, `constraint.type === 'check'`**: build the CHECK with Quereus's `buildCheckConstraintSchema(constraint, checkConstraints.length, collectTableConstraintNames(tableSchema))` exactly as the memory backend does (schema-only, no existing-row validation — matches both memory and today's engine-side path). Persist the updated record through the table's `SchemaManager.storeStoredSchema` (it joins an open APPLY SCHEMA batch automatically, so the whole apply is still one commit), using the current transaction's transactor like `addIndex` does. Return the updated `TableSchema`. Check how Quereus exports those two helpers from `@quereus/quereus`; if they are not public, reproduce the naming rule rather than importing internals, and say so in the handoff.
- **Keep every cached copy in step**: any live `OptimysticVirtualTable` instance for the table (`tables` map) must get the new `tableSchema`. Otherwise its next connect-time candidate (`tableSchemaToStored(this.tableSchema)`, ~L654) lacks the CHECK and `mergePersistedSchemas` — which takes everything but `indexes` from the incoming side — writes the record back without it.
- **`addConstraint` for `unique` / `foreignKey`**: throw `QuereusError(\`Module for table '<name>' does not support ADD CONSTRAINT\`, StatusCode.UNSUPPORTED)` — the same message the engine gives today. Supporting them is `backlog/feat-optimystic-alter-add-unique-and-foreign-key`.
- **`renameColumn`**: implementing `alterTable` removes the engine's schema-only fallback, so the module must now answer it. Reproduce that fallback unchanged (rename in `columns`, rebuild `columnIndexMap`, write nothing) so this ticket changes no rename behaviour; today's rename is already lost on restart, which is `backlog/bug-optimystic-rename-column-lost-on-restart`. Put a `NOTE:` there pointing at it.
- **Every other arm** (`addColumn`, `dropColumn`, `alterPrimaryKey`, `dropConstraint`, `renameConstraint`, `alterColumn`): throw the exact UNSUPPORTED message the engine throws today for a module without `alterTable` (`alter-table.ts`: "Module for table '<name>' does not support ALTER TABLE ADD COLUMN" / "DROP COLUMN" / "DROP CONSTRAINT" / "RENAME CONSTRAINT", etc. — read each arm's current wording). Existing specs that assert those refusals must still pass untouched.
- If Quereus requires an `alterTable` module to emit schema-change events (`module.ts` ~L823), follow what the module already does for create/drop; the engine-side path emitted one for us before.

# Test

Add the CHECK arm to the migration-path property from `optimystic-catalog-record-canonical-list-order`:

- Derive earlier versions from D that drop a named table-level CHECK (`BigNonNegative`), and one that drops it while D declares it *between* other CHECKs, so canonical order is exercised. Assert byte-identical records against a fresh apply of D.
- After such a path, restart with `hydrate` only: the CHECK is present and enforced (insert violating it is refused), and the hydrated table equals a declared one under `declarationView`.
- ALTER-added CHECK inside a batch commits with the apply (no extra flush) — reuse the counting-transactor pattern the spec already has if cheap.
- The refused arms still refuse with the same messages.

# TODO

- Implement `alterTable` on the module with the arms above.
- Update cached vtab instances after the CHECK is persisted.
- Extend the property test; confirm the CHECK cases fail before and pass after.
- README "Warm Restart": remove the "constraint added to an existing table by a later version" limitation; mention that unnamed / column-level CHECK additions are not diffed by Quereus.
- `yarn build` and full `yarn test` in `packages/quereus-plugin-optimystic`.
