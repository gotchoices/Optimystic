description: A cold `apply schema` over empty tables now costs one storage commit whatever the number of tables and indexes, because a new index on an empty table no longer saves its empty storage separately. A new index on a table that already has rows is saved at the end of the apply, before the catalog that lists it, so a failure can never leave a listed index missing entries.
prereq: schema-batch-catalog-coalescing
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (DeferIndexFlush; addIndex / backfillIndexTrees deferral branch; flushDirtyTrees NOTE; markSchemaUnpersisted withheld indexes; schemaBatch.deferred; endSchemaBatch trees-then-catalog; createIndex passes the callback; unmaintainedIndexMessage)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (discardBatch)
  - packages/db-core/src/collection/collection.ts (committedRevision doc: `undefined` is a state that is safe to branch on)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (27 cases; 9 under "index trees: …")
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 2 is "exactly 1 commit"; growth gates compare same-mix scales)
  - docs/transactions.md ("APPLY SCHEMA coalesces catalog writes": index trees, index-tree failure, session mode)
----

# Complete: index-tree flushes inside an `APPLY SCHEMA` batch

## What landed

While an `APPLY SCHEMA` batch is open, `OptimysticModule.createIndex` gives `addIndex` a `deferFlush` callback. Outside a batch the callback is absent and direct DDL behaves exactly as before. In `backfillIndexTrees`, each new index tree then gets one of three treatments:

- **Empty table, freshly invented tree.** The tree is neither flushed nor deferred. It stays unwritten, like the unwritten tree `CREATE TABLE` leaves for the table itself, and its first write rides the next DML commit.
- **Populated table.** The tree is deferred into `schemaBatch.deferred`. `endSchemaBatch` lands it before that manager's catalog commit.
- **Nothing to push.** Skipped.

If a deferred tree fails to land, the manager's catalog commit is cancelled (`SchemaManager.discardBatch`). The tables are then recovered as for a failed catalog commit, except that every index whose tree did not land is withheld from the re-persist, together with any UNIQUE constraint derived from it.

Measured by `cold-apply-cost.spec.ts` (1-node mesh, legacy bridge): 1 commit at every scale (was `1 + I` = 14), 2.2 / 1.4 driver calls per object (was 17.6 / 6.4), round trips 39 / 129 (was 91 / 181). Session mode still costs `1 + T + I` (`backlog/feat-session-mode-apply-schema-tree-commits`).

## Review findings

**Read first:** the implement diff (`3f24b8a8`) in full, before the handoff; then the surrounding code in `optimystic-module.ts` (`endSchemaBatch`, `underBatchCheckpoint`, `markSchemaUnpersisted`, `destroy`, `unmaintainedIndexMessage`), `schema-manager.ts`'s batch methods, and the `actionContext` assignments in `collection.ts`.

**Validation:** plugin build; `yarn workspace @optimystic/quereus-plugin-optimystic test`: 797 passing, 13 pending, smoke ok (2026-09-11). Also `yarn typecheck` and `yarn lint:docs` from the repo root, both clean.

### Found and fixed in this pass

- **The recovery advice was wrong after a failed index tree (verified).** After the failure, the original Database still lists the withheld index. Probed in that Database: a re-apply plans nothing, and a bare `CREATE INDEX` is refused with "Index … already exists". So the advice every "does not maintain index" error gave ("Re-declare the index … (CREATE INDEX)") could not be followed. `DROP INDEX` then `CREATE INDEX` does recover fully. Fixed:
  - `unmaintainedIndexMessage` now adds "DROP INDEX it first if this connection still lists it". No test pins that text.
  - The `markSchemaUnpersisted` doc and the "Index-tree failure" paragraph in `docs/transactions.md` now describe the real recovery route instead of "re-declared from a connection that does not list it".
  - New regression case: "after a deferred index tree fails to land, DROP INDEX then CREATE INDEX recovers it in the same Database". It pins the refused re-apply and bare CREATE, then the recovery: the index is used for seeks, and a fresh Database lists it.
- **Session mode with a populated table was untested** (the handoff listed it). New case: the deferred tree lands exactly once, before the catalog sync; the apply's coordinator commit does not carry it a second time; every existing row is reachable through the index, in this Database and in a fresh one.

### Tripwire (recorded, not ticketed)

- A deferred tree whose table is dropped later in the same apply still lands, as an unlisted orphan (`destroy` never deletes index trees). If that sync ever threw, it would cancel the whole catalog commit, the DROP's gravestone included. No migration plan produces CREATE INDEX followed by DROP TABLE on one table today. Parked as a `NOTE:` at the flush loop in `endSchemaBatch`.

### Judgement calls from the handoff, weighed

- **Branching on `committedRevision() === undefined`.** Kept. Verified in `collection.ts`: `actionContext` is set to `undefined` only on `createOrOpen`'s invent branch, and elsewhere it is only ever raised, never lowered (line 372 refuses to lower it). So the doc carve-out is accurate. When nothing was staged, a freshly opened tree that adopted a committed revision has no unsynced changes anyway, so the check is mostly defensive. A dedicated `isInvented()` predicate would add surface area without catching any extra case.
- **The first tree failure stops that manager's remaining flushes.** Kept. Any tree failure already cancels the manager's whole catalog commit. Continuing would only land more trees that no committed record lists, and the recovery re-persists those indexes on the next touch anyway, so the simpler rule costs nothing a user would notice.
- **Growth gates now compare same-mix scales (SMALL against SMALL_X3), not SMALL against LARGE.** Sound. A table costs about two round trips and an index about one, so comparing schemas with different table-to-index mixes measures the mix, not growth. LARGE still has per-scale ceilings. Re-measured today; the numbers match the file's baselines.
- **"Loud but stuck" after a failed tree.** Kept loud over silently wrong. The fix above removes the "stuck" part: there is now a working in-process route, and the error names it.

### Checked, nothing found

- **Ordering and atomicity:** trees sync before `commitBatch` in each manager; `unlanded` is removed from only after a successful sync, so the withheld set is exact. `discardBatch` after a failed `commitBatch` is a no-op, since `commitBatch` already closed the batch.
- **Resource cleanup:** `deferred` lives on the batch object, which is cleared at the top of `endSchemaBatch`, so nothing survives the apply. No new subscriptions or listeners.
- **Type safety:** `DeferIndexFlush` is a named type; no casts were added; `markSchemaUnpersisted` defaults its new parameter, so existing callers are unchanged.
- **DRY / size:** the deferral branch is one small loop beside `flushDirtyTrees` and does not duplicate it. `optimystic-module.ts` was already large before this ticket, and this change adds a few dozen lines to it; it is not a new size concern.
- **Filed by the implementer:** `fix/create-index-on-untouched-hydrated-table` (reproduced there) and `backlog/feat-session-mode-apply-schema-tree-commits`. Both are plain-language and well scoped; nothing to add.

### Still untested (no ticket: low value, or covered by the ordering argument)

- The failure path for a table created in the same apply over storage that already holds rows.
- Several SchemaManagers with deferred trees where one fails: that needs distinct transactor configurations in one test.
- The derived-UNIQUE filter in `markSchemaUnpersisted` after a failed tree: what should happen to a duplicate insert in that state was never specified.
