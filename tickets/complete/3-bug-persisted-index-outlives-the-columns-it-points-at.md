description: A table re-created with its columns in a different order kept its saved indexes and uniqueness rules pointing at whichever column now sat in the old slot, so rows vanished from some queries and duplicates slipped into unique columns. Fixed by saving indexed columns under the column's name instead of its position; reviewed and landed.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/schema-redeclare-column-identity.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-index-durability.spec.ts, tickets/backlog/debt-optimystic-key-format-migration.md, tickets/backlog/bug-drop-table-leaves-the-rows-behind.md
----

## What shipped

The plugin's schema catalog (one record per table in `tree://optimystic/schema`) stored
each index column as a **position** into the table's column list. A later `CREATE TABLE`
on the same name (no `DROP`) replaces the column list while the index list survives the
write, so "position 2" silently came to mean a different column. Two symptoms, one cause:
an indexed seek returned nothing for a row that exists, and the synthesized
UNIQUE-enforcement tree — *named* by column position (`_uniq_1`), and that name is its
storage URI — read the other column's key space, admitting a duplicate and rejecting a
legitimate value.

The fix splits the schema into two shapes with the conversion at one boundary:

- `StoredTableSchema` — the resolved, in-memory shape, index columns by position.
  Unchanged; every consumer (`IndexManager`, `RowCodec`, planner, uniqueness probe) is
  untouched.
- `PersistedTableSchema` / `PersistedIndexColumn { name }` — the on-disk shape, index
  columns by column **name**, matched case-insensitively.
- `toPersistedSchema` / `toStoredSchema` convert between them, each against the record's
  *own* column list. `SchemaManager` applies them at the only three catalog touch points
  (`storeStoredSchema`, `readSchemaFromCatalog`, the `listTables` cache-seeding walk).
- `mergePersistedSchemas` unions the index lists by name and validates. A re-declare that
  drops a column a persisted index covers now throws at the write with the way out named.
- `assertPositionsInRange` runs on both sides of the boundary for the fields that stay
  positional (`primaryKeyDefinition`, `uniqueConstraints`).
- The enforcement tree's name comes from `uniqueEnforcementTreeName(columnNames)` —
  lowercased, sorted, length-prefixed — so it survives a reorder. Old `_uniq_<positions>`
  trees are left unreferenced and the renamed tree is rebuilt from the table by
  `ensureUniquePopulated` on first probe.

Both on-disk format changes are recorded as an arm on
`tickets/backlog/debt-optimystic-key-format-migration.md`.

## Review findings

Read the implement diff (`8599d6e8`) first, then the surrounding sources. Everything
below was checked in this pass.

### Verified — the negative control the handoff said was missing

The handoff's headline gap was that the sweep spec had only ever been run green, so
nothing proved it *could* go red. Ran both controls; both arms are genuinely covered:

- **Arm A (catalog shape).** Patched `toPersistedSchema`/`toStoredSchema` back to
  positional persistence. Both cases of `schema-redeclare-column-identity.spec.ts` fail —
  the sweep at `column order (a, c, b), round 2` on the duplicate that must be rejected,
  and the shrink case on the missing actionable message.
- **Arm B (enforcement tree naming).** Restored `name: \`_uniq_${setKey}\`` alone, with
  the catalog fix intact. The sweep fails at `column order (b, c, a), round 4`. So the
  tree-naming arm is independently pinned, not merely carried by the catalog arm.

Sources restored from a scratchpad copy afterwards; `git status` clean before any of my
own edits.

### Fixed in this pass (minor)

- **Docs were stale for two user-visible changes.** The plugin README has a `Limitations`
  list and a hydrate-time upgrade-caveat paragraph that are the natural homes for both,
  and neither was touched. Added: (a) a Limitations bullet stating that a re-declare may
  reorder or add columns freely but may not drop one a persisted index covers, quoting
  the exact refusal message; (b) a format-break caveat saying a catalog written with
  positional index columns cannot be read and there is deliberately no fallback.
- **`uniqueEnforcementTreeName`'s central claim was untested.** Its doc argues the join
  must be length-prefixed because a bare `_` join collides `(a_b, c)` with `(a, b_c)` —
  a collision would make two different UNIQUE constraints enforce over one tree — and
  nothing asserted it. The function is also exported from `index.ts` as public API. Added
  a `uniqueEnforcementTreeName` block to `schema-catalog-write-path.spec.ts` covering
  order/case insensitivity, the `_`-collision, and the reserved prefix.
- **No general check that the conversions preserve everything but the address.** The
  per-case tests all use bare single-column indexes, so a conversion that dropped `desc`,
  `collation`, `unique` or `predicate` would have passed. Added a round-trip test over an
  index carrying all four: de-resolve, resolve back (identity), then resolve the same
  record against a reordered column list and assert only the addresses moved. Rung 2 of
  the ladder — one test for the class, so a field added later is covered without a test
  per field.
- **Doc said `assertPositionsInRange` is "the write-time boundary check"** when it also
  runs on every read via `toStoredSchema`. Corrected.
- **`uniqueEnforcementTreeName`'s doc example `_uniq_3.foo_3.bar` is not what the function
  produces** — parts are sorted, so it is `_uniq_3.bar_3.foo`. Corrected. (The example in
  the migration ticket, `_uniq_1.a_1.b`, was already right.)

### Closed by audit — the handoff's open question, not an instance

The handoff flagged that partial-index `predicate` and `uniqueConstraints[].predicate`
ASTs are persisted verbatim and might be "a fourth instance of the class", unaudited.
Audited against Quereus 4.17: they are parser `Expression` trees, and every column
reference in that union (`ColumnExpr`, `IdentifierExpr`) carries a column **name** —
there is no positional column node at all. A predicate cannot drift the way a positional
index descriptor could. Recorded on `PersistedTableSchema`'s doc so nobody re-audits it.

### Filed as a ticket (major)

- `tickets/backlog/bug-drop-table-leaves-the-rows-behind.md` — **`DROP TABLE` deletes only
  the catalog entry; the rows and index trees stay in storage.** The handoff observed this
  and asked whether it warranted a ticket. It does, and it is worse than "the old rows come
  back": verified that dropping a `(id, a, b)` table and re-creating `(id, z integer)` at
  the same URI returns `[{ id: 1, z: null }]` — a row nobody inserted, with a NULL in a
  column Quereus declares `NOT NULL`. Root-cause site is a single one, `OptimysticModule.destroy`
  (`src/optimystic-module.ts:3379`). Filed rather than fixed because the fix is a genuine
  design decision (delete the collection, or refuse to re-create over it; the plugin has no
  whole-collection delete primitive today, and other nodes may be reading). Ladder climbed
  and it is a real one-off root cause, not a class. Also documented as a README Limitations
  bullet in this pass so the behaviour is not a surprise while the ticket waits.

### Recorded as tripwires, not tickets

- **`hydrateCatalog`'s cold-start regex vs. user identifiers.** `hydrateCatalog` swallows a
  `listTables` error matching `/not found|missing|empty/i` as "no catalog yet". The
  implementer worded the new unresolvable-record error to dodge those words and left a
  `NOTE:` saying so — but the message interpolates the table, index and column names, so a
  corrupt record on a table with a column literally named `missing` would still be swallowed
  and hydrate would report zero tables. Conditional on an already-corrupt catalog. Extended
  the existing `NOTE:` on `toStoredSchema` to say the dodge covers only the fixed words, and
  named the real fix (a typed cold-start signal from `requireSchemaTree`, not wider wording).
- **One unresolvable record makes the whole catalog unlistable.** `listTables` resolves every
  entry through `toStoredSchema`, which throws, so hydrate finds no tables at all rather than
  hydrating the good ones. Deliberate while the only producer of such a record is a
  pre-format-change build, where a partial hydrate is the more confusing answer. `NOTE:` at
  `SchemaManager.resolveAndCache` naming the condition (a record this build legitimately
  cannot resolve) that should turn the walk into per-table failure collection.

### Checked and clean — no finding

- **Case-collapsing column names.** `columnPositions` and `uniqueEnforcementTreeName` both
  lowercase, so two columns differing only in case would collapse to one position / one tree.
  Not reachable: Quereus rejects the declaration outright (`Duplicate column name: stamp`),
  verified.
- **URI-unsafe characters in a tree name.** The enforcement tree name is now built from user
  column names and becomes a URI component. A `unique` column named `a/b` enforces correctly
  end-to-end, verified. Declared index names already flowed into the same position before this
  change, so nothing new is exposed.
- **Enforcement trees are not persisted in the catalog.** `buildUniqueEnforcementIndexes`
  feeds `IndexManager.setUniqueEnforcementIndexes` only, so retired `_uniq_<positions>` names
  never entered the catalog's index list and cannot survive the merge as phantom entries.
- **`mergeWithPersisted` matches the write.** Same de-resolve → union → validate → resolve
  sequence as `storeStoredSchema`, so `doInitialize`'s no-write short-circuit compares against
  exactly what a write would land, and the shrink refusal surfaces from the DDL rather than
  from a later write. Pinned by a test, and the sweep spec's shrink case asserts the message
  reaches the user through the module wrapper.
- **Handoff items reviewed and left as-is:** `listTables` still lists tombstoned names
  (`hydrateCatalog` skips them via `getSchema`, unchanged behaviour); the sweep's re-issued
  `CREATE INDEX` (necessary — the planner routes from Quereus's in-memory catalog, which a
  bare `CREATE TABLE` leaves index-less — and the ticket's table-only shape is still covered
  by the final hydrate-only session); the four specs whose prose mentions `_uniq_1`.
- **Source hygiene.** `schema-manager.ts` is 848 lines and gained ~330 well-scoped ones;
  functions are short and single-purpose (`columnPositions`, `describeColumns`,
  `unresolvedIndexColumns`, `assertPositionsInRange` each do one thing) and the comment
  density matches the file. `optimystic-module.ts` is 3400 lines, which is a real problem —
  already tracked by `tickets/backlog/debt-optimystic-vtab-class-is-too-big-to-review.md`, and
  this change added 36 lines to it, so no new arm is warranted.
- **Accepted tradeoffs.** No finding of mine landed on a site carrying an accepted-tradeoff
  `NOTE:`. Site-claim grep over the open board found `debt-optimystic-key-format-migration`
  (already carries this change's arm), `debt-index-sweep-misses-update-delete-and-orphans`
  and `debt-optimystic-vtab-class-is-too-big-to-review` (neither overlaps a finding), and
  `more-design/6.5-schema-versioning` (design, not a site claim).

### Empty categories

No **security** findings — the change touches no auth, network or serialization-of-untrusted-input
path; the catalog is written and read by the same trusted plugin. No **resource-cleanup**
findings — the change allocates only short-lived maps and arrays inside pure conversion
functions, and adds no handle, listener or tree that needs releasing. No **performance**
findings — the conversions are O(columns × index columns) per catalog read/write, which happens
once per table per open, not per row; nothing on a DML or scan path changed.

## Validation

From `packages/quereus-plugin-optimystic`:

- `yarn build` — clean.
- `yarn test` — **671 passing, 13 pending, 0 failing** (667 before this review pass; the 4 new
  ones are the tests added above). The 13 pending are the pre-existing `OPTIMYSTIC_INTEGRATION=1`
  env-gated specs.
- `npx eslint` on every file changed in the implement commit and in this pass — clean.
- Root `yarn typecheck` — clean.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
