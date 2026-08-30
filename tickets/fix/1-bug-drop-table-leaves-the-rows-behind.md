description: Dropping a table only forgets its definition — the rows stay in storage. Creating a table again at the same location brings the old rows back, and if the new table has different columns those rows come back mangled.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
repro: verified
severity: corruption
likelihood: normal-use
tradeoffs: Deleting a distributed collection is not a cheap or obviously-safe operation — another node may still be reading it, and the plugin has no "delete a whole collection" primitive today — so a maintainer may reasonably prefer to keep DROP TABLE definition-only and just document it (as this review already did) rather than build collection deletion.
----

## What happens

`DROP TABLE t` removes `t` from the plugin's schema catalog and nothing else. The
rows themselves live in a separate distributed collection addressed by the table's
URI (the `using optimystic('tree://…')` argument), and that collection is left
untouched — as are the secondary-index trees hanging off it at
`<uri>/index/<indexName>`.

So a later `CREATE TABLE` at the same URI is not a fresh table. It inherits every row
the dropped table had, plus every stale index entry.

## Why it is worse than "the rows come back"

The re-created table does not have to have the same columns. When it doesn't, the old
rows are decoded against the *new* column list and surface as rows that the new table's
own declaration says are impossible.

Verified against `MemoryRawStorage` in a single process (2026-08-29, during the review
of `bug-persisted-index-outlives-the-columns-it-points-at`):

```sql
create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/t');
insert into t (id, a, b) values (1, 'aa', 'bb');
-- new session, plugin.hydrate(db) first
drop table t;
create table t (id integer primary key, z integer) using optimystic('tree://scratch/t');
select * from t;
```

returns `[{ id: 1, z: null }]`. The freshly created table reports a row nobody inserted,
and `z` — which Quereus defaults to `NOT NULL` — reads as NULL. `count(*)` is likewise
wrong from the first statement onward.

The same inheritance applies to index trees: re-creating an index of the same name at
the same URI picks up entries pointing at primary keys from the dropped table.

## Where it comes from

`OptimysticModule.destroy` (`packages/quereus-plugin-optimystic/src/optimystic-module.ts`)
is the whole of the drop path. It tears down the change subscription, calls
`table.deleteOwnSchema(name)` — which tombstones the catalog entry through
`SchemaManager.deleteSchema` — and forgets the table from its in-memory registry. It
never touches the data collection or the index trees.

That is the one site to change. The comment above it already claims the drop is so that
"a subsequent CREATE TABLE with the same name picks up the new shape rather than the old
one", which is true of the *shape* and false of the *rows*.

## What a fix needs to decide

Not a mechanical change, which is why this is a backlog ticket rather than a fix:

- **Does the plugin delete the data, or refuse to re-create over it?** Deleting is what
  a user expects from `DROP TABLE`. Refusing (erroring on a `CREATE TABLE` whose URI
  already holds rows from a dropped table) is safer in a distributed setting where
  another node may still be reading that collection, but it is a surprising new error on
  an operation that works today.
- **Is a whole-collection delete even available?** Optimystic collections are
  distributed trees; there is no "drop this collection" primitive in the plugin today,
  and the drop currently runs best-effort inside a `try {} catch {}` (a schema-tree write
  failure must not stop teardown). Deleting N rows and M index trees row-by-row is a very
  different cost and failure profile from tombstoning one catalog entry.
- **What about the other nodes?** The catalog tombstone propagates; a data deletion would
  have to as well, and a node mid-scan when it lands needs a defined outcome.

## Current state

Not fixed. Documented instead, as of this review: the plugin README's Limitations
section now states that `DROP TABLE` leaves the rows and index trees behind, that
re-creating at the same URI inherits them, and that the workaround is to use a fresh
collection URI. `test/schema-redeclare-column-identity.spec.ts` also has to work around
it — its drop-then-recreate case uses a fresh primary key so the new row does not collide
with the dropped table's row 1 — and says so in a comment.

## Steer for this fix pass (added on promotion)

**Do not build collection deletion to close this.** The tradeoffs line is right that deleting a
distributed collection is not cheap or obviously safe — another node may still be reading it, and no
"delete a whole collection" primitive exists. Building one is a feature, it needs its own design, and
it is not what makes this a corruption ticket.

What makes it corruption is narrower and fixable without that: **rows that survive a DROP are decoded
against a column list they were never written under, and surface as rows the new table's own
declaration says cannot exist.** Silence is the defect. A `CREATE TABLE` that inherits foreign rows
should fail loudly at the declaration rather than serve mangled ones.

Climb to the invariant rather than patching the observed sequence: the rule wanted is roughly *a
table may not be declared over a URI already holding rows whose shape contradicts the declaration* —
which also covers the cases nobody has typed yet (two nodes declaring incompatible shapes over one
URI; a URI reused across unrelated tables) rather than only DROP-then-CREATE. Prefer that to a check
keyed on "did a DROP happen recently", which cannot see any of those.

Points worth settling in the pass, with defensible defaults if research does not overturn them:

- **Compatible re-create should still work.** Re-declaring the same shape over the same URI is the
  supported way a node states its view of a table (`bug-persisted-index-outlives-the-columns-it-points-at`
  leans on it). Only a contradicting shape should be refused.
- **Say what to do about it.** A refusal that names the URI, the shape found, and the shape declared
  is actionable; a bare error sends someone to the source.
- **Secondary-index trees at `<uri>/index/<name>` have the same problem** and are named in the
  ticket — cover them or state explicitly why not.
- If the honest conclusion is that a sound check needs a primitive that does not exist, say so and
  route to `blocked/` with the options laid out. Do not leave the corrupting path silent because the
  complete fix is out of reach — a loud, conservative refusal beats mangled rows.
