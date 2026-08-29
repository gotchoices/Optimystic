description: When a table is re-created with its columns in a different order (without dropping it first), its saved indexes and uniqueness rules kept pointing at whichever column now sat in the old slot — rows vanished from some queries and duplicates were accepted into unique columns. Fixed by identifying indexed columns by name on disk; needs a review pass.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/schema-redeclare-column-identity.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-index-durability.spec.ts, tickets/backlog/debt-optimystic-key-format-migration.md
difficulty: hard
repro: verified
----

## What was wrong

The plugin's schema catalog (one record per table in `tree://optimystic/schema`) stored
each index column as a **position** into the table's column list. A later `CREATE TABLE`
on the same name (no `DROP`) replaces the column list but preserves the index list, so
"position 2" silently came to mean a different column. Two symptoms, one cause:

- **Arm A** — a persisted index pointed at the wrong column after a reorder: an indexed
  seek returned nothing for a row that exists. After a re-declare that *dropped* the
  indexed column it went further: every later row was indexed under NULL, with no error.
- **Arm B** — the synthesized UNIQUE-enforcement tree was *named* by column position
  (`_uniq_1`), and that name is its storage URI. After a reorder the probe read the other
  column's key space: a duplicate was admitted, a legitimate value was rejected.

## What changed

**Two shapes, one boundary** (`src/schema/schema-manager.ts`):

- `StoredTableSchema` is unchanged — the resolved, in-memory shape with positional index
  columns. Every consumer (`IndexManager`, `RowCodec`, planner, uniqueness probe) is
  untouched.
- New `PersistedTableSchema` / `PersistedIndexSchema` / `PersistedIndexColumn { name }`
  — the on-disk shape; index columns carry the column **name**.
- `toPersistedSchema` (positions → names, against the schema's own columns) and
  `toStoredSchema` (names → positions, against the record's own columns; throws naming
  table, index and column when a name does not resolve). Name matching is
  case-insensitive, like the SQL layer.
- `mergePersistedSchemas` = name-keyed index union (`mergeIndexLists`, now over the
  persisted shape) + validation. A re-declare that drops a column a persisted index
  covers now **throws at the write**:
  `Cannot re-declare table 's' without column 'b': persisted index 'idx_sb' covers it. Drop the index or the table first.`
- `assertPositionsInRange` runs on every write for the fields that *stay* positional
  (`primaryKeyDefinition`, `uniqueConstraints`) — the boundary check that turns their
  "consistent by construction" into an enforced invariant.
- `SchemaManager` applies the conversions at the only three catalog touch points:
  `storeStoredSchema` (de-resolve → union → validate → write → return resolved),
  `readSchemaFromCatalog` and the `listTables` cache-seeding walk (both via a new
  `resolveAndCache`). New `mergeWithPersisted(candidate, persisted)` gives
  `doInitialize` exactly the write's preview for its no-write short-circuit.

**Enforcement tree naming** (`src/optimystic-module.ts`, `buildUniqueEnforcementIndexes`):
`columnSetKey` stays positional for in-memory set matching; the tree *name* now comes
from `uniqueEnforcementTreeName(columnNames)` — lowercased, sorted, length-prefixed
(`_uniq_5.stamp`, `_uniq_1.a_1.b`) so `_`-bearing identifiers cannot collide. Old
`_uniq_<positions>` trees are left unreferenced; `ensureUniquePopulated` rebuilds the
newly-named tree from the table on first probe (documented on both functions).

**On-disk compatibility**: no read-side fallback for the positional form, per the ticket
and `AGENTS.md`. Both format changes (catalog index-column shape, `_uniq_` URIs) are
recorded as a new arm in `tickets/backlog/debt-optimystic-key-format-migration.md`.

## How to verify

From `packages/quereus-plugin-optimystic` (specs import `dist/`, so build first):

```
yarn build
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/schema-redeclare-column-identity.spec.ts" "test/schema-catalog-write-path.spec.ts" --reporter spec --exit
yarn test          # full suite
```

Ran: `yarn build`, `yarn test` (667 passing, 13 pending — the pre-existing env-gated
specs), root `yarn typecheck`, `eslint` on every changed file. All clean.

### Regression coverage added

- `test/schema-redeclare-column-identity.spec.ts` — the generalized sweep. One table
  (`id` PK, `a` indexed, `b` UNIQUE with no declared index, `c` indexed) is re-declared
  under all six permutations of `(a, b, c)` in fresh sessions over shared storage, each
  re-issuing `create index if not exists` as an apply-schema would; after each,
  `expectIndexAgreesWithScan` (routing required) on `a` and `c`, a seek on `b`, a
  duplicate-`b` rejection and a fresh-`b` acceptance. Then a hydrate-only session repeats
  the oracle. Second case: the shrink re-declare throws the actionable message, the
  refused write leaves the record intact, and `drop table` → recreate works.
- `test/schema-catalog-write-path.spec.ts` — new `column identity across the catalog
  boundary` block over the fake tree: names on disk / positions in memory, reorder
  re-points the index, case-insensitive match, shrink refusal (nothing written),
  `mergeWithPersisted` preview, unresolvable record throws on read, PK/UNIQUE
  out-of-range positions refused.
- `test/schema-catalog-index-durability.spec.ts` — `mergeIndexLists` block moved to the
  persisted (name-keyed) shape.

## Known gaps / things for the reviewer

- **No negative control was run against the pre-fix code.** The fix ticket verified the
  reproduction by hand; the sweep spec was only ever run green. A reviewer wanting proof
  that it *can* go red could temporarily make `toStoredSchema` resolve by position, or
  restore the `_uniq_${setKey}` name, and watch which arm fails.
- **Why the sweep re-issues `CREATE INDEX`**: `getBestAccessPlan` routes seeks from
  Quereus's catalog `TableSchema.indexes`, which a bare `CREATE TABLE` in a fresh
  session leaves empty — so a table-only re-declare would not route seeks via the index
  even when the persisted index is correct. The `create index if not exists` path
  (`addIndex` → dedupe-by-name → `reconcileMaintainedIndexes`) is exercised under every
  reordered layout as a result. The ticket's exact "table only, then hydrate" shape is
  covered by the final hydrate-only session.
- **Observed, not fixed (pre-existing, outside this ticket's scope)**: `DROP TABLE`
  tombstones only the catalog entry; the data tree at the table's URI keeps its rows. A
  drop-then-recreate on the same URI therefore inherits the old rows (the spec's shrink
  case had to use a fresh PK to avoid colliding with the old row 1). Nothing on the board
  tracks this; the reviewer should decide whether it warrants a `backlog/` ticket.
- **`listTables` still lists tombstoned names** (pushes `entry[0]` for `[name, undefined]`
  entries) — unchanged behaviour, `hydrateCatalog` skips them via `getSchema` returning
  undefined. Left as is.
- `hydrateCatalog` swallows a `listTables` error whose message matches
  `/not found|missing|empty/` as "cold start". The new unresolvable-record error is worded
  to avoid those words (noted in a `NOTE:` on `toStoredSchema`); that regex is fragile and
  a reviewer may want a typed cold-start signal instead.
- Partial-index `predicate` and `uniqueConstraints[].predicate` ASTs are persisted
  as-is; if they reference columns by position anywhere, that is a fourth instance of the
  class. I did not audit the AST shape.
- Prose mentioning `_uniq_1` in four specs was refreshed; two of them quote a downstream
  log signature verbatim and now carry a parenthetical about the old scheme rather than a
  rewrite of the quote.
