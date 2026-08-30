description: Dropping a table in the SQL plugin leaves its rows and index trees in storage; a later table or index created over that same storage used to silently adopt them, sometimes producing rows that could never be read back. Declarations are now checked against a record of what the storage actually holds, and refused when they contradict it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts, packages/quereus-plugin-optimystic/test/schema-redeclare-column-identity.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/correctness.md
----

## What shipped

The rule, enforced at declaration time and never by deleting anything:

> **Storage must not outlive the catalog record that describes it.**

`DROP TABLE` in this plugin is definition-only — it removes the table's definition and
leaves its rows in the collection at the table's URI, and its secondary-index trees at
`<uri>/index/<name>`. Before this work the next `CREATE TABLE` or `CREATE INDEX` over
that storage silently adopted whatever it found, under any column list. Now `DROP TABLE`
keeps the dropped record as a **gravestone** (the record itself, stamped `droppedAt`) so
the leftover storage stays described, and the next declaration over it is checked against
that description and **refused** when it contradicts it. Nothing is deleted and no data
is rewritten to fit — deleting another node's replicas is deliberately out of scope.

Two guards, both in `src/optimystic-module.ts`:

- `guardStorageAdoption` — from `doInitialize`, only on the arm where a declaration
  carries columns and no live catalog record exists under its own name. Looks up the
  gravestone under the table's name, else any record (live or gravestone) declared over
  the same collection URI. Allows freely when nothing describes the storage, or when the
  collection reads empty. Otherwise refuses on a declared column the record lacks, a
  declared column re-typed against the record, or a primary key differing in column
  names, order or direction. Returns the record's index-tree descriptions for the second
  guard.
- `guardIndexAdoption` — from `addIndex`'s build path, before
  `mirrorDerivedUniqueConstraint` so a refusal leaves no in-memory constraint behind.
  Column-mismatch only, and probes the leftover tree for emptiness first (an empty
  leftover tree adopts harmlessly and is repopulated).

Supporting work in `src/schema/schema-manager.ts`: `PersistedTableSchema.droppedAt`;
`deleteSchema` writing a gravestone (degrading to the old bare tombstone when the record
cannot be read); `livePersistedEntry` filtering gravestones so every pre-existing
read/merge/hydrate path keeps its exact meaning; `droppedPersistedEntry` /
`findRecordForUri` / `getDroppedSchemaRecord`; a shared `catalogEntries()` walk behind
`listTables` and `findRecordForUri`; and `StoredTableSchema.orphanedIndexes`, unioned
across every write by `mergePersistedSchemas` so the index guard does not go blind after
the first post-adoption write.

The implement stage also found and fixed a pre-existing defect the new tests exposed:
`OptimysticModule.destroy()` only wrote the catalog when it already held a cached table
instance, so a table hydrated and dropped *without ever being queried* left its record
**live** past its own DROP — the next `hydrate()` resurrected it, and a later `CREATE` at
the same URI never reached the guard at all. `destroy()` now instantiates (deliberately
uninitialized) from the catalog entry Quereus still holds at that point.

Docs: `README.md` § Limitations `DROP TABLE` bullet rewritten with each refusal and its
message; `docs/correctness.md` § 7.6 records the rule at the architectural level.

## Validation

From `packages/quereus-plugin-optimystic`:

```
npm run typecheck
npm run build
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min --exit
```

Typecheck clean (whole workspace), build clean, `eslint` clean on every changed file.
Full package suite **683 passing, 13 pending, 0 failing** (~3m) — the implement stage's
682 plus the one case added in review. No pre-existing failures surfaced, so nothing was
written to `tickets/.pre-existing-error.md`.

`test/drop-table-orphan-rows.spec.ts` is the spec for the rule: 10 cases, in-memory,
one `Database` per simulated session over a shared `MemoryRawStorage`. Five refusals (a
re-declare that adds a column; one that re-types a column; one that changes the primary
key; a second **live** table over the same URI with no DROP anywhere; a `CREATE INDEX`
adopting a non-empty leftover tree under a different column) and five deliberate
allowances that must not regress (identical re-declare, any re-declare over an empty
collection, a fresh index name, re-adopting an index tree on the column it was built on,
and the drop-after-hydrate case covering the `destroy()` fix). Three refusal cases double
as recovery tests: they retry with the shape the message names and assert the rows come
back on the very next statement.

## Review findings

### Fixed in this pass

- **`guardStorageAdoption` compared column NAMES only, so a re-declare could silently
  re-type a column the stored rows carry.** A row is stored as an untagged, name-keyed
  JSON object, so a column's affinity is the only thing that says what a stored value
  means on the way out: `RowCodec.denormalizeValue` (`src/schema/row-codec.ts:257`)
  base64-decodes a stored string into bytes for a BLOB-affinity column and returns it
  verbatim for any other. `create table t (id integer primary key, a text)` → `drop` →
  `create table t (id integer primary key, a blob)` at the same URI therefore passed the
  guard and handed back a value that was neither what was written nor an error — the same
  "silently serving rows the declaration cannot account for" failure the guard exists to
  stop. Added clause (a2) to `guardStorageAdoption`, a refusal message naming the column
  and both types, a spec case (`refuses a re-create at the same URI that RE-TYPES a
  column the stored rows carry`, which also asserts the named recovery works on the next
  statement), and a README bullet.
- **`destroy()` swallowed a failed gravestone write in silence.** The `catch {}` was
  correct as a policy — teardown bookkeeping must never fail a DROP — but the stakes rose
  with this ticket: a failed write leaves the record live past its own DROP, which blinds
  both guards for that URI. It now logs what was lost and why, instead of dropping the
  failure on the floor.

### Recorded as tripwires (conditional; no ticket filed)

- **Primary-key collation is not compared, and direction is compared more strictly than
  storage requires.** Correct today because the collation-aware key comparator in
  `row-codec.ts` is dead code — the tree is opened with a raw lexicographic string
  comparator, so neither collation nor direction decides where a row sits. Parked as a
  `NOTE:` on `describePrimaryKey`, cross-referenced to
  `backlog/debt-optimystic-true-key-ordering`, which is the change that makes a
  collation-only re-declare a real unreachable-rows case.
- **`findRecordForUri` matches collection URIs by raw string compare**, but the
  collection factory strips a leading `tree://` before using the URI as the collection
  id — so `tree://db/t` and `db/t` name the same storage and are not matched, leaving the
  URI-sharing arm of the guard blind for that spelling. The same unnormalized string is
  already the identity behind the factory's per-transaction collection cache key, so
  normalizing only in the guard would be half a fix. `NOTE:` at the method saying where
  the real fix belongs (normalize once at parse time).
- **Gravestones are immortal by design, so catalog walks grow with DROP history rather
  than with live table count** — `listTables` returns dropped names, and `hydrateCatalog`
  pays one extra `getSchema` per gravestone. Immaterial at the handful of drops a schema
  sees today. `NOTE:` on `listTables`, which also now documents that it returns dropped
  names at all (behaviour worth stating, since callers filter on the follow-up
  `getSchema`).

### Appended to an existing ticket

- **`src/optimystic-module.ts` is now 3691 lines** (`wc -l`), up 478 in six days, and
  this ticket added a third distinct concern to the same class (declaration-time storage
  adoption, which reads the schema catalog *and* probes the data collection *and* probes
  index trees). `backlog/debt-optimystic-vtab-class-is-too-big-to-review` already claims
  this site, so this is evidence appended as a re-measurement arm, not a new ticket.

### Checked and found sound

- **`orphanedIndexes` round-trip.** Verified end to end that the guard's stash survives a
  write and a restart: `toPersistedSchema` and `toStoredSchema` both spread the record, so
  the field crosses the persisted/resolved boundary; `mergePersistedSchemas` unions it
  separately from `indexes` and never into them; `unresolvedIndexColumns` correctly walks
  only `indexes`, so a stale orphan naming a column the live table dropped cannot make the
  record unresolvable; and `storeStoredSchema` reads through `livePersistedEntry`, so a
  `CREATE` after a `DROP` writes a live record over the gravestone without inheriting
  `droppedAt`.
- **Gravestones stay invisible to the planner.** `hydrateCatalog` skips them on the
  `getSchema` returning undefined, which the spec pins directly (a second session's
  hydrate must report zero tables).
- **`create()`'s eviction of a failed instance and `destroy()`'s uninitialized teardown
  instance.** `instantiateTable` registers in `this.tables` and establishes no
  subscription, so `destroy` deleting the key is the whole cleanup; the refused-CREATE
  retry path is exercised by three spec cases.

### Empty categories, with reasons

- **No new tickets filed.** Both findings that mattered resolve at the guard site this
  ticket owns and were small enough to fix in the pass; everything else was either
  genuinely conditional (the three tripwires) or already claimed by an open ticket (the
  file-size arm). The one major defect adjacent to this work — a failed open poisoning a
  table for the whole session — was already filed by the implement stage as
  `backlog/bug-one-failed-open-makes-a-table-unusable-for-the-session`, with a verified
  repro; it is independent of these guards and was not re-filed.
- **No accepted-tradeoff `NOTE:`s were overridden.** The sites touched carry none.
- **Nothing routed to `blocked/`.** No decision here needs a human and no dependency is
  outside this repo.

### Known limits carried forward, unchanged

These are stated honestly in the code comments and the README and are not defects in this
change; they are the shape of what a declaration-time guard can promise.

- **Both guards read the schema catalog**, so a cohort that silently answers "nothing" for
  the catalog while the data collection reads fine leaves them blind — the same residual
  `SchemaManager.getSchema` already documents. Not closable at this layer.
- **The guards compare against the RECORD, not the rows.** A record that has drifted from
  the rows it describes makes the answer wrong in whichever direction the record is wrong.
  Sampling rows instead cannot work: a legitimately supported re-declare produces rows of
  mixed shape, so "this row lacks a declared column" cannot distinguish supported from
  corrupting.
- **`orphanedIndexes` is a snapshot taken at declaration time**, so an index tree created
  later by a different live table sharing the same URI is invisible to the index guard.
  The URI-sharing case is refused at table-declaration time when the shapes contradict, so
  the surviving window is two tables that agree on shape but disagree on indexes.
- **Older builds read a gravestone as live** and will resurrect a dropped table. Accepted
  and cross-referenced to `backlog/debt-optimystic-key-format-migration`, the general
  "old build meets new record" problem.
- **Refusal messages are asserted by substring.** Deliberate — the messages are the user's
  only instructions for recovering — but it makes the spec brittle against rewording. A
  reviewer changing the wording must update the spec, not the reverse.
- **Coverage is single-process and in-memory.** The multi-node re-attach behaviour that
  the "same column" index allowance exists to protect is argued for in comments, not
  exercised by a test.
