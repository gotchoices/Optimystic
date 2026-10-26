description: Let a SQL application switch a database into offline mode, where a commit returns as soon as the transaction is queued on this machine and the application is told later whether it reached the network, while reads keep working from this machine's own copy.
prereq: offline-sync-queue-partial-commits
architecture: docs/offline-sync.md#application-interface
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/commit-durability.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/durability-follower.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md
difficulty: hard
----

Stage 4 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). In-memory queue only; persistence is stage 5.

## What is wanted

The application interface in [§Application interface](../../docs/offline-sync.md#application-interface), over the stage-3 queue:

- `register(db, { offline: { expireAfterMs, outcomeRetentionMs } })` (the `journal` option arrives with stage 5); `plugin.offline.enter()` / `exit()` / `whenDrained()`; the acknowledgement fixed at `TransactionBridge.beginTransaction`.
- `onStatus` with the full SQL-level status shapes, including `error` mapped through `mapCommitRefusal` (so `ConstraintError` / `ConcurrentModificationError`, the db-core refusal on `cause`), and `queued` delivered synchronously before `commit` resolves; `onQueueState`; `entries()`, `status()`, `discard()`, `outcomes()`, `acknowledge()`.
- The bridge's commit routes (legacy per-tree sweep and `commitBatchLegacy`) seal the open segments into an entry instead of committing, when the transaction got local acknowledgement.
- Drained commits are reported through `reportCommitDurability` under the entry's `transactionId`, so `onCommitDurability`, `DurabilityFollower` and `onCommitFullyHeld` behave as for online commits ([§Durability reports and the full-replication event](../../docs/offline-sync.md#durability-reports-and-the-full-replication-event)).
- Removal and cascades call `Database.notifyExternalChange` for each table whose visible rows changed.
- The `optimystic.offline` table tag (`'queue'` default, `'network'`), saved through the existing tag persistence ([§Per-table policy](../../docs/offline-sync.md#per-table-policy)).
- [Network acknowledgement behind a non-empty queue](../../docs/offline-sync.md#network-acknowledgement-behind-a-non-empty-queue), including the never-sent / already-sent timeout arms.
- [The DDL gate](../../docs/offline-sync.md#schema-changes): storage-shape DDL on a table with queued entries is refused with a typed error naming them.
- [The invented-collection probe](../../docs/offline-sync.md#invented-collections): before submitting an entry that writes an invented collection, `Collection.open` from the network; adopt and replay if it exists, commit the header if authoritatively absent, wait if unanswered.
- [Live reads degrade](../../docs/offline-sync.md#reads-in-offline-mode) for `'queue'` tables while offline: a refresh failing for unreachability serves the local view and sets `readsServedLocally`; skip the refresh while the reachability port says unreachable.
- Refuse `offline.enter()` while session mode is configured ([§Session mode](../../docs/offline-sync.md#session-mode)).

With the mode off and nothing queued, every commit takes exactly today's path.

## Edge cases the plan must cover

The doc's [§Test plan](../../docs/offline-sync.md#test-plan) scenarios that need no journal: offline commit, read back, reconnect, drain; a table and its index across several entries, index-driven read and full scan agreeing at every step; a rival taking the same primary key (failed `constraint`, row disappears, watcher fires, a dependent later entry fails with `causedBy`); `concurrent-modification`; rollback of an open SQL transaction while the drain commits an entry (committed exactly once); savepoint rollback while the drain removes a refused entry; a joiner queuing a write to a table the founder created meanwhile; a `'network'` table in offline mode; DDL refused then allowed; `discard` before and after send; expiry. Also: mode switch during an open transaction; `exit()` with entries queued; the single-writer bridge state ([§The single-writer bridge](../../docs/offline-sync.md#the-single-writer-bridge)) never touched by the drain.

This is the largest stage; the planner must split it into `prereq:`-chained implement tickets (for example: enter/exit + sealing + statuses + durability; tag policy + network-ack-behind-queue; DDL gate + invented-collection probe; live-read degrade).

## Done when

The plugin README documents the interface, docs/offline-sync.md marks the stage implemented with any renamed members corrected, and the scenarios pass on the in-process mesh.
