----
description: If the storage backend keeps rejecting a save, the collection's synchronization routine retries forever without limit, freezing all other reads and writes on that collection.
files: packages/db-core/src/collection/collection.ts
difficulty: medium
----
`syncInternal`'s retry loop (around collection.ts:245-281) has no attempt cap, no growing backoff (it uses a fixed 100 ms delay, and only when `staleFailure.pending`), and no abort signal. A transactor that persistently rejects a sync turns `sync()` into a hot infinite loop that holds the collection latch and starves every `act()` / `update()` caller on that collection.

Expected behavior: sync retries a bounded number of times (or until a deadline), backs off between attempts, honors an abort signal if one is provided, and surfaces a clear typed error when the budget is exhausted rather than spinning forever while holding the latch.

Suggested fix (from review, treat as a hint): a bounded retry budget (count or deadline) with exponential backoff, and a typed error thrown when exhausted.

A reproduction should point the collection at a transactor stub that always reports a stale failure and assert that `sync()` terminates with an error within a bounded number of attempts instead of looping indefinitely.
