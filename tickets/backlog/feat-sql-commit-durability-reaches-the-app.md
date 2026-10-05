description: An application writing through SQL cannot tell whether its commit is held only by its own machine or by the group, nor learn when a lone-written commit later reaches the others; the durability is computed below the plugin and dropped.
prereq: feat-multi-collection-commit-reports-durability
files:
  - packages/db-core/src/transaction/coordinator.ts (`TransactionCoordinator.commit` drops `commitResult.durability`)
  - packages/db-core/src/transaction/session.ts (`TransactionSession.commit`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`TransactionBridge.commitTransaction`, where the plugin would keep or emit it)
  - packages/db-core/src/transactor/change-notifier.ts, packages/db-p2p/src/storage/storage-repo.ts (`emitBlockDurabilityReached`, the full-replication event the under-replication drain already fires)
  - packages/db-core/src/network/durability.ts (`WriteDurability`, `isFullyDurable`)
difficulty: medium

# A SQL commit's durability reaches the app

GitHub issue #26: https://github.com/gotchoices/Optimystic/issues/26. Use case: a chat app marks a message
"not yet delivered" while `quorum` is `local` and clears the mark once the write is fully durable.

## Gaps (from the issue)

1. `coordinator.commit()` returns nothing; per-collection durability is discarded. Owned by the prereq. Its
   tradeoffs line ("the single-collection path covers every write a row-level application makes") does not hold
   for SQL: every SQL write goes through the coordinator, so even a one-collection insert loses it. A first cut
   covering single-collection transactions would serve the reporter.
2. `db.exec` returns void, so the plugin must keep the last commit's durability per database or session, or emit it
   per commit (cadre-core would pass it through on `StrandDatabase`).
3. Learning the change: a query for a committed revision's current durability, or an event when a `local` write
   becomes `full`. The block-level full-replication event
   (`6.43-under-replication-drain-and-full-replication-event`) exists; it needs mapping back to the commit the app
   knows.

Measured by the reporter: with the other member offline, inserts commit in 5–12 ms (presumably `local`); when it
returns, cadre-core's `PeerJoinBackfill` delivers every row within ~8 s, and nothing records that against the
earlier commits.
