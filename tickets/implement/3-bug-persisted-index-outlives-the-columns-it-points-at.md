description: When a table is re-created with its columns in a different order (without dropping it first), its saved indexes and uniqueness rules keep pointing at whichever column now sits in the old slot — so rows silently vanish from some queries and duplicate values are accepted into columns declared unique.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/schema-catalog-index-durability.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts, packages/quereus-plugin-optimystic/test/key-tuple-types.spec.ts
difficulty: hard
repro: verified
----

## The defect in one line

The plugin identifies an indexed column **by its position** in the table's column
list, and that identification is persisted — but the column list it was computed
against is not. When a later `CREATE TABLE` on the same name changes the column
layout, position 2 stops meaning what it meant, and nothing notices.

## Two arms, one root cause

Both arms are the same mistake at two code sites: *column identity stored as a
position, outliving the column list that gave the position meaning.* Fix them
together — fixing only one leaves the class alive and half the symptoms standing.

### Arm A — the catalog record's index columns

`StoredIndexSchema.columns[].index` (`src/schema/schema-manager.ts:134`) is a column
position. On a re-declare, `doInitialize` (`src/optimystic-module.ts:447-483`) takes
the **new** column list from the local DDL but **preserves** the persisted index list
(`mergeIndexLists`). Both rules are individually correct; together they write a record
whose index positions describe the old layout and whose column list is the new one.

### Arm B — the synthesized unique-enforcement tree names

`columnSetKey()` (`src/schema/schema-manager.ts:22`) joins sorted column
**positions**, and `buildUniqueEnforcementIndexes` (`src/optimystic-module.ts:1405`)
uses that string as the enforcement index's name — which becomes its tree URI
(`openIndexTree`, `src/optimystic-module.ts:2455`: `<collectionUri>/index/<indexName>`).
The URI is persistent storage. After a column reorder, `_uniq_1` names a different
column than the one whose values are stored in the `_uniq_1` tree, and the uniqueness
probe reads the wrong key space.

## Reproduction (re-verified 2026-08-29 on `main` @ 17c6b685)

Harness: `test/schema-catalog-index-durability.spec.ts`'s
`buildSharedLocalTransactor` / `registerWithSharedTransactor` over one
`MemoryRawStorage`, plus `queryAll` from `test/query-helpers.js`. Requires a built
`dist/` (the specs import `../dist/plugin.js`).

### Arm A, reorder — a matching row silently missing

```sql
-- session A
create table t (id integer primary key, a text, b text) using optimystic('tree://cs/t');
create index idx_b on t(b);
insert into t values (1, 'aaa', 'bbb');
-- session B: same table, b and a swapped, no drop
create table t (id integer primary key, b text, a text) using optimystic('tree://cs/t');
```

Observed catalog record after session B, and a third session's answers after
`plugin.hydrate(db)`:

```
BEFORE cols: [ id, a, b ]
BEFORE idx : [{"name":"idx_b","columns":[{"index":2,...}]}]     <- position 2 == b
AFTER  cols: [ id, b, a ]
AFTER  idx : [{"name":"idx_b","columns":[{"index":2,...}]}]     <- position 2 == a now

select * from t               -> [{"id":1,"b":"bbb","a":"aaa"}]
select * from t where a='aaa' -> []                              <- WRONG; the row exists
select * from t where b='bbb' -> [{"id":1,"b":"bbb","a":"aaa"}]
```

### Arm A, shrink — previously un-run, now measured

Re-declaring with **fewer** columns than the persisted index position:

```sql
create table s (id integer primary key, a text, b text) using optimystic('tree://cs/s');
create index idx_sb on s(b);
insert into s values (1, 'aaa', 'bbb');
-- then, no drop:
create table s (id integer primary key, a text) using optimystic('tree://cs/s');
```

Observed: **no error at any point.** The catalog ends as `cols: [id, a]`,
`idx_sb -> {"index":2}`. `IndexManager.createIndexKey` does `row[indexCol.index] ?? null`
(`src/schema/index-manager.ts:239`), so position 2 on a two-column row is `undefined`
and every subsequent row is indexed under the NULL key. The scan and a follow-up insert
both succeed silently. So the answer to the ticket's open question is *wrong key, not a
throw* — the harsher of the two possibilities.

### Arm B, reorder — duplicate rows admitted into a UNIQUE column

```sql
-- session A
create table u (id integer primary key, a text unique, b text unique) using optimystic('tree://cs/u');
insert into u values (1, 'A1', 'B1');
-- session B: a and b swapped, no drop
create table u (id integer primary key, b text unique, a text unique) using optimystic('tree://cs/u');
insert into u values (2, 'A1', 'A2');   -- b='A1', no existing row has b='A1'
insert into u values (3, 'B1', 'A3');   -- b='B1', row 1 already has b='B1'
```

Observed in session B:

```
b=A1 (should be ALLOWED):         REJECTED -> ConstraintError: UNIQUE constraint failed: u.b
b=B1 (should be REJECTED as dup): accepted
B rows: [{"id":1,"b":"B1","a":"A1"},{"id":3,"b":"B1","a":"A3"}]
```

Two rows now share `b='B1'` in a column declared `unique`, and a legitimate value was
refused. This is a data-integrity failure, strictly worse than Arm A's wrong answer.

## The fix: persist column identity by NAME, resolve to positions on load

Positions are a fine *runtime* representation — the row is a positional array and
every hot path indexes into it. They are not a valid *persisted* one, because the
thing that gives a position meaning is not stored alongside it. Split the two.

### Two types, one conversion boundary

Keep `StoredTableSchema` exactly as it is today — a **resolved, in-memory** shape
with positional index columns — and introduce a distinct **persisted** shape whose
index columns carry names:

```ts
/** On-disk. Column identity is a NAME, so it cannot drift. */
export interface PersistedIndexColumn {
	name: string;
	desc?: boolean;
	collation?: string;
}
export interface PersistedIndexSchema {
	name: string;
	columns: PersistedIndexColumn[];
	unique?: boolean;
	predicate?: unknown;
}
/** …and a PersistedTableSchema identical to StoredTableSchema except `indexes`. */
```

`SchemaManager` owns the only conversion between them:

- **Read** (`readSchemaFromCatalog`, and the cache-seeding walk in `listTables`):
  resolve each index column name against **that record's own** `columns` list, into
  the positional `StoredTableSchema` every consumer already expects. A name with no
  match is an unresolvable record — throw, naming the table, the index, and the
  missing column.
- **Write** (`storeStoredSchema`): de-resolve the incoming positional schema to names
  using **its own** column list, union with the persisted (already name-keyed) record,
  validate that every surviving index column name exists in the merged record's column
  list, then write. Return the resolved form actually written, as it does now.

The payoff is that the invariant holds by construction: a resolved `StoredTableSchema`
can only be produced by resolving against its own column list, so `IndexManager`,
`RowCodec`, `buildUniqueEnforcementIndexes`, the planner (`getBestAccessPlan`,
`orderingMatchesIndex`) and every test that hand-builds a `StoredTableSchema` need
**no change at all**. Only the catalog boundary moves.

Traced against the reproduction, the reorder case now resolves `idx_b`'s name `b` to
position 1 in the new layout, writes it back as the name `b`, and the seek finds the
row — the index tree's contents never had to change, because they were always keyed on
`b`'s values.

### The shrink case must fail loudly

Under the merge rule above, a re-declare that drops an indexed column produces a record
whose index names a column the record does not have. That is exactly the state the
representation makes detectable, so throw at the write with an actionable message
rather than deferring to a later load:

```
Cannot re-declare table 's' without column 'b': persisted index 'idx_sb' covers it.
Drop the index or the table first.
```

`DROP TABLE` tombstones the catalog entry (`SchemaManager.deleteSchema`), so
drop-then-recreate is unaffected. Only the silent-corruption path changes behaviour.

### Arm B: split `columnSetKey`'s two jobs

`columnSetKey` is doing two unrelated things and only one of them is broken:

1. **In-memory set matching** — `declaredKeys`, `resolveEnforcingIndex`
   (`src/optimystic-module.ts:1391, 1432, 1438`). Every comparison is within one
   already-resolved schema, so positions are correct here. **Leave it positional.**
2. **Persistent tree identity** — `_uniq_${setKey}` at `src/optimystic-module.ts:1405`.
   **This one must be name-based.**

Give job 2 its own function (e.g. `uniqueEnforcementTreeName(columnNames)`), fed the
constraint's column *names* resolved off the current schema. The join must be
injective: SQL identifiers can contain `_`, so a bare `_`-join collides (`a_b` + `c`
vs `a` + `b_c`). Use a length-prefixed join — `_uniq_3.foo_3.bar` — which stays
injective and stays readable in a tree URI and a log line. Sort the lowercased names
so `(a, b)` and `(b, a)` name one tree, matching today's semantics.

Renaming these trees is self-healing: `ensureUniquePopulated`
(`src/optimystic-module.ts:1463`) backfills any empty enforcement tree from a full
table scan, so the newly-named tree is rebuilt on first probe. Old `_uniq_<positions>`
trees become unreferenced storage — harmless, never read again, but say so in the doc
comment so a future reader is not left wondering.

### Leave the primary key and non-derived UNIQUE constraints positional — and assert it

`StoredPrimaryKeyColumn.index` and `StoredUniqueConstraint.columns` are also positional,
but they cannot drift *today*: both are re-written from the local declaration on every
schema write, always alongside the column list from the same source, so they are
consistent by construction. Naming them buys nothing and widens the on-disk change.

That safety is an unstated invariant, though, and the day someone preserves a persisted
UNIQUE constraint across a re-declare — the way indexes already are — the same silent
drift returns. So make the write-time validation cover **all three** uniformly: every PK
position and every UNIQUE-constraint position in a record being written must be in range
for that record's own column list. It is a few lines at one site and it is the boundary
check that catches the whole class, not just the arm being fixed here.

## On-disk compatibility

This changes the shape of the persisted catalog record (index columns gain `name`, lose
`index`) and the URIs of synthesized enforcement trees. Per `AGENTS.md` ("Don't worry
about backwards compatibility yet") and the package's pre-1.0 status, **do not build a
read-side fallback for the old positional form** — a `{ name?: string; index?: number }`
union would re-admit exactly the ambiguous state this ticket removes. Change the shape
outright.

Record the instance instead: append an arm to
`tickets/backlog/debt-optimystic-key-format-migration.md` noting that the catalog
record's index-column shape and the `_uniq_` tree URIs are two further on-disk changes
that whatever migration answer that ticket settles on must cover. That ticket is the
existing home for "the on-disk bytes changed"; do not file a new one.

## Test churn to expect

Tests that hand-build a **resolved** `StoredTableSchema` are unaffected by the two-type
split (`test/key-tuple-types.spec.ts`, `test/row-codec.spec.ts`,
`test/ordering-claim-guard.spec.ts` — verify, do not assume). Tests that touch the
**persisted** form do change: the `mergeIndexLists` unit block in
`test/schema-catalog-index-durability.spec.ts:191-220` and the stored-schema builder in
`test/schema-catalog-write-path.spec.ts:75-76`. `mergeIndexLists` itself moves to the
persisted (name-keyed) shape; its name-keyed union rules are otherwise unchanged.

No test asserts a literal `_uniq_1` string — every occurrence found is prose in a
comment (`test/secondary-unique-migration.spec.ts`, `test/secondary-unique-hydrate.spec.ts`,
`test/two-node-multi-collection-commit.spec.ts`, `test/two-node-shared-index-key.spec.ts`).
Those comments still need updating so they do not describe a scheme that no longer exists.

## Regression coverage

Prefer one **generalized** test over three point tests: a spec that creates a table with
an index and a UNIQUE column, re-declares it under each permutation of its non-PK
columns, and asserts after each that (a) a full scan and every indexed seek return the
same rows, and (b) a duplicate in a UNIQUE column is rejected while a non-duplicate is
accepted. That form catches this whole class — including the `_uniq_` arm and any future
field that starts outliving its column list — where three hand-written cases would only
pin the three reproduced above. `test/two-node-index-interleaving-sweep.spec.ts` is the
in-repo model for a generated sweep; keep this one small enough to stay in the default
`yarn test` run.

Add alongside it the one case that is not a permutation: the shrink re-declare must now
**throw** with the actionable message, rather than silently NULL-keying every row.

## Related

- `tickets/backlog/more-design/6.5-schema-versioning` — a table re-declared with a
  different shape is really a migration, and a full versioning design might subsume
  this. That is an unsettled design ticket; this defect does not wait on it, because
  naming index columns is independently correct.

## TODO

- Add `PersistedIndexColumn` / `PersistedIndexSchema` / `PersistedTableSchema` to
  `src/schema/schema-manager.ts`; keep `StoredTableSchema` as the resolved runtime shape
  with positional index columns.
- Write the resolve (names -> positions) and de-resolve (positions -> names)
  conversions, each against the record's own `columns` list; resolve failure throws
  naming table, index, and missing column.
- Move `mergeIndexLists` to the persisted, name-keyed shape; keep its union /
  never-downgrade-uniqueness rules unchanged and its unit block passing.
- Apply the conversions at the `SchemaManager` boundary only — `readSchemaFromCatalog`,
  the `listTables` cache-seeding walk, and `storeStoredSchema` (de-resolve, union,
  validate, write, return resolved).
- Add the write-time validation covering index columns, `primaryKeyDefinition`, and
  `uniqueConstraints`; make the shrink re-declare fail with the actionable message.
- Split `columnSetKey`: keep it positional for in-memory matching; add a name-based,
  length-prefix-joined `uniqueEnforcementTreeName` and use it for the `_uniq_` tree name
  in `buildUniqueEnforcementIndexes`. Document that old `_uniq_<positions>` trees are
  left unreferenced and that `ensureUniquePopulated` rebuilds the new ones.
- Update the doc comments on `columnSetKey`, `StoredIndexSchema`,
  `buildUniqueEnforcementIndexes` and `doInitialize`'s index-preservation block so they
  describe the name-based scheme.
- Update `test/schema-catalog-index-durability.spec.ts` and
  `test/schema-catalog-write-path.spec.ts` for the persisted shape; refresh the stale
  `_uniq_1` prose in the four specs listed above.
- Add the permutation sweep spec plus the shrink-throws case.
- Append the on-disk-shape arm to
  `tickets/backlog/debt-optimystic-key-format-migration.md`.
- Run `yarn build` then `yarn workspace @optimystic/quereus-plugin-optimystic test`
  (the specs import `dist/`), and `yarn typecheck` after the build.
