description: When a database is reopened using the fast warm-restart path, the tables' uniqueness rules stop being enforced, so duplicate values can slip in — including the single-use values the control database relies on to reject replayed requests.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
difficulty: hard
----

## What is wrong

The optimystic virtual table enforces every non-primary-key UNIQUE constraint in
application code — the B-tree only structurally guarantees the primary key, because
index trees key on `indexCols‖pk` and so let duplicate index values with distinct
primary keys coexist. That enforcement reads its constraint list from the live table
schema object (`this.tableSchema.uniqueConstraints`, read at
`optimystic-module.ts:845` and `:1010`).

That list is populated only when Quereus parses a `CREATE TABLE` for the table. The
persisted schema form (`StoredTableSchema`, `schema-manager.ts:19`) does not carry it,
and `SchemaManager.storedToTableSchema` (`schema-manager.ts:185`) does not reconstruct
it — the returned `TableSchema` has `uniqueConstraints === undefined`.

So a table reached through catalog hydration (`hydrateCatalog`,
`optimystic-module.ts:1814`, wired as the plugin's `hydrate` hook in `plugin.ts:73`)
has no unique constraints in memory. `checkUniqueConstraints` sees an empty list and
enforces nothing beyond the primary key; `buildUniqueEnforcementIndexes`
(`optimystic-module.ts:844`) synthesizes no `_uniq_` trees.

### This is the documented path, not an exotic one

The original report framed this as path-conditional — "the common node path re-CREATEs
its tables and is unaffected." That framing is backwards. Hydrate is not an alternative
to re-declaring the table; hydrate is *the mechanism that suppresses* the re-declare.
The package README (`README.md:34-48`) documents warm restart as exactly this:

```typescript
await plugin.hydrate(db);                                     // catalog now lists the tables
await db.exec(`declare schema App { ... } apply schema App;`); // "no-op after hydrate"
```

That no-op is hydrate's entire purpose — skipping a `CREATE TABLE` (plus per-index
`CREATE INDEX`) round-trip through the schema tree for every table on every cold start.
But `CREATE TABLE` is the only carrier of `uniqueConstraints`. So any host following the
documented warm-restart sequence gets a catalog entry with no unique constraints, for
the life of that process. Re-declare-on-open only still enforces for hosts that do *not*
call `hydrate` — i.e. hosts paying precisely the cost hydrate exists to remove.

This rules out the "document an invariant + assert instead of fixing it" option the
original report floated as its first question. The invariant it would document is "never
call `hydrate` on a schema carrying a secondary UNIQUE", which contradicts the README
and removes hydrate's reason to exist for those schemas; the assertion would fire on the
documented flow. Enforcement has to survive hydration.

### Second, independent leak: `CREATE UNIQUE INDEX`

Uniqueness declared via `CREATE UNIQUE INDEX` is lost on hydrate too, by a separate
route. `StoredIndexSchema` *declares* `unique?: boolean` (`schema-manager.ts:48-52`),
but the field is dead on both ends:

- `indexSchemaToStored` (`schema-manager.ts:277`) never writes it.
- `addIndex`'s own `storeSchema` call (`optimystic-module.ts:1406-1412`) re-maps indexes
  to `{ name, columns }`, dropping it again.
- `storedToTableSchema`'s index reconstruction (`schema-manager.ts:209-216`) never reads
  it back.

So the persisted schema cannot distinguish a unique index from a plain one, and the
constraint mirror at `optimystic-module.ts:1451` (`if (indexSchema.unique)`) — which
exists precisely so a `CREATE UNIQUE INDEX` reaches `checkUniqueConstraints` on this
cached vtab — can never fire for a hydrated table. Fixing only `uniqueConstraints`
leaves this half broken.

## Why it matters

Downstream schemas use single-use UNIQUE columns as an anti-replay guard: a given value
may be written at most once (the CadreControl schema does this with a `StampId` column
and a nullable `MemberPrivateKey` column). On a warm restart that guarantee is silently
absent — a replayed value is accepted. Correctness/security gap, not a performance one.

## Scope / history

Pre-existing. The older full-table-scan enforcement had the identical dependency on
`this.tableSchema.uniqueConstraints`; the index-backed probe that landed under
`optimystic-unique-probe-index-backed` did not regress it, only surfaced it.

## Approach

Persist the constraint information and reconstruct it on hydrate, on both routes:

1. Add `uniqueConstraints` to `StoredTableSchema` — per constraint, the column indexes
   (in declared order), the optional `predicate`, and the optional `derivedFromIndex`
   name. Write it in `tableSchemaToStored`, read it in `storedToTableSchema`.
2. Wire the already-declared `StoredIndexSchema.unique` through end to end:
   `indexSchemaToStored`, `addIndex`'s `storeSchema` index mapping, and
   `storedToTableSchema`'s index reconstruction. `IndexSchema.predicate` should ride
   along the same way if it is to survive for partial unique indexes.
3. Once both land, a hydrated `TableSchema` carries the same `uniqueConstraints` the
   `CREATE TABLE` path builds, so `buildUniqueEnforcementIndexes` synthesizes the same
   `_uniq_` trees and `checkUniqueConstraints` probes them identically. Verify that
   equivalence rather than assuming it — in particular that the one-time backfill
   (`ensureUniquePopulated`) behaves the same when the synthesized tree is empty over
   already-populated rows on a hydrate-only open. The migration backfill added by
   `optimystic-unique-probe-index-backed` should already cover this; confirm with a test,
   don't infer it.

### Known interaction: first-open schema rewrite

Adding fields to `StoredTableSchema` changes what `schemasEqual`
(`optimystic-module.ts:210`) compares. Every already-persisted schema will miss the
short-circuit exactly once on the first open after upgrade, causing one schema re-write
per table. That is acceptable and self-healing, but it is a real (one-time) regression of
the cold-start cost the short-circuit was added to remove (see the comment at
`optimystic-module.ts:190-203`) — do not read the extra writes as a new bug, and make
sure the comparison stabilizes on the *second* open.
Decide explicitly how a schema persisted *before* this change (no `uniqueConstraints`
key) compares against a freshly built candidate whose constraint list is `[]` vs
`undefined`, so the mismatch resolves after one write instead of on every open.

## Edge cases & interactions

- **Hydrate-only open, no re-declare** — the headline case: duplicate secondary UNIQUE
  value must be rejected, matching the re-declare path.
- **Hydrate followed by `apply schema` / `CREATE TABLE IF NOT EXISTS`** — the documented
  README flow. The DDL is a no-op; enforcement must already be live from hydration, and
  must not double-register constraints if the declare does re-run.
- **`CREATE UNIQUE INDEX` then restart then hydrate** — constraint arrives via
  `addIndex`'s mirror on the first run, must arrive via persisted `unique` on the second.
- **Partial unique (`CREATE UNIQUE INDEX … WHERE …`)** — carries a `predicate`; excluded
  from point enforcement by both `buildUniqueEnforcementIndexes` and the probe. Round-trip
  must preserve the predicate's *presence* so it stays excluded rather than silently
  becoming a full constraint that rejects legitimate rows.
- **Constraint whose columns match the primary key, or match a declared index** — both
  are skipped by `buildUniqueEnforcementIndexes`; skipping must be identical post-hydrate,
  with no duplicate `_uniq_` tree built alongside a declared index over the same columns.
- **Nullable unique column** (the `MemberPrivateKey` shape) — whatever the current NULL
  semantics are on the re-declare path, hydrate must match them, not diverge.
- **Multi-column / composite unique** — column order and the `columnSetKey` derivation
  must round-trip so the synthesized tree name is stable across restarts (a changed
  `_uniq_` name would orphan the existing tree and start from an empty index).
- **Pre-upgrade persisted schema** — old rows in the schema tree have no
  `uniqueConstraints` field; reading them must not throw, and the table must pick up its
  constraints once re-declared.
- **Backfill over populated data** — hydrate-only open where the synthesized `_uniq_`
  tree does not yet exist but the table has rows: enforcement must not report a false
  duplicate, nor pass a real one, while the backfill is in flight.
- **Idempotent hydrate** — `hydrateCatalog` is idempotent and skips tables already in the
  catalog; a second `hydrate` must not duplicate or drop constraints.

## Acceptance

- A table opened via hydrate-only (no re-declared `CREATE TABLE`) rejects a duplicate of a
  secondary UNIQUE value, matching the re-declare path.
- A table whose uniqueness came from `CREATE UNIQUE INDEX` likewise rejects a duplicate
  after a hydrate-only reopen.
- Regression tests that open a persisted collection through the hydrate path — not a fresh
  `CREATE TABLE … UNIQUE` — and assert the duplicate is rejected. Existing suites to extend
  or mirror: `test/secondary-unique.spec.ts`, `test/secondary-unique-migration.spec.ts`,
  `test/catalog-hydration.spec.ts`.
- Second open after the upgrade takes the `schemasEqual` short-circuit again (no per-open
  schema re-write).
- Build, typecheck, lint, and the plugin test suite pass.

## TODO

- Add `uniqueConstraints` (columns, `predicate`, `derivedFromIndex`) to
  `StoredTableSchema`; write it in `tableSchemaToStored`, reconstruct it in
  `storedToTableSchema`.
- Wire `StoredIndexSchema.unique` (and `predicate`) through `indexSchemaToStored`,
  `addIndex`'s `storeSchema` index mapping, and `storedToTableSchema`.
- Settle the `undefined` vs `[]` comparison so `schemasEqual` re-stabilizes after exactly
  one post-upgrade write; add a test asserting the second open writes nothing.
- Confirm `buildUniqueEnforcementIndexes` synthesizes identical `_uniq_` descriptors
  (same names, same column order) on the hydrate path as on the re-declare path.
- Confirm `ensureUniquePopulated` backfill is correct on a hydrate-only open over
  already-populated rows.
- Add hydrate-path regression tests for: plain secondary UNIQUE, `CREATE UNIQUE INDEX`,
  composite UNIQUE, partial UNIQUE (stays excluded), and nullable UNIQUE.
- Update `README.md`'s Warm Restart section if any caveat remains after the fix; remove
  any wording implying re-declaring the table is required for enforcement.
- Run build + typecheck + lint + the `quereus-plugin-optimystic` test suite.
