description: The guards that stop a new table or index from silently adopting a dropped table's leftover data are now written and compiling; this ticket runs the tests against them, fixes any fallout, and updates the docs that still describe the old silent behavior.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts, packages/quereus-plugin-optimystic/test/schema-redeclare-column-identity.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/correctness.md
difficulty: medium
----

Continuation of `drop-leaves-storage-the-catalog-no-longer-describes` (same stage). The
prior run hit its token budget after the implementation landed, type-checked
(`npm run typecheck`) and built (`npm run build`), but BEFORE any test was executed and
before the documentation updates. Read the original ticket's design in
`tickets/.pruned-tickets.jsonl` history if needed, but everything necessary is below.

## What already landed (do not re-implement — verify it)

The rule installed: **storage must not outlive the catalog record that describes it.**
All code changes are uncommitted in the working tree.

`src/schema/schema-manager.ts`:

- `PersistedTableSchema.droppedAt?: string` — present ⇔ the record is a **gravestone**.
  `deleteSchema` now reads the current entry and rewrites it with `droppedAt` stamped
  (falling back to the old bare `undefined` tombstone when the read fails — degraded
  behaviour is the pre-fix behaviour, deliberately). Open-only semantics preserved.
- `livePersistedEntry` now filters gravestones too (every existing read/merge/hydrate
  path keeps its exact meaning); new `droppedPersistedEntry` (gravestone only) and
  private `anyPersistedEntry` (either).
- `StoredTableSchema.orphanedIndexes?: PersistedIndexSchema[]` — NAME-keyed (never
  positional, even in the resolved shape) descriptions of index trees left in storage
  that the live schema does not describe. Written onto the new live record when a
  declaration adopts described storage; `mergePersistedSchemas` unions it across every
  write so it survives re-declares (without this the addIndex guard goes blind after
  the first post-adoption write).
- Shared catalog walk `catalogEntries()` (private async generator); `listTables`
  rerouted through it (behaviour parity: still lists tombstoned names — hydrate skips
  them via getSchema); new `findRecordForUri(uri)` (live record wins over gravestone;
  URI defaulted as `tree://default/<name>` mirroring parseTableSchema) and
  `getDroppedSchemaRecord(name)`.

`src/optimystic-module.ts`:

- **Guard 1** — `guardStorageAdoption(candidate, transactor)`, called from
  `doInitialize` only on the `hasLocalColumns && !persistedSchema` arm (before the
  readOnly/write branch; `mergedCandidate` is now `let` and gains `orphanedIndexes`).
  Looks up gravestone-by-name then any record by URI; returns early (allowing) when no
  record or when `hasNoRowsToBackfill()`; refuses on (a) a declared column the record
  lacks, (b) a primary key differing in names/order/direction (compared via
  `describePrimaryKey`, lowercase). Refusal messages name the URI, both shapes, and
  the way out. The three deliberately-allowed cases are commented at the site.
- **Guard 2** — `guardIndexAdoption(indexSchema, storedSchema, transactor)`, called in
  `addIndex` on the build path (`!existing`), BEFORE `mirrorDerivedUniqueConstraint`
  (moved below the guard so a refusal leaves no in-memory constraint). Column-mismatch
  only; probes the index tree for emptiness before refusing (empty leftover trees
  adopt harmlessly and are repopulated).
- Module-level helpers `describeColumnList` / `describePrimaryKey` near the class.
- `OptimysticModule.create()` now evicts the table from `this.tables` (and tears down
  the change subscription) when `initialize()`/`ensureConnectionRegistered()` throws —
  without this, a refused CREATE blocked the documented retry with a bogus
  "already exists". NOTE for the eventual reviewer: the `connect()` path
  (`resolveConnectedTable`) still caches a failed instance — pre-existing pattern,
  guard rarely fires there (connect carrying columns over an empty catalog); flag it
  in the review handoff rather than fixing here unless a test trips over it.

`test/drop-table-orphan-rows.spec.ts` — fully rewritten (characterization header
gone): three refusals (added column, changed PK, second live table over same URI),
plus refusal of a leftover index tree under a different column (with a
recovery-by-fresh-name assertion), and four allowed cases (identical re-declare,
empty-collection re-declare under any shape, fresh index name, same-column re-adopt).
The added-column case also asserts the retry-after-refusal works (exercises the
create() eviction fix).

## TODO (in order)

- Rebuild if the tree changed, then run the rewritten spec:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/drop-table-orphan-rows.spec.ts" --colors --reporter min --exit`
  from `packages/quereus-plugin-optimystic`. Fix fallout. Likely soft spots:
  exact refusal-message substrings (the spec matches
  `Cannot create table 't' over '...'`, `adds column 'z'`,
  `a dropped table declared as (id, a, b)`, `keyed on (id)` / `keys on (a)`,
  `live table 't'`, `Cannot create index 'ix' over '.../index/ix'`,
  `declared on (b), not (a)`) — errors are wrapped as
  `Failed to initialize Optimystic table: <msg>` on the table path; whether Quereus
  DDL accepts `a text primary key` mid-column-list; and whether the second-live-table
  case sees the first table's row (both tables resolve the same collection instance —
  if `hasNoRowsToBackfill` reads empty there, investigate commit timing before
  touching the guard).
- Run `test/schema-redeclare-column-identity.spec.ts` — its drop-then-narrower case
  must still pass (guard allows dropped columns + unchanged PK). Update the comment in
  its dbC block (around line 229) that explains the drop-then-recreate workaround: it
  should now also say the re-declare passes the storage-adoption guard because it only
  DROPS a column and keeps the primary key, and that ADDING a column or changing the
  PK there would now be refused.
- Update the README `## Limitations` bullet on `DROP TABLE` (line ~274): a later
  CREATE TABLE at the same URI now REFUSES when it adds a column the stored rows
  cannot supply or changes the primary key; an identical or narrower re-declare still
  inherits the rows (unchanged warning); CREATE INDEX refuses to adopt a non-empty
  leftover tree under a different column list. Keep the "use a fresh collection URI"
  advice.
- Add a short subsection to `docs/correctness.md` § 7 (after 7.5) — one or two
  sentences: the plugin-level rule that storage must not outlive the catalog record
  describing it, enforced at declaration time (refusal, not deletion), and that DROP
  TABLE remains definition-only. Spans catalog + collections, hence a docs bullet
  rather than one code site.
- Run the full package suite:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min --exit`
  (baseline before this work: 676 passing, 13 pending, 0 failing, ~3m — the old
  characterization spec's 5 cases are replaced by 8, so expect ~679 passing). Handle
  any pre-existing failures per the pre-existing-failures protocol.
- Write the review/ handoff (this replaces both this ticket and the original): the
  rule, the guard sites, the test cases as validation entry points, and the honest
  gaps — guard blind when the catalog silently reads empty; guard compares record vs
  rows, not rows themselves; `orphanedIndexes` is a declare-time snapshot (an index a
  URI-sharing live table creates later is invisible to guard 2); older builds read a
  gravestone as live and would resurrect the table (accepted, cross-referenced to
  tickets/backlog/debt-optimystic-key-format-migration.md); connect() path still
  caches a failed instance. Collection deletion stays explicitly out of scope.
