description: Allow offline mode together with session mode, by re-running each queued transaction's SQL statements when it is sent, so every constraint and read is judged against the latest data.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#session-mode
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/db-core/src/transaction/session.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, docs/offline-sync.md
difficulty: hard
tradeoffs: Needs its own design for three hard points (what view re-execution runs against while later entries share the collections, a network effect that differs from the local one, and two transaction ids per entry), and offline mode already works without session mode.
----

From stage 11 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). [§Session mode](../../docs/offline-sync.md#session-mode) states why a queued session transaction must be re-executed at drain and the three problems that design has to settle before offline mode can stop refusing to enter under session mode. Journaled session entries must record the statements and inherit [transactions.md §Secrets and the replicated statement record](../../docs/transactions.md#secrets-and-the-replicated-statement-record).
