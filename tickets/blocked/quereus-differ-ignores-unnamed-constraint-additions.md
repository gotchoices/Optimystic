description: When a new schema version adds a CHECK or UNIQUE rule without a name to a table that already exists, the SQL engine's schema migration silently does nothing, so upgraded databases never get the rule while fresh installs do — the fix belongs in the separate quereus repository.
files: ../quereus/packages/quereus/src/schema/schema-differ.ts
repro: verified
----

**Blocked: dependency outside this repo.** Unblocks when quereus's declarative differ emits (or explicitly refuses) added unnamed constraints and a quereus release containing that is consumed here.

# What happens

Against Quereus's own in-memory tables, no Optimystic involved (verified 2026-09-17 with a scratch mocha spec, since deleted):

```sql
declare schema s { table t { id integer primary key, a integer null, b integer null } }
apply schema s;
declare schema s { table t { id integer primary key, a integer null, b integer null, check (a > 0) } }
diff schema s;    -- empty
apply schema s;   -- no-op; t has no CHECK
```

Same result for a column-level `a integer null check (a > 0)` (a fresh apply names it `_check_a`) and, per the earlier report, for an unnamed table-level `unique (a)`. A *named* `constraint pos check (a > 0)` is diffed and emitted as `ALTER TABLE … ADD`.

So a database created at version 1 and upgraded to version 2 lacks the rule forever, while one created at version 2 enforces it. For Optimystic this also means the stored catalog record differs between the two machines, which a downstream host relies on being identical.

# Where

`packages/quereus/src/schema/schema-differ.ts` in the quereus checkout: constraint diffing appears to key on constraint names, so an unnamed constraint has no identity to diff (inferred from the behaviour, not traced line by line).

# Proposed resolution (default)

The differ matches unnamed CHECKs by their normalised expression (and column-level ones by `_check_<column>`), unnamed UNIQUEs by column set, and emits `ALTER TABLE … ADD` for additions. Where it cannot match safely (e.g. an unnamed CHECK whose expression changed), it reports the difference instead of silently ignoring it.

Rejected alternative: require names on all constraints in declarative schemas — simpler, but breaks existing declarations that rely on unnamed constraints being accepted.

If nothing is done: applications must name every constraint they might add in a later version; the plugin README should say so. Fully reversible — a differ change only affects future applies.
