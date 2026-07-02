----
description: A batch of small code-cleanliness and correctness-adjacent fixes across the core database library, with no single behavioral theme.
files: packages/db-core/src/utility/pending.ts, packages/db-core/src/btree/btree.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/log/log.ts, packages/db-core/src/collection/collection.ts
difficulty: easy
----
A collection of minor polish items from the review, grouped into one small ticket. Handle them together; each is low-risk.

- `utility/pending.ts:7-9` — `isResponse` tests `response !== undefined`, so a `Promise<void>` (whose resolved value is `undefined`) never reads as complete, which affects `incompleteBatches`. Track settlement with an explicit flag rather than inferring it from the value.
- `btree.ts:186` — awaits a callback that is synchronous.
- `btree.ts:514` vs `btree.ts:594` — inconsistently await a void `insert`; make the two paths consistent.
- `btree.ts:656`, `:666`, `:712` — non-null assertions on values that are legitimately undefined at those edges; handle the undefined case instead of asserting.
- `tracker.ts:70-72` — double-wraps an already-deduped `Set`; drop the redundant wrap.
- `log/log.ts:164-183` — per-entry `unshift` is O(n squared) over the unsynced tail; push then reverse once instead.
- `collection.ts:301` — reverses an array in place where `toReversed()` would be clearer and non-mutating.

Expected behavior: same observable behavior as today (plus the `isResponse` correctness fix so void-returning batches report complete), with the cleaner/faster implementations. No functional regressions.
