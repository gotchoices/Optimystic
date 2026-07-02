----
description: After a stored item is deleted and then re-added within the same in-progress transaction, reads return the old stored version instead of the newly added one.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/struct.ts
difficulty: easy
----
`Tracker.tryGet` (around tracker.ts:14-27) consults the tracked `inserts` map only after a source miss. So if a block exists in the source, is then `delete()`d, and then re-`insert()`ed within the tracker, `tryGet` still returns the *source* block — ignoring the inserted replacement and any operations routed into it.

This contradicts the transform semantics: `struct.ts:4-5` documents that an insert wins. The delete-then-reinsert sequence should read back the inserted content, not the stale source.

Expected behavior: a block that has been inserted into the tracker takes precedence over the source, so a delete-then-reinsert reads the inserted replacement (and any ops applied to it), consistent with the documented insert-wins rule.

Suggested fix (from review, treat as a hint): check `transforms.inserts` before falling back to the source.

A reproduction should take a block present in the source, delete it and re-insert different content in the tracker, then assert `tryGet` returns the reinserted content.
