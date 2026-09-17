description: A table's catalog record now lists its indexes and CHECK rules in name order, so two machines that end at the same schema version store identical bytes no matter which earlier versions they went through. Review the change and its tests.
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`canonicalizeRecordOrder`, `sortByName`, `compareOptionalNames` next to `mergeIndexLists`; called at the end of `mergePersistedSchemas` and wrapping the return of `tableSchemaToStored`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (connect-time comment only, ~L648: a record from before this change misses the no-write short-circuit once)
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts (fixture, `declarationView`, the migration tests)
  - packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts (new `canonical list order` describe)
  - packages/quereus-plugin-optimystic/README.md ("Warm Restart", session-binding paragraph)
----

# What changed

The optimystic plugin keeps one catalog record per table. The lists in it whose order means nothing used to follow creation order. So a machine that got an index from a later schema version (declared *before* an existing index) stored different bytes than a machine that applied the final version fresh. A downstream host writes that record on every machine before any peer contact, so the bytes have to match.

One helper, `canonicalizeRecordOrder` in `schema-manager.ts`, now puts three lists in a fixed order:

- `indexes` and `orphanedIndexes`: by `name`, compared by UTF-16 code unit (not locale-aware).
- `checkConstraints`: by `name`. Unnamed entries come first and keep their relative order. The sort breaks ties by original position, so it doesn't depend on the engine's sort being stable.

It runs in two places:

- **On every record a write produces:** the end of `mergePersistedSchemas`. That covers `storeStoredSchema`, the APPLY SCHEMA catalog batch (both staging and its commit-time re-merge) and `mergeWithPersisted`, so `addIndex`'s appended list comes out sorted.
- **On every candidate built from a live table:** `tableSchemaToStored`.

Because the persisted record comes back sorted, hydrate rebuilds `TableSchema.indexes` and `checkConstraints` in name order. `mergeIndexLists` itself is unchanged (its doc comment now says the order it returns doesn't matter).

A `NOTE:` on `canonicalizeRecordOrder` records the accepted consequence. A hydrated table lists indexes and CHECKs by name, while a table declared in this session lists them as declared. So `getBestAccessPlan` (which keeps the first of two equally-costed indexes) may pick a different but equally good index, and when a row fails several CHECKs a different one may be reported. Neither changes results.

# Tests (all green: `yarn build`, `yarn typecheck`, full `yarn test` in the plugin package: 970 passing, 13 pending, 0 failing, smoke ok)

`hydrate-restores-declared-table.spec.ts`:

- **Fixture:** `EVERY_FEATURE` is now built by `everyFeatureDeclare(indexes)` from `EVERY_FEATURE_INDEXES`. That list gains `index ByScore on Every (Score)`, declared *first* but sorting last by name. The two hydrate-count assertions now expect `indexes: 3`.
- **`declarationView`:** sorts `indexes` and `checkConstraints` by name before comparing, with a comment on why. Quereus's own catalog is creation-ordered.
- **"writes byte-identical catalog records … era or layout":** keeps the era, reflow, table-order and applied-twice cases. The ad-hoc "earlier version" path and the "NOT covered" comment are gone. The local `applyIn` became the module-level `catalogAfter`.
- **New: "writes the same catalog record … whichever earlier version a machine migrated from"** (the property test). It covers 12 earlier versions derived from the declaration: every proper subset of the three indexes (each dropped, pairs dropped, all dropped) and every other declaration order. For each one it applies that version, inserts rows, applies the full declaration, and checks the bytes equal a fresh apply.
  - **Verified to fail without the fix.** With the sort short-circuited it fails first on "earlier version with indexes [ByBig]": the record lists `ByBig, ByScore, ByNote` against the reference's `ByScore, ByBig, ByNote`.
- **New: "hydrates a migrated table as the table its declaration creates".** Storage migrates from a version without `ByScore`, then:
  - a new session hydrates it and the table equals a freshly declared one under `declarationView`;
  - the migrating session's own table equals the fresh one too;
  - a session that re-declares instead of hydrating commits nothing;
  - `expectEveryBehaves` passes on the hydrated table.
  - This one is a guard, not a discriminator: it also passes without the fix, because `declarationView` normalises order and the merge-then-compare already matched.

`schema-catalog-write-path.spec.ts`, new `canonical list order` describe:

- `storeStoredSchema` over a creation-ordered persisted record (indexes and `orphanedIndexes`) plus incoming indexes and a mixed named/unnamed CHECK list. It writes indexes `[idx_a, idx_b, idx_m, idx_z]` and orphans `[b_old, z_old]`. CHECKs come out unnamed first in their own order, then `B`, `_check_id`, `b` (code-unit order).
- `tableSchemaToStored` on a real Quereus memory table whose catalog lists `ib, ia` and `zc, ac` gives `ia, ib` and `ac, zc`.

CHECK-order cases in the migration property belong to `optimystic-alter-add-check-persists`, since until that lands a later version can't add a CHECK to the record.

# Known gaps / things to look at

- **Existing non-canonical records are not migrated.** They are rewritten once, on their next schema write. A host that only hydrates and never re-declares or adds an index keeps the old order (and old bytes) until then, as the ticket intended. A re-declaring open misses the connect-time no-write short-circuit exactly once (comment added at `optimystic-module.ts` ~L648).
- **Code unit vs code point.** The ticket said "code-point compare". JS `<` compares UTF-16 code units, which differs from code-point order only for names that mix astral characters with U+E000–U+FFFF. Both are identical on every machine, which is the requirement, and the comment says "UTF-16 code unit" honestly. Flip it if you want true code-point order.
- **The sort in `tableSchemaToStored` is mostly belt-and-braces.** Every write goes through `mergePersistedSchemas`, which sorts anyway, and when a persisted record exists the connect-time compare uses the merged (sorted) candidate. It matters for candidates used without a merge: the provisional read-only arm when no record exists, and callers of `tableSchemaToStored` outside the write path.
- **Gravestones are not re-sorted.** `deleteSchema` copies the record as it stands. A gravestone of a pre-change record keeps its old order; gravestones carry a `droppedAt` timestamp, so they were never byte-identical across machines anyway.
- **`uniqueConstraints` on a hydrated table is untested for order.** It is rebuilt from the index list (`storedToUniqueConstraints`), so derived unique constraints now follow index-name order. A table with two or more unique indexes could therefore list them in a different order from a declared one. `declarationView` does not normalise `uniqueConstraints`, and the fixture has only one unique index, so this is not exercised. It changes no enforcement.
- The whole hydrate spec takes about 0.7s. The property test adds 12 fresh-storage apply pairs (about 0.3s).
