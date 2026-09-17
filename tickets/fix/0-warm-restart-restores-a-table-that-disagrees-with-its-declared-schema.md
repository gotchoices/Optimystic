description: After the change that gave each schema its own table storage, restarting an existing database can bring a table back with the wrong column type or the wrong columns, so the database refuses to open. A downstream application found eleven of its tests failing on restart; nothing in this repository's tests restarts a database like that.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/schema/table-identity.ts (`defaultCollectionUri`, `catalogKey` — new in `1208af4b`)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (catalog read/write keyed by schema and table; `hydrateCatalog` / warm restart)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`hydrate`, `instantiateTable`, `parseTableSchema`; the restore-into-declared-schema change)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (batched catalog path)
  - packages/quereus-plugin-optimystic/test/same-named-tables-across-schemas.spec.ts (0.5's spec — it covers restart, but evidently not this shape)
difficulty: medium
repro: downstream
----

# What broke, and where it was seen

Reported 2026-09-16 by the session reviewing a **sereus** ticket, after running sereus against the
optimystic plugin rebuilt at `6302f2e8` — the review commit of
`same-named-tables-in-two-schemas-share-storage` (implementation `1208af4b`). Quereus was clean at
`ff1c619c6`. At least one of the failing files (`discovered-strands-late-subscriber.spec.ts`) was green
earlier on 2026-09-16, before that rebuild.

**Eleven cadre-core tests in seven files, plus two integration scenarios that restart**, all restart or
hydration shapes, none in code the sereus ticket touched. Listed verbatim in sereus's
`tickets/.pre-existing-error.md`.

**Nine of the eleven are one error, on a WARM restart of sereus's control database:**

```
QuereusError: Failed to execute DDL:
  ALTER TABLE CadreControl.CadrePeer ALTER COLUMN UpdatedAt SET DATA TYPE int
Module for table 'CadrePeer' does not support ALTER COLUMN
```

raised from quereus's `runBatchedMigrationLoop` (`schema-declarative.ts:541`). The table restored from
the catalog no longer matches the declared column type, so the declarative diff tries to alter it — and
the module cannot. Files: `control-database-solo-warm-start.spec.ts` (5),
`control-database-solo.spec.ts`, `control-database-offline-peers.spec.ts`,
`control-start-storage-op-budget.spec.ts`, `discovered-strands-late-subscriber.spec.ts`.

**The other two look like the same family:**
- `strand-transactor-handover.spec.ts` — "reads and appends, through the network transactor, a store
  the local transactor wrote" reads back an **empty set** (expected `gen1-a/b/c`).
- `strand-membership-writer.spec.ts` — "hydrates a grown strand (3 members, 2 managers) into a fresh
  Database" fails with `context.ManagerKey isn't a column`.

It **blocks every restart-shaped test in sereus**.

# Why this repository did not see it

The plugin suite (958 passing) went green on both commits. Nothing here warm-restarts a **declarative
schema in a non-`main` schema** whose column types have to survive a round trip through the catalog, and
0.5's own restart case evidently does not exercise the path that goes wrong. Closing that gap is part
of the fix, not an afterthought.

# What to establish, in order

1. **Write the failing spec here first.** A declarative schema in a named schema (not `main`), at least
   one column whose declared type is `int` or a timestamp-like type, commit rows, warm-restart over the
   same storage, re-apply the declaration. Assert it opens without a migration and the rows are there.
   Add a case shaped like the handover one (write through one transactor, read through another after
   restart). If it will not fail, say what differs from sereus's shape rather than guessing.
2. **Bisect** between the build before `1208af4b`, `1208af4b`, and `6302f2e8`, so the fix targets the
   commit that actually introduced it rather than the one nearest to hand.
3. **Diagnose.** Candidates worth checking rather than assuming:
   - The catalog record's column types serialised or read back differently under the new key.
   - Restore creating the declared schema and registering the table in a way that loses type detail.
   - Restore reading a record for a **different** table (a key collision or a stale bare-name record
     from an earlier build being matched), which would also explain `ManagerKey isn't a column` and the
     empty read-back.
   - A mismatch between the batched and direct catalog paths.

# Boundaries

- **Do not paper over it in quereus's migration loop.** The symptom surfaces there, but the defect is
  that the restored table is wrong. A restore that silently "migrates" would hide the next one.
- **Keep 0.5's guarantees.** Same-named tables in different schemas must still get separate storage and
  catalog entries, and catalog content must stay **deterministic from the schema definition alone** —
  sereus writes the catalog alone on every machine at launch and relies on byte-identical content (see
  `backlog/more-design/6.5-partition-healing`).
- **A second defect may be hiding behind this one.** Sereus also sees a joining machine fail to read a row
  it just committed (`fix/1-a-node-cannot-read-a-row-it-just-committed`), but only on this broken build.
  Do not try to fix that here; do note whether anything you find would explain it.

# TODO

- Failing spec first (warm restart, non-`main` schema, typed columns; plus the handover shape).
- Bisect and name the introducing commit.
- Fix, with the spec going green and 0.5's spec still green.
- `yarn lint`, `yarn build`, `yarn workspace @optimystic/quereus-plugin-optimystic test`.
- Say in the handoff that sereus should re-run its eleven cadre-core tests and two integration scenarios,
  and then a five-run rerun of its device-shape join scenario.
