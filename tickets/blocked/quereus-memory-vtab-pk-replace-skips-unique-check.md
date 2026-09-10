description: The SQL engine's built-in in-memory tables let "insert or replace" hand a replaced row a value another row already holds in a column declared unique, silently ending up with two rows sharing it — but the fix is in the separate quereus repository, so someone has to decide whether we patch it there.
files: packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts
repro: verified
----

# The quereus in-memory table module commits a duplicate under `insert or replace`

## Why this is in your inbox

The defect is in the **quereus engine repository**, not this one — `packages/quereus/src/vtab/memory/layer/manager.ts` in the sibling checkout that this repo consumes through a `portal:` dependency (the released `@quereus/quereus`, v4.19.0 at the time of writing). Nothing in Optimystic can fix it. The decision is whether to patch it upstream, and if so whether that lands before or after Optimystic's own arm of the same bug.

## What happens

Against a plain in-memory table (no Optimystic involved):

```sql
create table T (id integer primary key, v text not null unique);
insert into T values (1, 'a'), (2, 'b');
insert or replace into T values (1, 'b');   -- succeeds, no error
select id, v from T order by id;            -- [{id:1,v:'b'},{id:2,v:'b'}]
select id from T where v = 'b';             -- [{id:1},{id:2}]
```

Two rows now share a value in a column declared unique, and an indexed lookup returns both. SQLite would have deleted row 2 as part of resolving the replacement. The same thing happens without a statement-level clause when the primary key carries its own `on conflict replace`.

Verified on 2026-09-10 by running these statements through the engine directly from this repo's test setup.

## Where

`performInsert` in `@quereus/quereus/src/vtab/memory/layer/manager.ts`. When the pre-insert lookup finds a row at the primary key and the resolved action is `ConflictResolution.REPLACE`, the method records the upsert and returns immediately. The secondary-uniqueness pass, `checkUniqueConstraints`, sits *after* that block, on the path taken only when no row existed — so a replacement never checks any UNIQUE constraint other than the primary key. The fix has the same shape as Optimystic's: probe the secondary constraints before the upsert, excluding the row being replaced, and resolve each under its own conflict action (evict for REPLACE, return the constraint result for ABORT, swallow for IGNORE).

## Why it matters here

Optimystic's virtual table has the same gap at the same shape, tracked as `implement/insert-or-replace-on-pk-resolves-secondary-unique`. Optimystic's index trees carry a concurrency guard, so its version of the bug surfaces as a wrong *rejection* rather than a duplicate — nothing is corrupted. Fixing Optimystic (which we should, independently of this) therefore makes the two modules disagree: Optimystic will evict the colliding row like SQLite, the in-memory module will keep committing the duplicate. Anything written to compare the two modules' conflict behaviour has to encode that divergence until this is resolved.

## Options

- Patch quereus upstream, cut a release, bump the dependency here. Removes the divergence and the corruption.
- Leave it, and accept that the in-memory module is not a uniqueness-correct reference for `insert or replace`. Optimystic's fix stands either way; only cross-module comparison tests are affected.
