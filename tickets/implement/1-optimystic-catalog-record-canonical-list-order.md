description: Store a table's indexes and CHECK rules in a fixed order in its catalog record, so two machines that end at the same schema version store identical bytes no matter which earlier versions they went through.
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`tableSchemaToStored` ~L1412, `mergePersistedSchemas` ~L595, `mergeIndexLists` ~L408, `mergeWithPersisted` ~L836)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`addIndex` ~L2823 appends to the list; `schemasEqual` ~L310 is order-sensitive; connect-time redundant-write skip ~L654–680)
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts (`declarationView`, the byte-identity test ~L316)
  - packages/quereus-plugin-optimystic/README.md ("Warm Restart")
repro: verified
----

# Problem

The optimystic plugin keeps one catalog record per table (a JSON value in the schema tree). A downstream host writes that record on every machine at every launch before talking to any peer, which is only safe while every machine writes identical bytes for the same declaration.

Index order in the record follows creation order. Reproduced on 2026-09-17 against the rebuilt plugin (a scratch mocha spec, since deleted):

- Version 1: `table t { id integer primary key, a integer null, b integer null }` plus `unique index ByA on t (a)`.
- Version 2 (D): same table, `index ByB on t (b)` declared *before* `unique index ByA on t (a)`.
- Fresh apply of D stores `indexes: [ByB, ByA]`. Apply version 1 then D stores `indexes: [ByA, ByB]`.

Cause: `addIndex` appends the new index to the persisted list (`indexes: [...storedSchema.indexes, new]`), and `mergeIndexLists` keeps the incoming order and appends persisted-only entries. Neither sorts.

The same class applies to `checkConstraints` once the sibling ticket `optimystic-alter-add-check-persists` lets a later version add a named CHECK: the engine appends it, while a fresh declaration puts it where it is declared. Canonicalise both lists here, at the same site, so that ticket only has to persist.

Quereus's own engine catalog is itself history-dependent on this point: a memory table created by version 1 then migrated to D also lists its indexes in creation order. So "hydrated table equals declared table field for field" cannot mean "same list order" once migrations are involved; order of `indexes` and `checkConstraints` carries no meaning for results.

# Fix

One canonical order, applied wherever a stored record is produced, so every write and every compare sees it:

- `indexes` and `orphanedIndexes`: sort by `name` with a plain code-point compare (not locale-aware, so it is identical on every machine). Index names are unique within a table.
- `checkConstraints`: stable sort by `name`, unnamed entries (`name` undefined) first in their existing relative order. Unnamed CHECKs only ever come from a single declaration (Quereus's differ never adds one — see `blocked/quereus-differ-ignores-unnamed-constraint-additions`), so their relative order is already deterministic.
- Apply it in `tableSchemaToStored` (so the connect-time candidate compares equal to a sorted persisted record and does not trigger a redundant write every launch) **and** in `mergePersistedSchemas` output (so `addIndex`'s appended list and every merged write come out sorted). A small `canonicalizeRecordOrder` helper used by both is the obvious shape; keep `mergeIndexLists` itself order-agnostic or have it sort — either is fine once the output is sorted.
- Hydrate then rebuilds `TableSchema.indexes` / `checkConstraints` in canonical order. Existing records with a non-canonical order are rewritten once, on their next schema write; no migration step.

Accepted consequence to record as a `NOTE:` at the sort site: the plugin's `getBestAccessPlan` takes the first of two equally-costed indexes, so a hydrated table may pick a different (equally good) index than a table declared in this session; and when several CHECKs fail on one row the reported one may differ. Neither changes results.

# Test — the general guard

Replace the ad-hoc paths in "writes byte-identical catalog records…" with a migration-path property (keep the existing era / reflow / table-order / applied-twice cases):

- For declaration D (`EVERY_FEATURE`, extended with a third index declared *before* an existing one, e.g. `index ByScore on Every (Score)` placed first), derive earlier versions from D: drop each index in turn; swap the declaration order of two indexes; drop all indexes. Rows written between versions.
- For each earlier version V: apply V, insert a row, apply D, then assert catalog bytes equal a fresh apply of D.
- Remove the "NOT covered" comment in that test.
- `declarationView` in the same spec: normalise `indexes` and `checkConstraints` order (sort by name) before comparing, with a one-line comment saying list order is history-dependent in Quereus's own catalog too. Also compare a *hydrated* table against a declared one after a migration path, not only after a fresh apply.

CHECK-order cases join the property in `optimystic-alter-add-check-persists`, since until that lands a later version cannot add a CHECK to the record at all.

# TODO

- Add the canonical-order helper in `schema-manager.ts`; call it from `tableSchemaToStored` and on `mergePersistedSchemas`' result (covers `indexes`, `orphanedIndexes`, `checkConstraints`).
- Update the `mergeIndexLists` doc comment ("`incoming` keeps its order") to match.
- `NOTE:` at the sort site about plan tie-break / first-reported CHECK.
- Extend `hydrate-restores-declared-table.spec.ts` as above; confirm the new index-order cases fail before the fix and pass after.
- Check other specs that assert index or CHECK order on a record or hydrated table (`grep -rn "indexes" packages/quereus-plugin-optimystic/test`) and adjust only where they encode creation order.
- README "Warm Restart": state that the record is independent of migration history for index order.
- `yarn build` and the plugin's full `yarn test` in `packages/quereus-plugin-optimystic`.
