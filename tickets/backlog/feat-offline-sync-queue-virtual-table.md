description: Offer a read-only SQL table listing the offline queue's pending transactions, for applications that prefer to inspect state through SQL.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#queries-and-actions
files: packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/README.md
difficulty: easy
tradeoffs: Pure convenience over `plugin.offline.entries()`, which every application can already call.
----

From stage 11 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), if stage 4 did not include it. A read-only virtual table `optimystic_queue` with columns `transaction_id`, `seq`, `status`, `tables`, `queued_at`, `attempts`, `last_error`, reading the same state as `plugin.offline.entries()` ([§Queries and actions](../../docs/offline-sync.md#queries-and-actions)). Not a separate source of truth.
