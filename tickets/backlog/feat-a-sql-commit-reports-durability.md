description: An application writing through SQL has no way to learn whether its committed transaction is held by the whole group of machines or only by its own, even though the layer underneath now reports exactly that; this decides how SQL hands that answer back.
prereq: multi-collection-commit-reports-durability
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`TransactionBridge.commitTransaction`, `commitBatchLegacy`, `sweepDirtyTreesLegacy`, `DirtyTree.sync`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (where a host reaches the bridge)
  - packages/db-core/src/transaction/durability.ts (`TransactionDurability`, from the prereq)
tradeoffs: Quereus gives a virtual table's commit hook no return channel to the SQL caller, so any surface here is a plugin-specific side door (a property, a callback, an event) that a host must know to look for, and a maintainer could reasonably wait until a host application asks for one.
----

# What is missing

After `multi-collection-commit-reports-durability`, every db-core write path reports who holds what it wrote: `Collection.sync` returns a `WriteDurability`, and `TransactionCoordinator.commit` / `TransactionSession.commit` return a `TransactionDurability` (per collection, plus one overall class).

The Quereus plugin's transaction bridge (`TransactionBridge.commitTransaction` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`) discards all of it, on all three of its commit routes:

- session mode: `this.session.commit()`'s `ExecutionResult.durability`;
- the batched legacy commit: `coordinator.commit(...)`'s return in `commitBatchLegacy`;
- the per-tree fallback sweep: each `tree.sync()`'s `WriteDurability` in `sweepDirtyTreesLegacy`.

So an application that writes through SQL — the plugin's main use — still cannot show a committed row as pending rather than saved, which is the reason durability reporting exists.

# What a host needs

After a SQL `commit` (explicit, or an autocommitted statement), a way to read the durability of the transaction that just committed: one overall class it can test with `isFullyDurable`, and per collection (table and index trees) for a host that wants detail. Collection ids are internal; a host thinks in tables, so a per-table view may be worth more than per-collection.

The open design question is the channel, since Quereus's commit hook returns `void` to the SQL caller. Candidates to weigh: a "last commit's durability" property on the bridge or module that a host reads after `db.exec('commit')`; a callback registered with the plugin and called after each commit; or an event on the existing change-notification path. Each has a concurrency question (two connections committing) the choice must answer.

The per-tree sweep reports one `WriteDurability` per tree, not a `TransactionDurability`; folding those through `recordCollectionDurability` / `transactionDurability` gives the same shape as the other two routes.
