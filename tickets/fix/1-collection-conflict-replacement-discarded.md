----
description: A collection's conflict-resolution hook can return a rewritten action to apply instead of the original, but that replacement is silently dropped and never takes effect.
files: packages/db-core/src/collection/collection.ts
difficulty: medium
----
`doFilterConflict` (around collection.ts:327-338) queues a replacement action by pushing it onto `this.pending`. But it is invoked from inside `this.pending.map(...)` (around collection.ts:133-134), and the result of that `map` is then assigned back to `this.pending`. The push lands on the *old* array, beyond the fixed range `map` iterates, and is discarded the moment the mapped result overwrites `this.pending`.

The effect: any collection that relies on `filterConflict` to return a rewritten action to apply loses that action entirely. This is the documented conflict-merge extension point, so the loss is silent and semantically significant — the merge the caller asked for simply does not happen.

Expected behavior: when the conflict filter yields a replacement action, that replacement ends up in the collection's pending set and is applied.

Suggested fix (from review, treat as a hint): have the filter return a `{ keep, replacement }` result, collect replacements into a local array during the map, and append them to the new `this.pending` after the map completes.

A reproduction should register a `filterConflict` that rewrites an action, drive a conflict, and assert the rewritten action is present in pending afterward.
