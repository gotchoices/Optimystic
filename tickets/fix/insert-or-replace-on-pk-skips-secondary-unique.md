description: Replacing an existing row with "insert or replace" can hand it a value another row already holds in a column declared unique, leaving two rows with the same supposedly-unique value and no error.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts, packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts
repro: verified
severity: wrong-result
likelihood: unusual
----

# `insert or replace` on an existing primary key never checks secondary UNIQUE constraints

## What happens (verified on one handle, no concurrency involved)

```sql
create table T (id integer primary key, v text not null unique) using optimystic('tree://…');
insert into T values (1, 'a'), (2, 'b');
insert or replace into T values (1, 'b');   -- succeeds
select id, v from T order by id;            -- [{id:1,v:'b'},{id:2,v:'b'}]
select id from T where v = 'b';             -- [{id:1},{id:2}]  (the UNIQUE index holds both)
```

The replacement of row 1 succeeds and row 2 keeps `'b'`, so the UNIQUE column holds a duplicate, and the index tree confirms it. No error is raised. SQLite's REPLACE semantics (which the engine's own memory module follows) resolve *every* uniqueness conflict the new row raises: row 2 should have been evicted (its `evictedRows` reported so the engine runs its delete pipeline), or, under a constraint declared `on conflict abort`, the statement should have been refused.

## Where

In `OptimysticVirtualTable.update`, the `'insert'` arm's primary-key-collision branch: after `this.collection.get(insertKey)` finds the existing row and the resolved action is `ConflictResolution.REPLACE`, it stages the replacement and calls `updateIndexEntries` directly. That branch never calls `resolveSecondaryUniqueDecision`, unlike the fresh-insert branch a few lines below it (which resolves every binding UNIQUE constraint under its own action, evicts REPLACE collisions via `applyUniqueEvictions`, and returns a structured `constraint` result for ABORT).

The UPDATE arm already handles the analogous shape correctly (a PK-preserving update that takes another row's unique value probes with `excludeKeys = {oldKey}`), and `update-pk-move-uniqueness.spec.ts` covers it, so the fix is to route the REPLACE-on-PK branch through the same decision: probe with the replaced row's own key excluded, evict or refuse per constraint, then stage.

## Expected behaviour

Each secondary UNIQUE constraint is resolved under its own effective action (`resolveConflictAction`: statement clause first, then the constraint's declared action, else ABORT), exactly as the fresh-insert branch does:

- Resolves REPLACE (the repro above, since the statement-level `or replace` applies to every constraint): the colliding row(s) are evicted, reported in `evictedRows`, and the replacement lands; the UNIQUE index ends up with exactly one entry for the value.
- Resolves ABORT: reachable when the PK collision is resolved REPLACE by the PK's own declared action (`id integer primary key on conflict replace`) while the statement carries no clause. The statement returns the ordinary `{status: 'constraint', constraint: 'unique', message: 'UNIQUE constraint failed: T.v'}` result and stages nothing.
- Resolves IGNORE: the write is swallowed and nothing changes (the existing mixed-action divergence documented at `resolveSecondaryUniqueDecision` applies).

## Concurrency note

The review that filed this ticket already made this branch pass `guardedUniqueIndexes(values)` to `updateIndexEntries`, so a *concurrent* rival taking the value is refused at replay like every other path. The sequential gap above is the remaining defect.
