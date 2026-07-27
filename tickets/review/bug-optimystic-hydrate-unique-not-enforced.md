description: When a database is reopened using the fast warm-restart path, tables' uniqueness rules were not enforced because the persisted schema never carried them; they are now persisted and reconstructed, with regression tests across every constraint shape.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/secondary-unique-hydrate.spec.ts
difficulty: hard
----

## What was implemented

The optimystic virtual table enforces non-primary-key UNIQUE constraints in
application code, reading the constraint list from its in-memory table schema. That
list was only ever populated by parsing `CREATE TABLE` / `CREATE UNIQUE INDEX` DDL —
the persisted schema (`StoredTableSchema`) did not carry it, so any table opened via
the documented warm-restart path (`plugin.hydrate(db)` followed by no-op DDL) enforced
nothing beyond the primary key. Fixed by persisting the uniqueness metadata and
reconstructing it on every open:

1. **`StoredTableSchema.uniqueConstraints`** (new, `schema-manager.ts`) — persists each
   non-derived constraint's name, column indexes in declared order, default conflict
   resolution, and partial predicate. Constraints derived from a `CREATE UNIQUE INDEX`
   are deliberately NOT stored in this list; they are reconstructed from the index's
   own `unique` flag so the index stays the single source of truth.
2. **`StoredIndexSchema.unique` + `predicate`** wired end-to-end — `indexSchemaToStored`
   now writes them, `storedToTableSchema` reads them back, and `addIndex` persists them
   via `storeStoredSchema` (the old path re-mapped indexes to bare `{name, columns}`
   and silently dropped both fields).
3. **`SchemaManager.storedToUniqueConstraints`** (new) — rebuilds the full constraint
   list (explicit + one derived per unique index, deduped by order-insensitive column
   set) for both catalog hydration and vtab initialization.
4. **`attachPersistedUniqueConstraints`** (new, `optimystic-module.ts` doInitialize) —
   folds persisted constraints into the vtab's live schema on EVERY open, deduped
   against what local DDL already carries. This makes enforcement independent of which
   DDL (if any) replayed: hydrate-only, placeholder connect, and partial re-declares
   (CREATE TABLE without its CREATE INDEX siblings) all end up armed.
5. **`addIndex` restructure** — the derived-constraint mirror now runs BEFORE the
   already-persisted dedupe (previously a re-declared `CREATE UNIQUE INDEX` early-
   returned and never armed the cached vtab at all — a second latent enforcement hole
   on the no-hydrate restart path, now fixed and pinned by test). A dedupe hit whose
   persisted index lacks the `unique` flag persists it in one write (the pre-upgrade
   migration path).

### `schemasEqual` stabilization decision

`uniqueConstraints` is OMITTED (not `[]`) when a table has none, and an index's
`unique: false` is normalized to omitted. Consequences, pinned by tests:
constraint-free tables persisted before this change stay byte-identical and never
re-write; tables WITH constraints miss the short-circuit exactly once (one schema
write) and short-circuit again from the second open on.

## How to validate

From `packages/quereus-plugin-optimystic`: `yarn build && yarn typecheck && yarn test`.
All pass as of handoff (322 passing, 11 pending — the pending ones are pre-existing
env-gated specs). `npx eslint` over the touched files is clean.

The new suite `test/secondary-unique-hydrate.spec.ts` (9 tests) covers, each via a
real two-or-three-session restart against shared storage with hydrate-only reopens:
plain secondary UNIQUE; UNIQUE via `CREATE UNIQUE INDEX`; composite UNIQUE (declared
column order round-trips); partial unique index (predicate presence survives — no
false rejection); nullable UNIQUE (multiple NULLs still coexist); the no-write
short-circuit on a modern-schema reopen; pre-upgrade schema re-stabilizing after
exactly one write once re-declared; re-declared `CREATE UNIQUE INDEX` upgrading a
pre-upgrade schema and enforcing immediately; and the one-time backfill of an empty
`_uniq_` tree over already-populated rows on a hydrate-only open.

## Honest gaps / notes for review

- **Pre-upgrade schemas cannot self-heal on the hydrate path.** A schema persisted
  before this change has no uniqueness metadata, and hydrate's whole point is that the
  DDL that would restore it never re-runs. Enforcement resumes only after one open in
  which the DDL actually executes. README's Warm Restart section documents this
  one-time caveat; there is no code path that could do better (the information simply
  is not in storage).
- **Quereus's `apply schema` differ vs a constraint-less hydrated catalog entry is
  untested.** Whether quereus notices the missing constraints and re-emits DDL (which
  would self-heal pre-upgrade schemas) or no-ops is quereus-internal behavior this
  ticket did not probe. The README caveat assumes the conservative case (no-op).
- **Partial-index predicates are persisted as the raw parser expression tree
  (JSON).** Round-trip equality holds because every comparison site derives both sides
  from the same parsed JSON (re-declared `CREATE UNIQUE INDEX` dedupes by index name
  before any predicate comparison ever happens). A quereus AST shape change across
  versions would cause at most a one-time schema re-write, not misbehavior — but
  nothing pins that.
- **Enforcement of partial UNIQUE remains "excluded", as before.** Rows inside the
  predicate's scope are still not point-enforced (pre-existing design, unchanged);
  the fix only guarantees hydration doesn't silently promote a partial constraint to
  a full one.
- The tamper-based tests reach into plugin internals (`schemaManagers` map,
  `storeStoredSchema`) to fabricate pre-upgrade persisted schemas, following the
  pattern already used by `catalog-hydration.spec.ts`. They are coupled to those
  internals by necessity.
- Env-gated integration tiers (`OPTIMYSTIC_INTEGRATION=1`, `RUN_LONG_TESTS=1`) were
  not run, per project policy for agent runs.

## Review findings

(to be filled by review stage)
