description: Let a queued offline change that another machine already made identically — both marking the same task done, both deleting the same row — count as committed instead of failing.
prereq: offline-sync-outlook-from-guards, offline-sync-outlook-from-write-description
architecture: docs/offline-sync.md#guards-that-make-idempotent-writes-assured
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, docs/offline-sync.md, docs/internals.md
difficulty: hard
tradeoffs: Adds three guard kinds whose soundness rests on facts from Quereus's write scope, to rescue a class of conflicts (identical concurrent edits) that applications may rarely hit.
----

Stage 10 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages).

**Quereus API (shipped in 4.21.0; our ranges already require it):** `Statement.getWriteScope()` and the per-statement module hook `UpdateArgs.writeScope` (`@quereus/quereus/src/planner/analysis/write-scope.ts`), described in the sibling repository's `docs/write-scope.md`. Read that doc before designing; where it differs from what [docs/offline-sync.md §What the analysis needs from Quereus](../../docs/offline-sync.md#what-the-analysis-needs-from-quereus) assumed, update the design doc to match what shipped.

## What is wanted

Three guard variants beside the four in `TreeEntryGuard`, per the table in [§Guards that make idempotent writes assured](../../docs/offline-sync.md#guards-that-make-idempotent-writes-assured): DELETE by key accepts an already-absent row; UPDATE `unchanged` accepts a row equal to the entry's post-image when every written value is self-independent; INSERT `absent` accepts an equal existing row under `or ignore` / `on conflict do nothing` / `or replace`, or a content-derived key. A plain `insert` of an equal row still refuses. An accepted entry is reported `committed` with `effect: 'already-applied'`, and the outlook counts these guards as not refusable by a rival making the same change.

Test-plan cases: two machines mark the same task done offline, and two delete the same row — both commit, the second `already-applied`; two increment the same counter — the second still fails `concurrent-modification`.
