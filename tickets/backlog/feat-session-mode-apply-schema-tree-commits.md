description: In session (distributed-transaction) mode, applying a schema still costs one storage commit for every new table and index, even when all of them are empty. The one-commit schema apply only holds on the simpler, non-session commit path.
files:
  - packages/db-core/src/transaction/coordinator.ts (which registered collections a session commit carries, and how each becomes its own transactor commit)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (session-mode commit; the collection registry the coordinator reads)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (reconcileMaintainedIndexes / registerCollections register invented trees with the bridge; backfillIndexTrees leaves an empty index tree unwritten)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (the session-mode case pins today's 1 + T + I)
tradeoffs: The extra commits only write each new table's or index's empty header once, and changing which collections a session commit carries touches the distributed commit path that every session-mode write goes through.
----

# Session-mode `apply schema` commits every new empty tree

## What happens today

On the legacy commit path (no `TransactionCoordinator`), a cold `apply schema` of `T` empty tables and `I` indexes costs **one** transactor commit: the plugin's catalog batch commits the catalog once, and every new table and index tree is left invented and unwritten until its first real write (`schema-batch.spec.ts`, `cold-apply-cost.spec.ts` gate 2).

In session mode it costs **`1 + T + I`**. Measured in `schema-batch.spec.ts` ("session mode: a cold apply …"): 2 tables + 1 index produce 4 transactor commits, in this order: the catalog (`optimystic/schema`), then `default/t0`, `default/t1`, `default/t0/index/t0_by_name`. The whole apply runs as one coordinator transaction. When it commits, after `endSchemaBatch`'s catalog commit, the coordinator carries every collection registered with the bridge that has staged state. Each invented tree's uncommitted header and root count as staged state, and each collection becomes its own transactor commit.

The count was the same before the index-tree deferral (`schema-batch-index-tree-flush-deferral`). Back then the index tree was flushed inside `addIndex`, and the table trees rode the coordinator's commit as they do now.

## Expected

A session-mode cold apply over empty tables should cost what the legacy path costs, one commit, or at least not one extra commit per object. An invented, never-written tree is already a valid state: any later open invents the same empty tree, and its first real write carries the header.

## Open questions for planning

- Can the session commit skip a collection whose only staged state is an invented, empty tree? Nothing can tell that state apart from real staged data today, short of `committedRevision() === undefined` plus "no staged entries", which the adapter does not track per collection.
- Alternatively, carrying those collections together in one transactor commit overlaps `feat-cross-collection-atomic-commit`.
- Rollback: whatever skips these trees must leave them registered, so a rolled-back later transaction still restores them correctly.
