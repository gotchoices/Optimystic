description: Reopening a database via the fast warm-restart path stopped enforcing tables' uniqueness rules, because those rules were never saved alongside the table definition; they are now saved, restored on every open, and covered by tests.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/secondary-unique-hydrate.spec.ts
----

## What shipped

The optimystic virtual table enforces non-primary-key `UNIQUE` constraints in
application code, reading the constraint list from its in-memory table schema. That
list was only ever populated by parsing `CREATE TABLE` / `CREATE UNIQUE INDEX` DDL —
the persisted schema did not carry it, so any table opened through the documented
warm-restart path (`plugin.hydrate(db)` followed by no-op DDL) enforced nothing beyond
the primary key.

Implementation (commit `55e8453`):

1. **`StoredTableSchema.uniqueConstraints`** — persists each non-derived constraint's
   name, column indexes in declared order, declared conflict action, and partial
   predicate. Constraints derived from a `CREATE UNIQUE INDEX` are deliberately not
   stored here; they are reconstructed from the index's own `unique` flag so the index
   stays the single source of truth.
2. **`StoredIndexSchema.unique` + `predicate`** wired end-to-end. The old `addIndex`
   persist path re-mapped indexes to bare `{name, columns}` and silently dropped both.
3. **`SchemaManager.storedToUniqueConstraints`** — rebuilds the full constraint list
   (explicit + one derived per unique index) for both catalog hydration and vtab
   initialization.
4. **`attachPersistedUniqueConstraints`** — folds persisted constraints into the vtab's
   live schema on every open, so enforcement no longer depends on which DDL (if any)
   replayed: hydrate-only, placeholder connect, and partial re-declares all end up
   armed.
5. **`addIndex` restructure** — the derived-constraint mirror now runs before the
   already-persisted dedupe, closing a second enforcement hole where a re-declared
   `CREATE UNIQUE INDEX` early-returned and never armed the cached vtab. A dedupe hit
   whose persisted index lacks the `unique` flag now persists it in one write.

`schemasEqual` stabilization: `uniqueConstraints` is omitted (not `[]`) when a table
has none, and an index's `unique: false` is normalized to omitted. Constraint-free
tables persisted before this change stay byte-identical and never re-write; tables
with constraints miss the no-write short-circuit exactly once, then short-circuit from
the second open on.

Review then added the fix and tests described below.

## Review findings

### Checked

Read the implement diff (`git show 55e8453`) before the handoff summary; read every
touched source file in full plus the surrounding enforcement machinery
(`buildUniqueEnforcementIndexes`, `resolveEnforcingIndex`, `ensureUniquePopulated`,
`checkUniqueConstraints`, `addIndex`, `doInitialize`, `IndexManager`), and Quereus's
own `UniqueConstraintSchema` / `IndexSchema` definitions to check round-trip fidelity
field by field. Validated `yarn build`, `yarn typecheck`, `yarn test`, and `eslint`
over the touched files — all clean, 326 passing / 11 pending (the pending ones are the
pre-existing env-gated integration specs). Docs: `README.md`'s Warm Restart section is
the only place uniqueness persistence is described, and it is accurate; `docs/` has no
coverage of virtual-table `UNIQUE` enforcement, so nothing there was stale.

### Major — fixed in this pass

**A partial unique index masked a full one over the same columns, silently dropping
enforcement after hydrate.** Reconstruction deduped constraints by column set alone.
Given

```sql
create unique index ux_partial on T (Stamp) where Flag = 1;
create unique index ux_full    on T (Stamp);
```

the partial index sorts first in the persisted index list, claims the column set, and
the full index's constraint is discarded. Partial constraints are never point-enforced,
so the reopened table enforced *nothing* on `Stamp` — while the same DDL on a fresh
`create table` path enforced correctly. Confirmed by a test that failed before the fix
and passes after.

Fixed by giving constraints a dedupe identity that distinguishes the two kinds
(`uniqueConstraintKey` in `schema-manager.ts`): a full constraint is identified by its
column set, a partial one by the index it came from. Applied at all three dedupe sites
— `storedToUniqueConstraints`, `attachPersistedUniqueConstraints`, and
`mirrorDerivedUniqueConstraint`, which had the same masking hazard at runtime on a
fresh session.

### Minor — fixed in this pass

- **Duplicated `columnSetKey`.** The implement diff added a module-level copy in
  `schema-manager.ts` alongside the existing private method in `optimystic-module.ts`,
  with a comment asserting the two agree. Exported the one in `schema-manager.ts` and
  deleted the duplicate; all eight call sites now share it, so the two cannot drift.

### Major — filed as a new ticket

- **`backlog/bug-optimystic-constraint-level-on-conflict-ignored`** — a uniqueness rule
  declared `unique on conflict ignore` is not honoured; the table raises
  `UNIQUE constraint failed` instead of silently skipping the row. Only the
  statement-level `insert or ignore` spelling works. Pre-existing and reproducible on a
  plain `create table` with no hydrate involved, so not a regression from this ticket —
  it surfaced because the fix started persisting the declared action, making its being
  unused visible. Reproduction and expected precedence are in the ticket. Deliberately
  **not** landed as a failing test; a passing test pins the persistence round-trip
  instead, so the fix will have correct metadata to act on.

### Tripwires (recorded, not ticketed)

- `StoredUniqueConstraint` persists four of Quereus's seven `UniqueConstraintSchema`
  fields; `coveringStructureName`, `tags`, `exposedIndexTags` (and `IndexSchema.tags`)
  are dropped on round-trip. Harmless today — they are informational or describe
  covering materialized views, which optimystic-backed tables do not use — but hydrate
  would silently drop the link if one ever were. Parked as a `NOTE:` on the
  `StoredUniqueConstraint` declaration in `schema-manager.ts`.

### Test gaps — closed in this pass

The implement suite covered nine constraint shapes but only ever exercised `INSERT`,
single-constraint tables, and one constraint per column set. Added four tests to
`test/secondary-unique-hydrate.spec.ts`:

- partial index does not mask a full one over the same columns (the regression above);
- a table declaring several independent `UNIQUE` constraints enforces each of them
  after hydrate;
- `UPDATE` is enforced after a hydrate-only open — moving a row onto another's value is
  rejected, a no-op self-update is not, and a vacated value becomes reusable;
- a constraint-level `on conflict` action round-trips through persistence and hydrate.

### Checked and clean — no finding

- **Resource cleanup / error handling.** No new handles, subscriptions, or async
  lifetimes; the added code is pure schema transformation plus one copy-on-write of
  `this.tableSchema`. The `addIndex` upgrade path writes once and updates the
  `IndexManager` schema in the same step.
- **Type safety.** No new `any`. The three `as` casts bridge `unknown`-typed persisted
  predicate ASTs to Quereus's `Expression` at the boundary, which is the intended shape
  for a JSON-round-tripped AST.
- **Schema-write stability.** The claimed "constraint-free tables never re-write, tables
  with constraints re-write exactly once" contract is pinned by two of the implement
  tests; re-verified the omit-when-empty normalization on both `uniqueConstraints` and
  `unique: false` that makes it hold.
- **Enforcement ordering.** `attachPersistedUniqueConstraints` runs before
  `buildUniqueEnforcementIndexes` and before `registerCollections`, so synthesized
  `_uniq_` trees exist by the time the transaction bridge snapshots collections.
- **Candidate/persisted comparison.** The stored candidate is built from
  `this.tableSchema` *before* the persisted constraints are folded in, so the merge
  cannot induce a self-perpetuating rewrite loop.

### Noted, not actioned

`src/optimystic-module.ts` is 2235 lines. Pre-existing and untouched in spirit by this
change (which net-removed lines from it), but it is past the point where a reader can
hold it. Not filed as a ticket — splitting it is a decision about module boundaries
that deserves its own scoping rather than a drive-by from this review.

## How to validate

From `packages/quereus-plugin-optimystic`: `yarn build && yarn typecheck && yarn test`.
Env-gated integration tiers (`OPTIMYSTIC_INTEGRATION=1`, `RUN_LONG_TESTS=1`) were not
run, per project policy for agent runs.
