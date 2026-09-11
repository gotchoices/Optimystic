description: A cold `apply schema` over empty tables now costs one storage commit whatever the number of tables and indexes, because a new index on an empty table no longer saves its empty storage separately. A new index on a table that already has rows is saved at the end of the apply, before the catalog that lists it, so a failure can never leave a listed index missing entries.
prereq: schema-batch-catalog-coalescing
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (DeferIndexFlush type; addIndex / backfillIndexTrees deferral branch; flushDirtyTrees NOTE; markSchemaUnpersisted withheld indexes; schemaBatch.deferred; endSchemaBatch trees-then-catalog; createIndex passes the callback)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (new discardBatch)
  - packages/db-core/src/collection/collection.ts (committedRevision doc: `undefined` is a state that is safe to branch on)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (25 cases; 7 new under "index trees: …")
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 2 is now "exactly 1 commit"; growth gates compare same-mix scales)
  - docs/transactions.md ("APPLY SCHEMA coalesces catalog writes": index trees, index-tree failure, session mode)
----

# Review: index-tree flushes inside an `APPLY SCHEMA` batch

## What was built

This builds on the prereq's catalog batch, which holds every catalog write of one `apply schema` in memory and commits it once at `endSchemaBatch`. `OptimysticModule.createIndex` now passes `addIndex` a `deferFlush` callback while a batch is open (it is `undefined` otherwise, which leaves direct DDL byte-identical). In `backfillIndexTrees`, each target tree then gets one of three treatments:

- **Nothing staged, and the tree was invented** (the table has no rows; `tree.committedRevision() === undefined`): no flush and no deferral. The tree is left exactly as CREATE TABLE leaves an unwritten main tree. Its first write rides the next DML commit, because `reconcileMaintainedIndexes` already registered it with the transaction bridge.
- **Entries staged** (an index added over a populated table): deferred into `schemaBatch.deferred`, keyed per SchemaManager, then per tree, so a tree is flushed once.
- **Nothing to push**: skipped, as before.

`endSchemaBatch` handles each manager in turn. It first lands that manager's deferred trees (`sync()`, skipping trees with nothing unsynced), then commits its catalog batch. If a tree fails to land, the catalog commit is skipped (`SchemaManager.discardBatch()`, new). The manager's written tables are then marked unpersisted, as the prereq does for a failed catalog commit, but every index whose tree did not land is **withheld** from that re-persist. The failed tree and any later tree not yet attempted count as not landed. `markSchemaUnpersisted(withheldIndexes)` leaves those indexes out, together with any in-memory UNIQUE constraint derived from them.

Why withhold: the re-initialization builds a new IndexManager and may open a fresh, empty tree instance. Re-persisting the index would therefore list it over missing entries, which is the exact silently-wrong-results case the tree-before-catalog order exists to prevent. In the running process a read routed through a withheld index refuses loudly (`assertIndexMaintained` / the scan guard). A fresh Database does not list the index, and a re-apply from there rebuilds it.

The `NOTE:`s the ticket asked for are in place: ordering at the flush site in `endSchemaBatch`; the avoidable non-batch flush at `flushDirtyTrees`; the checkpoint not withdrawing deferred trees at `createIndex`.

## Measured (cold-apply-cost.spec.ts: 1-node mesh, coordinated commit path, legacy bridge)

| | before (after catalog batch) | after |
|---|---|---|
| commits, small / large | 14 / 14 (`1 + I`) | **1 / 1** |
| driver calls per object | 17.6 / 6.4 | 2.2 / 1.4 |
| transactor gets per object | 2.5 / 1.5 | 1.3 / 1.1 |
| round trips (absolute) | 91 / 181 | 39 / 129 |
| findCluster (absolute) | 42 / 42 | 3 / 3 (3.00 per commit, unchanged) |

Gate 2 is now an equality (exactly one commit at every scale). **Design change to review:** the growth gates (3, 5, 6) now compare SMALL (9 tables + 13 indexes) with a new SMALL_X3 (27 + 39), which has the same mix, instead of LARGE (54 + 13). With the per-index flush gone, a table costs about two round trips (a get plus its change subscription) and an index about one. The table-heavier LARGE therefore read 1.77 → 1.93 round trips per object with nothing superlinear anywhere, and gate 6 tripped on that confound. LARGE is kept for the per-scale ceilings. The header explains this.

## How to validate

```
yarn workspace @optimystic/db-core build            # its doc changed; the plugin's stale-build guard insists
yarn workspace @optimystic/quereus-plugin-optimystic build
cd packages/quereus-plugin-optimystic
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/schema-batch.spec.ts" "test/cold-apply-cost.spec.ts" --reporter spec --exit
yarn workspace @optimystic/quereus-plugin-optimystic test   # 795 passing, 13 pending, smoke ok (2026-09-10)
yarn typecheck; yarn lint:docs                             # from the repo root; both clean
```

The test cases, as usage scenarios (each proves index use through `index:seek` trace lines, not only row results):

- A cold apply of 2 tables + 2 indexes makes 1 commit (was 3), and no commit carries index-tree blocks.
- An empty table plus an index via apply, then INSERT, in the legacy bridge: the INSERT's commit sweep carries the index tree once, and a fresh Database seeks the row through it.
- The same in **session mode** (the existing session case, extended).
- An empty table plus an index, then a fresh Database before any write: hydrate lists the index, a seek returns nothing without failing, and DML then works.
- A populated table plus a new index: 2 commits, index tree **before** catalog sync (asserted on an ordered trail), every existing row reachable, also from a fresh Database.
- A failed deferred tree: the apply rejects, the catalog sync is never attempted, a fresh Database lists no index, the original Database refuses the index read loudly and counts rows correctly, its recovery lists nothing, and a corrected re-apply builds the index complete.
- A UNIQUE index over pre-existing duplicates: builds, both rows are indexed, a future duplicate is refused.
- Two indexes on one populated table: each tree commits exactly once, both before the catalog.
- A read through a deferred index inside a hand-opened batch sees the staged entries; the tree lands at the end.
- Changed existing case: "a CREATE INDEX that fails inside the batch…" now fails the index tree's open (`failGet`) rather than its flush, because an empty table's tree is no longer flushed.

## Known gaps and judgement calls (please push on these)

- **Branching on `committedRevision() === undefined`.** That accessor said "DIAGNOSTIC ONLY — do not branch on this". I amended its doc in `collection.ts` to carve out `undefined` as a state ("invented, never adopted a committed revision"), which only this instance can change. The ticket named this accessor. If a reviewer prefers a dedicated `isInvented()` predicate, that is a small db-core change.
- **Loud-but-stuck after a failed tree.** In the original process, the withheld index stays in the engine's catalog but is unmaintained, so index-routed reads throw until the index is re-declared from a connection that does not list it. `unmaintainedIndexMessage` advises "Re-declare the index on this connection (CREATE INDEX)", but in this state the engine still lists the index, so that advice probably does not work in-process (not tested). I chose loud over silently wrong. Say so if the message should change.
- **First tree failure stops that manager's remaining flushes**; the unattempted trees are withheld too. The alternative (keep flushing, withhold only failures) would recover more indexes after a single transient failure.
- **Not tested:** the failure path for a table *created* in the same apply over populated (adopted) storage; several managers with deferred trees where one fails; a deferred tree whose table is dropped later in the same apply; the derived-UNIQUE filter in `markSchemaUnpersisted`; a populated-table deferral in session mode (it syncs inside the apply's coordinator transaction, which is the same pattern as the old mid-statement flush); a real apply whose later statement reads through the new index (no DDL statement in the migration loop reads table data, so the hand-opened batch stands in for it).
- **Session mode still costs `1 + T + I`.** Measured: 2 tables + 1 index gives 4 commits (catalog, `default/t0`, `default/t1`, `default/t0/index/t0_by_name`), with the trees committed after the catalog by the apply's own coordinator transaction. The count is the same as before this ticket; only the index tree's commit moved. The session case now pins it. Filed as `backlog/feat-session-mode-apply-schema-tree-commits`.
- **Found and filed, not fixed:** `fix/create-index-on-untouched-hydrated-table`. `createIndex` throws "table not found … Cannot create index" for a hydrated table no statement has touched yet (verified via apply). The failure-path case works around it by re-applying from a non-hydrated Database, with a comment naming the fix ticket.
