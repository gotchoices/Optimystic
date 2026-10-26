description: Let a queued offline change that another machine already made identically — both marking the same task done, both deleting the same row — count as committed instead of failing.
prereq: offline-sync-outlook-from-guards
architecture: docs/offline-sync.md#guards-that-make-idempotent-writes-assured
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, docs/offline-sync.md, docs/internals.md
difficulty: hard
tradeoffs: Adds three guard kinds whose soundness rests on facts from a Quereus API that does not exist yet, to rescue a class of conflicts (identical concurrent edits) that applications may rarely hit.
----

Stage 10 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages).

**Waits on Quereus:** needs the self-independence and conflict-disposition facts from the Quereus ticket `statement-write-scope` (sibling `quereus` repository).

## What is wanted

Three guard variants beside the four in `TreeEntryGuard`, per the table in [§Guards that make idempotent writes assured](../../docs/offline-sync.md#guards-that-make-idempotent-writes-assured): DELETE by key accepts an already-absent row; UPDATE `unchanged` accepts a row equal to the entry's post-image when every written value is self-independent; INSERT `absent` accepts an equal existing row under `or ignore` / `on conflict do nothing` / `or replace`, or a content-derived key. A plain `insert` of an equal row still refuses. An accepted entry is reported `committed` with `effect: 'already-applied'`, and the outlook counts these guards as not refusable by a rival making the same change.

Test-plan cases: two machines mark the same task done offline, and two delete the same row — both commit, the second `already-applied`; two increment the same counter — the second still fails `concurrent-modification`.
