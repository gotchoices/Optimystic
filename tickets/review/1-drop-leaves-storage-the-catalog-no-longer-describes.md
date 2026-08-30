description: Dropping a table in the SQL plugin leaves its rows and index trees in storage; a later table or index created over that same storage used to silently adopt them, sometimes producing rows that could never be read back. Declarations are now checked against a record of what the storage actually holds, and refused when they contradict it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts, packages/quereus-plugin-optimystic/test/schema-redeclare-column-identity.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/correctness.md
difficulty: medium
----

Review handoff for the implementation of `drop-leaves-storage-the-catalog-no-longer-describes`
plus its verify/document follow-up. It replaces both. The implementation landed across two
runs: the guards themselves in commit `cffd0079`, and everything below the "Added this run"
heading in the working tree on top of it.

## The rule

**Storage must not outlive the catalog record that describes it.**

`DROP TABLE` in this plugin is definition-only: it removes the table's definition but
leaves its rows in the collection at the table's URI, and its secondary-index trees at
`<uri>/index/<name>`. Before this work, the next `CREATE TABLE` or `CREATE INDEX` over
that storage silently adopted whatever it found, under any column list. Adopting under a
column the old rows never carried decoded as NULL even where the declaration said NOT
NULL; adopting under a different primary key produced rows no lookup could ever reach.

The fix is a **refusal at declaration time, not a deletion**. `DROP TABLE` now keeps the
dropped record as a *gravestone* (the record itself, stamped with a `droppedAt`
timestamp) so the leftover storage stays described, and the next declaration over it is
checked against that description. Deleting the leftover collections is explicitly out of
scope and stays that way: nothing above the protocol layer is entitled to decide that
another node's replicas of those blocks should go away.

## Where the rule is enforced

Two guards, both in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`:

- **`guardStorageAdoption(candidate, transactor)`** — called from `doInitialize`, only on
  the `hasLocalColumns && !persistedSchema` arm (a declaration carrying columns with no
  live catalog record under its own name, i.e. one that is about to adopt storage). It
  looks up the gravestone under the table's own name, else any record — live or
  gravestone — declared over the same collection URI. It allows freely when no record
  describes the storage, or when the collection reads as empty. Otherwise it refuses on
  (a) a declared column the record does not have, or (b) a primary key differing in
  column names, order or direction. It returns the record's index-tree descriptions for
  the second guard to use.
- **`guardIndexAdoption(indexSchema, storedSchema, transactor)`** — called from `addIndex`
  on the build path, before `mirrorDerivedUniqueConstraint` (so a refusal leaves no
  in-memory constraint behind). Column-mismatch only, and it probes the leftover tree for
  emptiness first: an empty leftover tree adopts harmlessly and is repopulated.

Supporting changes in `src/schema/schema-manager.ts`: `PersistedTableSchema.droppedAt`
(present if and only if the record is a gravestone), `deleteSchema` writing a gravestone
(degrading to the old bare tombstone when the record cannot be read), `livePersistedEntry`
filtering gravestones so every pre-existing read/merge/hydrate path keeps its exact
meaning, the new `droppedPersistedEntry` / `findRecordForUri` / `getDroppedSchemaRecord`
accessors, a shared `catalogEntries()` walk behind both `listTables` and
`findRecordForUri`, and `StoredTableSchema.orphanedIndexes` (name-keyed descriptions of
index trees the live schema does not describe, unioned across every write by
`mergePersistedSchemas` so the index guard does not go blind after the first
post-adoption write).

## Added this run (not in commit `cffd0079`)

**A real defect the new tests exposed: `DROP TABLE` was a catalog no-op on an untouched
table.** `OptimysticModule.destroy()` only wrote the catalog when it already held a cached
table instance. A table hydrated into Quereus's catalog and dropped *without ever being
queried* has no such instance, so the drop wrote nothing at all, leaving the record
**live** past its own DROP. Two consequences, both verified: the next `hydrate()`
resurrected the dropped table, and a later `CREATE TABLE` at the same URI read a live
persisted schema and so never reached `guardStorageAdoption` at all. This is pre-existing
(`destroy` is untouched by `cffd0079`) but it made the guards decorative in exactly the
multi-session drop-then-recreate scenario the README documents, and three of the ticket's
own tests failed on it. `destroy()` now instantiates from the catalog entry Quereus still
holds at that point — deliberately *without* initializing it — and deletes the schema
through that. New helper: `instantiateForTeardown`.

Also this run: the two `deleteSchema` unit tests in
`test/schema-catalog-write-path.spec.ts` rewritten for the gravestone contract (the old
one asserted the entry reads as absent *on disk*, which is precisely what changed), a new
test that a re-drop does not restamp the gravestone, a new test for the documented
degraded fallback (record unreadable, so a bare tombstone, and the drop still succeeds), a
`failNextFind` knob on `FakeCatalogTree` to drive it, the updated re-declare comment in
`test/schema-redeclare-column-identity.spec.ts`, the rewritten README section
"Limitations" `DROP TABLE` bullet, and `docs/correctness.md` section 7.6.

## Validation entry points

`packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts` is the spec for
the rule — 9 cases, in-memory, single process, one `Database` per simulated session over a
shared `MemoryRawStorage`. Four refusals: a re-declare that adds a column; one that
changes the primary key; a second **live** table over the same URI (no DROP anywhere,
which proves the rule is not drop-specific); and a `CREATE INDEX` adopting a non-empty
leftover tree under a different column. Four deliberate allowances that must not regress:
an identical re-declare (the dropped rows come back — documented behaviour, not a bug),
any re-declare over an empty collection, a fresh index name, and re-adopting an index tree
on the same column it was built on (the multi-node re-attach path depends on this one).
Plus the drop-after-hydrate case covering the `destroy()` fix.

Two refusal cases double as recovery tests: the added-column case retries with the shape
the message names and asserts the rows come back on the very next statement (this
exercises the `create()` eviction of a failed instance), and the index case retries under
a fresh index name.

Adjacent specs worth re-reading rather than trusting: `schema-catalog-write-path.spec.ts`
(its `deleteSchema` block — the gravestone contract at the unit level) and
`schema-redeclare-column-identity.spec.ts` (its drop-then-narrower re-declare must keep
passing; that is the escape hatch the refusal messages point users at).

Commands, from `packages/quereus-plugin-optimystic`:

```
npm run typecheck
npm run build          # the specs import ../dist, so a src change needs this first
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min --exit
```

**Results:** typecheck clean, build clean, `eslint` clean on the changed files, smoke test
passes. Full package suite **682 passing, 13 pending, 0 failing** (~3m), against a
pre-existing baseline of 676/13/0 — the old characterization spec's 5 cases replaced by 9,
and 2 net-new unit tests in the catalog write-path spec.

## Known gaps — treat these as the starting point, not the finish line

- **The guards are only as good as the catalog read.** Both lookups read the schema
  catalog. A cohort that silently answers "nothing" for the catalog while the data
  collection reads fine leaves both guards blind — the same residual `SchemaManager.getSchema`
  documents at length. Not closed here, and not closable at this layer.
- **The guard compares the declaration against the RECORD, not against the rows.** A
  record that has drifted from the rows it describes makes the answer wrong in whichever
  direction the record is wrong. Sampling rows instead cannot work: a legitimately
  supported re-declare produces rows of mixed shape, so "this row lacks a declared column"
  cannot distinguish supported from corrupting. Worth an adversarial look at whether the
  record can drift in practice.
- **`orphanedIndexes` is a snapshot taken at declaration time.** An index tree created
  *later* by a different live table sharing the same URI is invisible to the index guard.
  The URI-sharing case is refused at table-declaration time when the shapes contradict, so
  the surviving window is two tables that agree on shape but disagree on indexes — narrow,
  but not empty, and not covered by a test.
- **Older builds read a gravestone as live.** A `droppedAt`-stamped record opened by a
  build from before this change has no idea the table was dropped and will resurrect it.
  Accepted, and cross-referenced to `tickets/backlog/debt-optimystic-key-format-migration.md`
  — the general "old build meets new record" problem, not this ticket's to solve.
- **A failed open on the `connect()` path poisons the table for the session.** The original
  ticket flagged this to be reported rather than fixed here; while checking it I confirmed
  it is worse than "caches a failed instance" — `initialize()` also memoizes its own
  rejection permanently, so the table never recovers even after conditions heal. It is
  independent of these guards (any transient transactor failure triggers it) and is now
  filed, with a verified repro, as
  `tickets/backlog/bug-one-failed-open-makes-a-table-unusable-for-the-session.md`. The
  guards only add one more way to reach it.
- **Refusal messages are asserted by substring.** The spec pins fragments like
  `adds column 'z'` and `declared on (b), not (a)`. That is deliberate (the messages are
  the user's only instructions for recovering) but it does make the spec brittle against
  message rewording — a reviewer changing the wording must update the spec, not the
  reverse.
- **Single-process, in-memory coverage only.** Every case runs over `MemoryRawStorage`
  with one shared transactor. The multi-node re-attach behaviour the "same column" index
  allowance exists to protect is argued for in comments, not exercised by a test.
