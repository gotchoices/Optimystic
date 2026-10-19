description: A schema upgrade that adds a column and an index on that new column in the same version fails, because Quereus creates the new index before it adds the column. The fix belongs in Quereus; once a Quereus release carries it, this repository only drops the documented workaround.
architecture: packages/quereus-plugin-optimystic/README.md
files: ../quereus/packages/quereus/src/schema/schema-differ.ts (`generateMigrationPlan`, the "Assertion creates LAST" comment), packages/quereus-plugin-optimystic/README.md (Limitations), .release-notes.pending.md, packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts
difficulty: easy
----

**Blocked: a dependency outside this repository.** Unblocks when a Quereus release orders `apply schema`'s index creates after its per-table alter block, and this repository's `@quereus/quereus` dependency is moved to it. Quereus is maintained alongside this repository, so a maintainer can make the upstream change. Filed there as `../quereus/tickets/fix/apply-schema-creates-indexes-before-added-columns.md` (quereus f595c9fa8, 2026-10-18), reproduced on the memory module at Quereus 4.20.2 with "Column 'b' not found in table 't'".

# Quereus apply schema creates indexes before the columns it adds

Found while reviewing `catalog-only-add-and-drop-column` (Sereus #46: upgrading a party's shared control database in place).

## What happens

`generateMigrationPlan` in `../quereus/packages/quereus/src/schema/schema-differ.ts` emits, in order: drops, then `pushCreates(diff.tablesToCreate)`, `pushCreates(diff.viewsToCreate)`, `pushCreates(diff.indexesToCreate)`, and only then the per-table alter block (RENAME COLUMN → ADD COLUMN → … → DROP COLUMN). A schema version that adds a column `b` and an index on `b` therefore runs `create index … (b)` before `alter table … add column b`, and the apply fails with `Column 'b' not found`. This happens on every module, Quereus's memory module included; it is not specific to Optimystic. Checked by reading the differ (repro: static). Confirm by declaring `table t (id integer primary key)`, applying, then declaring `table t (id integer primary key, b text null)` with `index t_b on t (b)` and applying again against the memory module.

Quereus already moved assertion creates to the end of the plan for the same reason (the "Assertion creates LAST" comment, so an assertion can name a column the version adds). Index creates were not moved.

Drops are fine: `DROP INDEX` runs before the alter block, so a version that removes an index together with its column works.

## Proposed upstream change

Emit `pushCreates(diff.indexesToCreate, 'index')` after the per-table alter block (after the maintained re-attaches, beside the assertion creates), so an index may cover a column the same version adds or renames. Alternatives considered:

- Keep the order and document it (what this repository does today): every host has to split such an upgrade across two schema versions, and the failure appears only at apply time.
- Split index creates into "on existing columns" (early) and "on new columns" (late): more code for no benefit, since nothing in the alter block depends on a new index existing.

Doing nothing leaves the workaround in place; the change is reversible and local to the differ.

## Work in this repository once unblocked

- Remove the Limitations entry "In one `apply schema`, Quereus creates a new index before it adds the columns…" from `packages/quereus-plugin-optimystic/README.md`, and the matching "Known gap" sentence from `.release-notes.pending.md` (or from the changelog entry it became).
- Add one case to `test/alter-table-arms.spec.ts`: an `apply schema` that adds a nullable column and an index on it in one version succeeds, the index is maintained, and both survive a hydrate-only restart.
