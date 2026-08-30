description: After a table is dropped, its rows and index data stay in storage with nothing left to describe them, so the next table created at the same location silently adopts that data and can serve rows it says are impossible. Make that adoption fail loudly instead.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts, packages/quereus-plugin-optimystic/test/schema-redeclare-column-identity.spec.ts, packages/quereus-plugin-optimystic/README.md
difficulty: hard
----

## The rule this ticket installs

> **Storage must not outlive the catalog record that describes it.** A table or index
> declared over storage whose describing record is gone must fail loudly rather than
> silently adopt that storage.

Everything below is machinery for holding that one rule. It is deliberately *not*
"delete the rows on DROP" — see [Explicitly out of scope](#explicitly-out-of-scope).

## What is broken today

The plugin keeps two things in different places:

- **The catalog** — one record per table in the plugin-global tree
  `tree://optimystic/schema`, keyed by table name. It holds the column list, the primary
  key definition, the `USING optimystic(...)` arguments (including the table's collection
  URI) and the list of secondary indexes.
- **The data** — a distributed collection at the table's own URI, plus one collection per
  secondary index at `<uri>/index/<indexName>`.

`OptimysticModule.destroy` (`src/optimystic-module.ts`, the whole of the `DROP TABLE`
path) erases the catalog record and leaves every collection in place. Rows are stored as
name-keyed JSON objects (`RowCodec.encodeRow`), so a surviving row still says what
columns it was written under — but nothing reads that, and nothing else records it
either. The description of that storage is simply gone.

The next `CREATE TABLE` over the same URI therefore has nothing to check itself against,
and `doInitialize` treats "no persisted schema" as "fresh table": it writes the local DDL
as the new record and starts decoding the surviving rows against it.

### Measured symptoms

`packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts` (added by this
fix pass; **every assertion in it pins the current, wrong behaviour** and must be
rewritten as part of this ticket) runs each case against `MemoryRawStorage` in one
process, one `Database` per "session".

**1. Rows the declaration says cannot exist.**

```sql
create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/shape');
insert into t (id, a, b) values (1, 'aa', 'bb');
-- new session, plugin.hydrate(db) first
drop table t;
create table t (id integer primary key, z integer) using optimystic('tree://scratch/shape');
select * from t;   -- [{ id: 1, z: null }]
```

`z` was never written by anyone, and Quereus defaults a column to `NOT NULL`, so the
freshly-declared table serves a row carrying a value its own declaration forbids.
`count(*)` is wrong from the first statement onward.

**2. Rows come back on an identical re-declare.** Same sequence with the original column
list returns `[{ id: 1, a: 'aa', b: 'bb' }]`. Documented in the README today; listed here
because the fix must decide deliberately whether to keep allowing it (it does — see
below).

**3. A re-adopted index tree answers every seek empty.** This one is new evidence, and it
is worse than "stale entries":

```sql
-- session A: table at tree://scratch/idx, `create index ix on t (b)`, one row
drop table t;
create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/idx');
create index ix on t (a);            -- adopts the dropped table's tree at .../index/ix
insert into t (id, a, b) values (2, 'zz', 'yy');

select * from t;                     -- both rows
select * from t where a = 'aa';      -- []   (row 1 exists)
select * from t where a = 'zz';      -- []   (inserted AFTER the adoption)
```

The full scan sees both rows; every seek routed through the adopted tree answers empty —
including for a row written after the adoption, so this is not merely surviving stale
entries. Two controls in the same spec bound it: the identical sequence under an index
name storage has never seen (`freshix`) answers correctly, and re-adopting a tree on the
**same** column it was built on (`ix` on `b`) also answers correctly. So the trigger is
specifically *adopting an existing tree under a contradicting column list*. The exact
mechanism inside the tree was not chased, because the fix removes the path — do not
spend time on it unless the guard below turns out not to cover a case.

## Why a guard and not a "did someone DROP" check

The corrupting condition is not "a DROP happened recently". It is "this declaration does
not describe the storage it is about to adopt", and that has several shapes:

- drop, then re-create with a different column list (case 1 above);
- drop, then re-create an index name over a different column (case 3);
- two different table names declared over the same URI, no DROP anywhere;
- a URI reused across unrelated tables, or across nodes.

A check keyed on DROP sees only the first two. The guard below is keyed on the
declaration and the record, so it covers all of them with one rule.

## Design

### The gravestone

`SchemaManager.deleteSchema` currently writes a bare tombstone — `tree.replace([[name,
undefined]])` — and `livePersistedEntry` reads `entry[1]` falsy as "deleted". Change
`deleteSchema` to write a **gravestone** instead: the record it is replacing, marked
dropped, so what storage still holds stays written down.

```
// on-disk entry shape is unchanged: [name, PersistedTableSchema | undefined]
interface PersistedTableSchema {
  …                       // as today
  droppedAt?: string;     // present ⇒ this is a gravestone, not a live schema
}
```

Two accessors on `SchemaManager`, replacing the single `livePersistedEntry`:

- `livePersistedEntry(entry)` — the record **only when `droppedAt` is absent**. Every
  existing caller keeps its exact current meaning, so `getSchema`, `getSchemaFresh`,
  `listTables`, `hydrateCatalog`, `resolveAndCache`, `storeStoredSchema`'s write-time
  index union and `mergeWithPersisted` are all unchanged: a dropped table stays invisible
  to hydrate, to the planner and to every merge.
- `droppedPersistedEntry(entry)` — the record **only when `droppedAt` is present**. Read
  by the new guards, and by nothing else.

A gravestone is a record of what storage holds. It is **never** merged into a live
schema.

Notes for whoever builds it:

- `deleteSchema` is open-only on the catalog by deliberate design (an absent catalog is a
  no-op, never a reason to invent one — read the comment on it before touching it). The
  gravestone write must keep that; it is the same `tree.replace` on the same open-only
  tree. If the record cannot be read at drop time, write the bare `undefined` tombstone
  exactly as today — a missing gravestone degrades to today's behaviour, which is the
  right failure direction.
- Bare `undefined` tombstones written by earlier builds keep reading as tombstones. The
  guards find no record for them and allow the declaration through — i.e. exactly today's
  behaviour for databases dropped before this lands. That is intended; say so in a code
  comment so nobody reads it as a hole.
- Cross-version hazard worth one line in the code: a **build older than this change**
  reading a gravestone sees a live record and resurrects the dropped table. AGENTS.md says
  not to worry about backwards compatibility yet, so note it and move on — but note it,
  and cross-reference `tickets/backlog/debt-optimystic-key-format-migration.md`, which is
  where a persisted-format version stamp would live if one is ever wanted.

### Guard 1 — table declaration

In `OptimysticVirtualTable.doInitialize`, on the `hasLocalColumns` path (a `CREATE TABLE`
or a `connect` carrying columns) **when `persistedSchema` is undefined** — the arm that
today logs "persisting local DDL schema with no persisted catalog entry visible" and
writes. Before writing, find the record that describes the storage this declaration is
about to adopt:

1. the gravestone for this table name, if any;
2. otherwise, walk the catalog for any record — live *or* gravestone — whose
   `vtabArgs['0']` equals this table's `collectionUri`.

The walk runs only on this arm (no live record and no gravestone under this name, i.e. a
genuinely new table name), so the warm and hydrated paths never pay it. It is one pass
over a catalog holding one entry per table; `listTables` already walks it the same way.
A shared helper on `SchemaManager` (`findRecordForUri(uri)`) is the natural home, and
`listTables` can route through the same walk.

If a record is found **and the data collection is non-empty** (`hasNoRowsToBackfill()` is
the existing one-descend probe; an empty collection cannot mangle anything, so a created-
never-written-then-dropped table re-declares freely), refuse when either clause trips:

- **(a) A declared column the record does not have.** The surviving rows carry no value
  for it, so `RowCodec.decodeRow` invents `NULL` — case 1 above, and the `NOT NULL`
  violation with it.
- **(b) A declared primary key that differs from the record's** — column names, order and
  direction. Every surviving row sits under a tree key computed from the *old* primary
  key, so this declaration would never compute a key that reaches them: point lookups
  miss, and the first re-write of such a row relocates it.

Deliberately **not** refused, so state each in a comment at the site:

- **A declaration that drops a column the record had.** Every declared column is still
  backed by real stored values; nothing is invented. This is also the documented way out
  of "cannot re-declare without column X: persisted index Y covers it" (README
  Limitations, and the last case in `test/schema-redeclare-column-identity.spec.ts` — that
  test drops `s` and re-declares it narrower, and **must keep passing**).
- **An identical re-declare.** Re-declaring the same shape over the same URI is how a node
  states its view of a table; `bug-persisted-index-outlives-the-columns-it-points-at`
  leans on it. Case 2 stays as it is — the rows come back, which the README already warns
  about.
- **Anything with a live record under this table's own name.** That path is unchanged: it
  goes through `mergeWithPersisted`, which already validates it.

On success the normal `storeStoredSchema` write replaces the gravestone with a live
record. The gravestone's `indexes` are **not** carried into the new declaration — a DROP
still sheds the catalog's index list, which is what makes the escape hatch above work.

### Guard 2 — index declaration

In `OptimysticVirtualTable.addIndex`, on the build path (`existing` is undefined, so the
persisted schema does not carry this index name), before `openIndexTree` adopts
`<uri>/index/<name>`: consult the same record guard 1 found for this URI. If it names an
index of this name over **different columns**, refuse.

Column-mismatch only, and that is the point — a peer that built the same index over the
same columns produces a matching record and is adopted exactly as today, so the multi-node
re-attach and heal paths (`reconcileMaintainedIndexes`, `backfillIndexTrees`, the two-node
convergence specs) are untouched. The controls in the repro spec show that a same-column
re-adopt is correct and a different-column one is not, which is exactly the line this
draws.

This needs the gravestone's `indexes` to be *readable* by the guard even though they are
not merged into the new schema. Keep those two facts visibly separate in the code.

### Refusal messages

A refusal that does not say what to do sends someone to the source. Each message must
name: the collection URI, the shape found in the record, the shape declared, and the way
out. Roughly:

```
Cannot create table 't' over 'tree://scratch/shape': that collection still holds rows
from a dropped table declared as (id, a, b), and this declaration adds column 'z',
which those rows cannot supply. Use a different collection URI, or re-declare the
columns the stored rows were written under.
```

```
Cannot create index 'ix' over 'tree://scratch/idx/index/ix': that collection still
holds entries from a dropped index of the same name declared on (b), not (a). Use a
different index name, or a different collection URI for the table.
```

### Honest limits — write these down at the sites

- **Every guard reads the catalog.** A cohort that silently answers "nothing" for the
  catalog while the data collection reads fine leaves the guard blind. That is the same
  residual `SchemaManager.getSchema` already documents at length (a *provably*
  unreachable catalog throws `BlockUnavailableError`; a silently-empty cohort answer still
  reads as absent). The guard closes the local, reproducible corruption and invents no
  certainty beyond that — do not claim more in the comments.
- **The guards compare against a record, not against the rows.** A record that
  disagrees with the rows it describes (some earlier divergence) makes the guard's answer
  wrong in whichever direction the record is wrong. Sampling rows instead was considered
  and rejected: a legitimately-supported re-declare that *adds* a column produces rows of
  mixed shape, so "a declared column is missing from this row" cannot distinguish
  supported from corrupting.

## Explicitly out of scope

**Do not build collection deletion.** Deleting a distributed collection is neither cheap
nor obviously safe — another node may still be reading it — and no "delete a whole
collection" primitive exists in the plugin. It is a feature needing its own design, and
it is not what makes this a corruption ticket. `DROP TABLE` stays definition-only; this
ticket only makes the *next* declaration over the leftover storage fail loudly instead of
serving mangled rows.

If, while building, the honest conclusion is that a sound guard needs a primitive that
does not exist, do not leave the corrupting path silent — land the most conservative
refusal that is sound, and file what is missing.

## TODO

- Add `droppedAt` to `PersistedTableSchema`; split `livePersistedEntry` into
  `livePersistedEntry` (live only) and `droppedPersistedEntry` (gravestone only), and
  confirm every existing caller keeps the live-only meaning.
- Change `SchemaManager.deleteSchema` to write the gravestone, preserving its open-only
  semantics and falling back to today's bare tombstone when the record cannot be read.
- Add `SchemaManager.findRecordForUri(uri)` — one catalog walk returning the live or
  dropped record whose `vtabArgs['0']` matches; route `listTables` through the same walk
  rather than adding a second one.
- Guard 1 in `doInitialize`: on the `hasLocalColumns && !persistedSchema` arm, look up by
  name then by URI, probe the collection for emptiness, and refuse on clause (a) or (b)
  with the message above. Comment the three cases that are deliberately allowed.
- Guard 2 in `addIndex`'s build path: refuse before `openIndexTree` when the record names
  this index over different columns.
- Rewrite `test/drop-table-orphan-rows.spec.ts` — its five cases become: two refusals
  (different column list; index name over a different column), and three that must still
  succeed (identical re-declare, narrower re-declare, fresh index name). Drop the
  characterization header once it no longer pins a defect.
- Add a case for a URI shared by two *live* table names with contradicting shapes, and one
  for a table created-but-never-written then dropped and re-declared under any shape
  (must succeed — the collection is empty).
- Confirm `test/schema-redeclare-column-identity.spec.ts`'s drop-then-recreate case still
  passes, and update the comment there that currently explains the fresh-primary-key
  workaround.
- Update the README Limitations bullet on `DROP TABLE` (currently: "a later CREATE TABLE
  at the same collection URI inherits them") to describe what is now refused and what
  still inherits.
- Add a line to `docs/correctness.md` on the storage-outlives-its-record rule, since it
  spans the catalog and the collections rather than sitting at one code site.
- Run the package suite: `node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/**/*.spec.ts" --colors --reporter min --exit` from
  `packages/quereus-plugin-optimystic`. Baseline at the time of this ticket: **676
  passing, 13 pending, 0 failing** (~3m), with the characterization spec included.
