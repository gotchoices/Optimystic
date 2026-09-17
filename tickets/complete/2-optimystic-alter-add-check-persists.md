description: When a later schema version adds a named CHECK rule to an existing table, it is now saved in the table's catalog record, so a restarted machine still enforces it and its record matches a machine that installed the new version fresh.
prereq: optimystic-catalog-record-canonical-list-order
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticModule.alterTable` + private `addCheckConstraint`; `OptimysticVirtualTable.addCheckConstraint`; module-level `renameColumnSchemaOnly`; updated NOTE on `resolveConnectedTable`)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`SchemaManager.withCheckConstraint`)
  - packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts
  - packages/quereus-plugin-optimystic/test/schema-migration.spec.ts
  - packages/quereus-plugin-optimystic/README.md ("Warm Restart")
----
# What was wrong

Version 1 declares `table t { id integer primary key, a integer null }`; version 2 adds `constraint pos check (a > 0)`. `apply schema` runs `ALTER TABLE s.t ADD constraint pos check (a > 0)`. The optimystic module had no `alterTable` hook, so Quereus added the CHECK to its in-memory catalog only. A restart that only called `hydrate` accepted rows breaking `pos`, and the migrating machine's catalog record differed from a machine that applied version 2 fresh.

# What changed

`OptimysticModule.alterTable` now exists. Each kind of ALTER is handled like this:

- **ADD CONSTRAINT … CHECK** (named or unnamed): builds the CHECK with Quereus's public `buildCheckConstraintSchema` + `collectTableConstraintNames` (both exported from `@quereus/quereus`, no internals), using the engine's catalog entry, so an unnamed CHECK gets the same `check_<n>` name as before. The table is resolved the way `createIndex` does it: a hydrated table nothing has touched yet is instantiated, then initialized and registered inside the statement's batch checkpoint. `OptimysticVirtualTable.addCheckConstraint` initializes the table if needed, re-reads the stored record (skipping the cache), adds the CHECK (`SchemaManager.withCheckConstraint`: a CHECK with the same name, compared ignoring case, is replaced rather than duplicated), writes it with `storeStoredSchema` (inside `apply schema` this joins the batch), and only then adds the CHECK to the instance's own `tableSchema.checkConstraints`. Returns the engine's catalog entry with the CHECK appended. Existing rows are not checked against the new rule, same as Quereus's memory tables and the old engine-only path.
- **RENAME COLUMN**: `renameColumnSchemaOnly` copies the engine's old schema-only fallback exactly and writes nothing. A `NOTE:` points at `backlog/bug-optimystic-rename-column-lost-on-restart`.
- **ADD CONSTRAINT UNIQUE / FOREIGN KEY, ADD/DROP COLUMN, DROP/RENAME CONSTRAINT, ALTER COLUMN, ALTER PRIMARY KEY**: rejected with `UNSUPPORTED` and the same error text the engine used before. For ALTER PRIMARY KEY the error you see is still the engine's own: the engine treats our `UNSUPPORTED` as a cue to rebuild the table, then rejects that because the module has no `renameTable`.
- No schema-change event is emitted, because the module has no event emitter. Quereus's auto-emit path covers it (`emitAlterSchemaEvent`), the same way it did before.

# How it was validated

- `yarn typecheck`, `yarn build`, and the full `yarn test` in `packages/quereus-plugin-optimystic`: 986 passing, 13 pending, 0 failing, and the smoke test passes.
- **Checked that the new tests fail without the fix.** I renamed `alterTable` so the hook didn't exist, rebuilt, and ran the tests: every CHECK test in both specs failed (8 failures, including the NOT NULL ordering test, which documents the new behaviour), and every refusal test and the RENAME COLUMN test passed. So the error text really is unchanged.
- **Checked that the cached schema update matters.** I restored the hook but skipped the `tableSchema` update: only "a CHECK added to a table this session already wrote through is not dropped by that table re-opening its record" failed. Both probes were reverted and the code rebuilt.

## Test cases

`test/alter-table-arms.spec.ts`:
- One test per rejected kind: the error is a `QuereusError` with `UNSUPPORTED` and the old text, the catalog entry is the same object as before, and the rows are unchanged.
- ADD COLUMN NOT NULL with no default on a table that has rows: the missing-default error now comes first (see gaps). With a default, the `UNSUPPORTED` error is still returned.
- RENAME COLUMN renames for the current session, and a hydrate-only restart shows the old name again. This pins today's behaviour; it is not a feature.
- A named ADD CHECK is enforced immediately and after a hydrate-only restart. An unnamed one gets the name `check_1` and keeps it after restart.
- ADD CHECK as the very first statement against a hydrated table: a third session hydrates *before* the second session touches the table again, so an unrelated later write can't be what saved the CHECK.
- Cached instance kept in sync: `markSchemaUnpersisted()` followed by an insert (which re-initializes the table and compares its schema to the record) does not remove the CHECK.

`test/hydrate-restores-declared-table.spec.ts`:
- `everyFeatureDeclare(indexes, checks)`. `MIGRATION_PATHS` covers four upgrades: adding ByScore, adding BigNonNegative, adding both in one apply, and adding BigNonNegative *between* `AScoreBounded` and `ZQtyBounded`. In that last one, creation order and name order differ.
- Record bytes after each path are identical to a fresh apply of the target version.
- An ALTER-added CHECK plus an index added to an empty table in one apply produce exactly 1 commit, and the record matches a fresh apply.
- For every path, a hydrate-only restart gives a table equal to the declared one under `declarationView`. The migrating session's own table also equals it, re-declaring commits nothing, and `expectEveryBehaves` confirms BigNonNegative is enforced.

# Known gaps and things for the reviewer to check

- **Which error comes first changed for some rejected ALTERs.** Quereus only runs its pre-dispatch checks for modules that have `alterTable`. So `add column x integer not null` with no default, on a table with rows, now gets "NOT NULL constraint failed … existing rows cannot be backfilled" (after reading one row) instead of `UNSUPPORTED`. A malformed ADD UNIQUE or FOREIGN KEY (duplicate constraint, index name collision, collation conflict, wrong column count) likewise reports that problem first. It is still rejected and nothing changes. This is documented on `alterTable` and pinned by one test. I did not use `delegatesNotNullBackfill` to get the old order back, because it would claim a capability the module doesn't have.
- **That one-row read happens outside the batch checkpoint.** If it is the first touch of a hydrated table during an apply and the record differs from the hydrated shape, the first touch can write the record outside the checkpoint. The existing NOTE on `resolveConnectedTable` was updated to say so. I judged it too rare to wrap.
- **Instantiated or uninitialized tables are fully initialized before the write** (a table nothing has touched yet is also registered, the way `createIndex` does it). For a hydrated table that means reading the collection and index headers during the ALTER. No extra commit happens (covered by the 1-commit test), but read counts under `cold-apply-cost.spec.ts`-style measurement were not checked for an apply that only adds CHECKs.
- **Rollback inside an explicit transaction was not tested.** For a direct `begin; alter table … add check …; rollback;` outside `apply schema`, the record write goes through `storeStoredSchema` right away, just as unbatched `CREATE INDEX` does. It may not roll back with the transaction. I did not test this; it is the same situation as `CREATE INDEX` today.
- **Replacing a same-named CHECK in the record** (local DDL wins) is untested. It only matters when the record already has a CHECK the local session's catalog doesn't know about, for example after another writer re-declared the table.
- **Quereus's materialized-view reshape paths** (`materialized-view-helpers.ts`) check `module.alterTable` and now call ours instead of raising their "inexpressible reshape" error. Optimystic doesn't host materialized views, so this was not exercised.
- ALTER PRIMARY KEY now also logs a Quereus warning ("declined an in-place re-key") before the final rejection.
- Not in scope, and still upstream: Quereus's schema diff never emits unnamed table-level or column-level CHECK additions (`blocked/quereus-differ-ignores-unnamed-constraint-additions`); the README now says so. Supporting UNIQUE and FOREIGN KEY: `backlog/feat-optimystic-alter-add-unique-and-foreign-key`. Saving RENAME COLUMN: `backlog/bug-optimystic-rename-column-lost-on-restart`.

## Review findings

Read the implement diff (33efe02d) first, then the engine paths it reproduces (`add-constraint.ts`, `alter-table.ts` RENAME COLUMN / ADD COLUMN arms, `materialized-view-helpers.ts`), then the handoff.

- **Correctness vs. the engine fallbacks** — checked. The CHECK is built with the same builder, index and taken-name set as `runAddCheckEngineSide`, so minted names match. `renameColumnSchemaOnly` matches the engine's `else` branch line for line, and the engine does the same post-processing (statistics carry, propagation, event) whichever branch ran. Every other arm's refusal text matches the engine's `!module.alterTable` throws. The `switch` has no default, so a new `SchemaChangeInfo` kind fails typecheck (no implicit return) instead of silently returning undefined — good.
- **Persistence path** — checked. `storeStoredSchema` → `mergePersistedSchemas` merges only index lists, so the incoming CHECK list wins; the case-insensitive same-name replacement therefore really reaches storage. Fresh read + batch checkpoint mirror `createIndex`/`addIndex`.
- **Gap "same-named CHECK replacement untested"** — probed and closed: added test "an ADD CHECK whose name another writer already saved replaces that CHECK in the record" (two sessions; the later `SMALL` replaces `small`, and is enforced after a hydrate-only restart).
- **Gap "rollback inside an explicit transaction untested"** — probed with a throwaway spec (deleted): `begin; alter table … add constraint small check …; rollback;` leaves `small` in both the engine catalog and the record. Engine and record agree, so no divergence; not a defect of this change. No ticket.
- **Gap "materialized-view reshape paths now call the hook"** — checked: every MV path is gated on `module.getBackingHost` (create at helpers:331, attach at :1247), which optimystic does not implement, so the reshape calls are unreachable. Tripwire parked as a `NOTE:` on `OptimysticModule.alterTable` (revisit the arms if the module gains `getBackingHost`).
- **Precedence change for refused ADD COLUMN NOT NULL / malformed UNIQUE/FK** — accepted as documented by the implementer (still refused, nothing changes, pinned by a test, `NOTE:` at the site). No action.
- **One-row read outside the batch checkpoint** — already a `NOTE:` tripwire on `resolveConnectedTable`; agree with it. No action.
- **Read-cost of first-touch initialize in a CHECK-only apply** — not measured; conditional perf concern only, covered by the existing first-touch reasoning on `createIndex`. No ticket.
- **Type safety / error handling** — `RowConstraintSchema`/`AddedConstraint` derived from exported types rather than internals; instance schema updated only after the write is staged. Nothing found.
- **DRY / modularity / file size** — `optimystic-module.ts` is 4762 lines (`wc -l`), was already large before this change (+~190 here); the new code is cohesive with `createIndex`. No new size-debt ticket filed: the addition is small and matches existing structure. The same-name filter is duplicated between `withCheckConstraint` and the instance update (one line each, commented as intentionally alike); left as is.
- **Docs** — README "Warm Restart" paragraph reflects the new behaviour and the upstream limits; referenced tickets (`bug-optimystic-rename-column-lost-on-restart`, `feat-optimystic-alter-add-unique-and-foreign-key`, `quereus-differ-ignores-unnamed-constraint-additions`) all exist. No other docs mention optimystic ALTER.
- **Validation** — `yarn typecheck`, `yarn build`, full `yarn test` in `packages/quereus-plugin-optimystic`: 987 passing, 13 pending, 0 failing; smoke ok. No lint script in the package.
