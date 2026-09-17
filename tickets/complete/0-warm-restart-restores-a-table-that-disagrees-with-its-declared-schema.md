description: A database that restarts now rebuilds each stored table exactly as its declaration would create it in the new session (types as spelled, per-statement context values, checks, defaults, generated columns, foreign keys, tags) and connects it through the new session's storage settings rather than the previous session's.
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/src/schema/table-identity.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts
  - packages/quereus-plugin-optimystic/test/shared-local-transactor.ts
  - packages/quereus-plugin-optimystic/README.md
  - tickets/backlog/bug-optimystic-unique-ignores-collation-and-partial-predicate.md
  - tickets/backlog/bug-optimystic-catalog-record-depends-on-migration-history.md
----

# What landed

**The catalog record carries everything the declaration determines.** Each table's stored record (`StoredTableSchema` in `schema-manager.ts`) now holds CHECK constraints, foreign keys, `with context` variables, tags, the synthesized-primary-key flag, generated-column dependencies and order, and per column the declared type spelling, whether the collation was explicit, full default and generated expression trees, and tags. Fields a table does not use are left out, so records for tables without those features keep their old bytes. Expression trees go through `persistExpression`, which removes parser positions (`loc`) and sorts object keys. `addIndex` now builds the persisted index through the same `indexSchemaToStored` as everything else.

**Hydrate rebuilds the whole table.** `storedToTableSchema` restores every field above, re-infers each column's logical type from its declared spelling with Quereus's `inferType`, builds the column index map with Quereus's `buildColumnIndexMap`, and names a unique constraint that comes from an index after that index.

**Session binding is not stored.** `identityVtabArgs` (`table-identity.ts`) removes `transactor`, `keyNetwork`, `networkName`, `port` and `cache` from a table's `using optimystic(…)` arguments before they are persisted. On hydrate the table gets the current session's binding: its `default_vtab_args` when `optimystic` is the default module, then the plugin's registration config (`resolveBinding`, which `parseTableSchema` and the catalog open share). After review, hydrate takes **only** the binding arguments from the session (`sessionBindingVtabArgs`). The collection URI and `encoding` come from the record alone.

**The question sereus asked.** Alias spellings (`int`, `varchar(20)`) are now persisted and restored, so a rebuilt column matches a declared one exactly. The `SET DATA TYPE int` retype on re-apply is decided in Quereus's differ (`blocked/quereus-differ-treats-type-aliases-as-a-retype`). No plugin change can clear it, and none of this work waits on it.

**Behaviour change.** A binding written explicitly in a table's `using` clause applies only to the session that runs that DDL. After a restart the table binds like every other table. This is stated in the README "Warm Restart" section.

# Review findings

Read the implement diff (`3b860f29`) first, then the handoff. Checked: record shape and its round trip, expression persistence, the binding split and its callers, README accuracy, test independence from the uncommitted Quereus fix, storage-operation cost, catalog byte determinism, and hygiene.

## Fixed in this pass

- **Regression: a session's default `encoding` re-labelled a hydrated table.** Hydrate overlaid the session's whole `default_vtab_args` under the record's arguments. A table written without an explicit encoding (so JSON), hydrated by a session whose defaults set `encoding: 'msgpack'`, opened with the msgpack codec. Its first read then wrote `encoding: 'msgpack'` into the catalog record, so a later session with plain defaults could not read the table either. Verified with a scratch script: the new build failed with `msgpack decoding not yet implemented` in both sessions; the pre-change build read the row. Fix: `sessionBindingVtabArgs` in `table-identity.ts` passes only the binding keys, and `storedToTableSchema` uses it. New spec test: "never takes a hydrated table's encoding from the session's default args".
- **Catalog byte identity is now tested, not just argued** (garden-tender note 1). New spec test "writes byte-identical catalog records for one declaration…". It reads every catalog entry back from storage as JSON and requires the same bytes from a fresh apply in five cases: another era over separate storage, the declaration with its whitespace changed, tables declared in the other order, an earlier version (no indexes) with rows written and then the full declaration, and the declaration applied twice. It also checks that no `loc` and no era name reach the record. Caveat: JSON is a stand-in for "bytes". The local test storage keeps objects, and this is the JSON the catalog is encoded as.
- **Comment corrected** on `resolveBinding` (`optimystic-module.ts`): it said the binding list was "SESSION_BINDING_VTAB_ARGS plus `encoding` and `cache`". `cache` is in that set and `encoding` is identity.
- **README** ("Warm Restart"): the byte-identity claim now names its known exception (index order, below). The "never re-declares still runs its CHECKs" claim now names the ALTER-added-CHECK exception. The paragraph now says an `encoding` default never applies to a hydrated table.

## Filed

- `backlog/bug-optimystic-catalog-record-depends-on-migration-history` (repro verified). The record is not yet a function of the final declaration alone. (1) Indexes are listed in the order they were created, so a machine that gained an index declared ahead of an existing one stores different bytes from a fresh machine. (2) The module implements no `alterTable`, so a CHECK added by a later schema version goes into Quereus's in-memory catalog only. A restart plus hydrate-only then accepts rows that violate it, and the migrated record differs from a fresh one. Both behave the same on the pre-change build (not regressions). Filed at the property-test rung: every migration path to a declaration must persist what a fresh apply persists. This is the case sereus's partition-healing invariant cares about. Also noted there, as Quereus's own matter: the differ emits nothing for an added *unnamed* table-level `unique (…)`, even on memory tables.

## Verified, no change needed

- **Storage-operation cost** (garden-tender note 2). Measured with counting wrappers at the transactor seam and the raw-storage seam, pre-change build (a detached worktree of `3b860f29~1`, since removed) against post-change build, same scenario and same store. Two schemas: 3 tables with a partial index, a unique index, CHECK, FK and tags; and 11 tables adding collations, generated columns and tags. Warm start (`hydrate`, then re-apply the declaration, then the first `select`, then an insert) and cold apply were **identical at both seams** for both schemas: hydrate 12 transactor gets / 68 raw ops; re-apply 0; first select 20 / 112; cold apply of the 3-table schema 12 / 52 (1 commit), of the 11-table schema 30 / 70. The declarations avoided expression defaults and context CHECKs, because the pre-change build cannot re-apply those at all. The first-read schema rewrite the handoff describes removing did not appear on the pre-change build in these shapes, so there is no before/after delta to report. Sereus's 46-op warm budget should not move from this change. Larger records could in principle cross a catalog block boundary sooner; not observed at 11 tables.
- **Explicit per-table binding** (note 3). In-repo `using optimystic(…, transactor=…)` callers: `distributed-*.spec.ts` never hydrate. `schema-batch.spec.ts` "two transactor configurations" hydrates only to count the local catalog's tables. Nothing relies on a persisted binding. Sereus's `control-database.ts` declares no per-table `using` clause. The full suite passes.
- **Quereus provenance** (note 4). The uncommitted Quereus change is exactly one hunk in `computeColumnAttributeChange`. It changes `declared.dataType.toLowerCase() !== actual.type.toLowerCase()` to a comparison of `inferType(...)` names. Every declaration the spec *re-applies* spells only canonical names (`integer`, `text`), whose lowercase already equals the catalog's `INTEGER` / `TEXT`, so both versions agree. The alias spellings appear only in tests that never re-apply. `inferType` and `buildColumnIndexMap` are exported from Quereus's committed HEAD (`ff1c619c6`, version 4.19.0, matching the plugin's `^4.19.0` range). Not run against a Quereus build without the fix (that tree is not this repo's to alter), so this is static but exact.
- **Field-by-field round trip**, `persistExpression`, tag copying, positional checks on foreign keys and generated columns (`assertPositionsInRange`), `mergePersistedSchemas` (takes the incoming record's new fields wholesale, so a v1-then-v2 path persists them, as the byte test confirms). No defects found.
- **Error handling / resource cleanup**: no new error paths beyond existing throws. No new resources opened. `hydrateCatalog` opens one schema manager as before.

## Tripwires recorded

- `schema-manager.ts` is 1532 lines (`wc -l`). The record ↔ `TableSchema` conversions (~300 lines) use no manager state. A `NOTE:` on `storedToTableSchema` says to move them out if the file grows again.
- Existing `NOTE:` on `persistExpression` (blob and bigint literals cannot be JSON-encoded) left as the implementer wrote it.

## Not covered, with reason

- No spec exercises the `doInitialize` load arm for a `connect` with no columns (handoff says no live path reaches it; not re-investigated).
- `yarn check` (full release gate) and `yarn test:integration` not run. Only this package changed. Ran: plugin `tsup` build, `tsc --noEmit`, root `yarn lint`, `yarn lint:docs`, and `yarn workspace @optimystic/quereus-plugin-optimystic test`: **966 passing, 13 pending, 0 failing**, smoke ok. The new spec alone: 8 passing.

# What sereus should do next

Re-run its cadre-core tests and restart scenarios as the handoff listed. Expect the `context.ManagerKey` failure and the transactor-handover empty read to be gone, and the storage-op budget unmoved. The `SET DATA TYPE int` failures stay until the Quereus differ fix is committed and consumed. Before relying on catalog byte identity across app upgrades, watch `backlog/bug-optimystic-catalog-record-depends-on-migration-history`.
