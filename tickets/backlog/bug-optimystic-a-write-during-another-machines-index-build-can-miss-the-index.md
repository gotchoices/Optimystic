description: When one machine creates an index on a shared table while another machine is writing rows to it, a row the second machine writes during the build can end up missing from the index, so queries that use the index skip it. Nothing reports an error.
prereq: bug-optimystic-a-machine-keeps-acting-on-a-table-description-another-machine-replaced
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`addIndex`, `backfillIndexTrees`, `reconcileMaintainedIndexes`), packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/db-core/src/collections/tree/struct.ts (`TreeEntryGuard`)
repro: static
severity: corruption
likelihood: unusual
tradeoffs: It needs a schema change and a write on two machines at once on one table, and closing it means either an index that is written before it may be read (a building state readers skip) or a description version that every write asserts inside the table's own collection, each a real addition to the storage format and the write path.
----

## The gap

`CREATE INDEX` on machine A reads the table's rows, writes an entry per row into the new index tree, and only then writes the catalog record listing the index (`OptimysticVirtualTable.addIndex`). Machine B learns of the index only from the record: after `bug-optimystic-a-machine-keeps-acting-on-a-table-description-another-machine-replaced`, B's commit compares B's description with a fresh read of the record and refuses if they differ.

A row B commits while A is building passes that check (the record does not list the index yet), so B writes no entry for it. If A's read of the rows has already passed that row's key, A writes none either. The row is then missing from the index on every machine, permanently; `plugin.verifyIndexes` reports it as missing, and every index-driven read skips it.

The same window exists for any description change, but for a CHECK, a NOT NULL or an added column it is only the duration of one commit in flight; for an index it is the whole build.

Inferred from the code, not reproduced: the in-process two-session harness runs A's build to completion inside one statement, so reproducing it needs B's commit scheduled between A's row read and A's record write (a stalled transactor of the kind `test/committed-read-stall.spec.ts` uses would do).

## Expected

A row committed by any machine while an index is being built is in the index once the build completes.

## Directions considered

- **Describe the index before building it.** A writes the record first, with the index marked as building: every machine maintains a building index on its writes (after the commit check refreshes it) but no machine reads through one. A then fills it from the rows, and marks it ready. A row whose writer checked before the record landed can still commit after A's read of the rows passed it, so this narrows the window to one commit in flight; it does not close it.
- **A description version inside the table's own collection.** The record carries a version, the table's main tree holds it at a reserved key, every write asserts it (an element that checks without writing, which the tree's guards do not offer yet), and a schema change bumps it before building. A write and the bump are then ordered by the main collection's own revision, so a write planned under the old version that commits after the bump is refused at replay, and the build reads the rows after the bump. This closes the window, at the cost of a reserved key every scan must skip and a new guard kind in db-core.

## Found while landing the commit-time description check

- **Reproduced.** `commitPastIndexBuild` in `packages/quereus-plugin-optimystic/test/commit-gate.ts` parks one machine's commit after its description check and before its pend, runs the other machine's `CREATE INDEX` to completion, then releases the commit: the row lands with no entry in the new index. `test/index-backfill-cost.spec.ts` ("rows committed while detached…") and `test/index-maintenance-invariant.spec.ts` ("re-attaching to an index backfills…") use it to get their detached row, and assert the entry is missing before the re-attach backfill restores it. So the gap is `repro: verified` in the two-session harness.
- **The order is not build-then-record outside `apply schema`.** `OptimysticVirtualTable.addIndex`'s build path writes the record (`storeStoredSchema`) before `backfillIndexTrees` reads the rows. There the window is the writer's commit in flight across the record write and the build's read, which is what the helper drives. Inside `apply schema` the record lands only at `endSchemaBatch`, after the deferred tree flushes, so there the window is the whole build, as the body above says.
