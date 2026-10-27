description: Make the offline "will this change go through?" prediction recognize generated ids and report the decisions a queued change made against other rows, using a description of each write that Quereus will provide.
prereq: offline-sync-outlook-from-guards
architecture: docs/offline-sync.md#what-the-analysis-needs-from-quereus
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, docs/offline-sync.md
difficulty: hard
tradeoffs: The guard-only prediction plus the `optimystic.fresh` tag already covers applications that generate ids themselves, so it may never be worth the complexity for current users.
----

Stage 9 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages).

**Quereus API (shipped in 4.21.0; our ranges already require it):** `Statement.getWriteScope()` and the per-statement module hook `UpdateArgs.writeScope` (`@quereus/quereus/src/planner/analysis/write-scope.ts`), described in the sibling repository's `docs/write-scope.md`. Read that doc before designing; where it differs from what [docs/offline-sync.md §What the analysis needs from Quereus](../../docs/offline-sync.md#what-the-analysis-needs-from-quereus) assumed, update the design doc to match what shipped.

## What is wanted

Over stage 7's guard-only outlook, using the write description handed to the virtual table for the executing statement:

- **Fresh-value detection from provenance** ([§Judging each guard](../../docs/offline-sync.md#judging-each-guard)): `StampId()`, sources of at least 128 random bits, and deterministic functions of either count as fresh; `random()` does not. Register `StampId()` as a fresh source through whatever flag Quereus settles.
- **`unchecked` decisions** ([§Unchecked decisions](../../docs/offline-sync.md#unchecked-decisions)): `foreign-key`, `check`, `assertion`, `read`, `row-selection`, each with its binding-mode `scope`. Remove the "not computed" marker stage 7 used.
- **Dependencies through unchecked reads** ([§Dependencies between entries](../../docs/offline-sync.md#dependencies-between-entries)): `dependsOn` with `via: 'unchecked'`, matching a read's scope against an earlier entry's written keys or tables.

Test-plan cases from the doc: inserts under `StampId()` and `random_bytes(16)` assured; a message under a fresh key referencing a conversation created by an earlier entry under a natural key — the message assured with `dependsOn` naming the conversation's entry `via: 'unchecked'`.
