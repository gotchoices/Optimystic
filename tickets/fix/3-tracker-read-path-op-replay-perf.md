----
description: Reading a block repeatedly gets slower and slower over a long session because each read re-copies the block and replays its entire history of changes from scratch.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/cache-source.ts
difficulty: medium
----
Every tracked read (`Tracker.tryGet`, around tracker.ts:16-18, via `cache-source.ts:33`) deep-clones the block with `structuredClone` and then re-applies *all* operations ever recorded for that block, with each operation cloned again inside `applyOperation`.

Hot blocks that are updated once per operation — the collection header, the log tail — accumulate an unbounded operation list in a long-lived tracker. Each read is therefore O(number of ops), a whole session is O(ops squared), and this cost is further multiplied by tree depth on every descent. The read path degrades continuously as a session runs.

Expected behavior: repeated reads of a frequently updated block stay roughly constant-time rather than growing with the accumulated operation count, without changing the observable read result.

The review offers two candidate approaches (treat as hints; the fix stage should pick and justify one): compact per-block ops on write by materializing the block into a shadow updated-block cache once the op list passes a threshold; or memoize the transformed block per id and invalidate the memo when new ops arrive.

A benchmark/regression should apply many operations to one block and confirm read cost does not scale with the op count.
