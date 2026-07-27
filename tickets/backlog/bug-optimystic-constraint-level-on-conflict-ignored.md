description: When a table column is declared to quietly skip duplicate rows instead of raising an error, the database ignores that instruction and raises an error anyway.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-hydrate.spec.ts
difficulty: medium
----

## What is wrong

SQL lets a uniqueness rule declare, at the point it is defined, what should happen
when something violates it:

```sql
create table I (Id integer primary key, Stamp text not null unique on conflict ignore)
  using optimystic('tree://…');
```

`on conflict ignore` means "if a later row repeats an existing `Stamp`, silently drop
that row — do not fail the statement." The optimystic-backed table does not honour
that. It raises `UNIQUE constraint failed` instead, exactly as if no action had been
declared.

Only the *statement*-level form works today — `insert or ignore into I …` behaves
correctly. So the two spellings of the same intent disagree.

This affects the primary key's declared action as well as any secondary uniqueness
rule, and it is independent of how the database was opened (it reproduces on a plain
`create table` in a fresh process; it is not specific to the fast-reopen path).

## Reproduction

Confirmed against the current code while reviewing
`bug-optimystic-hydrate-unique-not-enforced`. Drop this into
`packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts` (its existing
harness supplies `db`):

```ts
await db.exec(`
  create table I (Id integer primary key, Stamp text not null unique on conflict ignore)
    using optimystic('tree://onconflict/test')
`);
await db.exec(`insert into I (Id, Stamp) values (1, 'a')`);
await db.exec(`insert into I (Id, Stamp) values (2, 'a')`); // throws; should be a silent no-op
// expected: one row remains, no error
```

Observed failure:

```
ConstraintError: UNIQUE constraint failed: I.Stamp
  at processInsertRow (…/runtime/emit/dml-executor.js:702)
```

## Why it happens

The declared action *is* correctly parsed and, as of the hydrate fix, correctly saved
and restored — the review added a passing test that pins that round-trip
(`round-trips a constraint-level 'on conflict' action through persistence and hydrate`
in `test/secondary-unique-hydrate.spec.ts`). The metadata is present and correct.

What is missing is that nothing ever *reads* it. The virtual table resolves a
duplicate using only the action the engine hands it for the current statement, and
falls back to "raise an error" when the statement declared none. The per-rule
declared action is never consulted.

Note the engine (Quereus) resolves this itself for its own in-memory tables — see
`runtime/emit/constraint-check.ts`, which picks statement-level action first and the
rule's own declared action second. The optimystic table needs the equivalent
precedence. Part of the work is establishing which side is expected to apply it for a
*virtual* table, since the engine may already intend to pass down an effective action
and simply not be doing so for this path.

## Expected behaviour

For every uniqueness rule (primary key and secondary), when a write collides:

- a statement-level `insert or <action>` wins;
- otherwise the action declared on the rule itself applies;
- otherwise the write fails, as today.

`ignore`, `replace`, `abort`, `fail` and `rollback` should each behave the same way
whichever spelling selected them.

## Scope note

Pre-existing; not introduced by the hydrate fix. It surfaced during that review
because the fix began persisting the declared action, which made its being unused
visible.
