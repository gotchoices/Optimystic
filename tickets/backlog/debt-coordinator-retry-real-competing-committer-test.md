description: The automatic commit-retry has no test where a real rival transaction actually commits a competing change mid-retry — only a fake one that refuses without committing — so the "re-read, rebase, then win" path is unproven end-to-end.
prereq:
files:
  - packages/db-core/test/transaction.spec.ts (describe "Coordinator commit backoff+jitter retry")
  - packages/db-core/src/transaction/coordinator.ts (commit() retry loop + re-read via collection.update())
  - packages/db-core/src/testing/test-transactor.ts (FlakyCommitTransactor — the current stand-in)
difficulty: medium
----

## Background

The multi-collection commit path (`TransactionCoordinator.commit`) now retries a clean
optimistic-concurrency loss automatically: it backs off (jittered), re-reads every collection to
fresh revisions via `collection.update()`, then re-drives the commit. See the shipped work in
`implement-occ-default-backoff` (commit `d1d44e7`).

The retry tests added in that ticket exercise the retry *control flow* — that it backs off, is
bounded by `maxAttempts` / `deadlineMs`, honours an abort signal, and does not re-drive a partial
landing. But every one of them fails the losing attempt with `FlakyCommitTransactor`, which returns a
`{success:false}` stale failure **without actually advancing any collection's log tail**. So the
transactor simply "stops refusing" after N calls, and the retry succeeds because the obstacle
vanished — not because the loser re-read a genuinely newer revision, rebased its staged actions onto
it, and then won.

## What's missing

A stronger integration test in which a **real competing transaction durably commits a conflicting
revision between the loser's attempts**, and the test then asserts the loser:

1. observes the newer committed revision after its inter-attempt `collection.update()`,
2. rebases (replays) its staged actions against that revision (via each collection's `filterConflict`
   / replay path), and
3. commits successfully on a later attempt, with the final durable state reflecting **both** the
   rival's committed change and the loser's rebased change (no lost update, no duplicate log entry).

This is the property that makes the coordinator's built-in retry meaningfully different from a bare
"try again and hope"; it is currently unproven for the multi-collection path. The single-collection
`Collection.sync` retry has closer coverage, but the coordinator's re-read-all-then-re-pend loop does
not.

## Shape of the fix

Add a transactor (or wrap `TestTransactor`) that, on a chosen attempt number, injects a competing
committed action into a participating collection's log before returning the loser's stale failure —
so the loser's next `update()` actually pulls a newer tail. Then drive `coordinator.commit()` and
assert the merged durable outcome. Consider both a non-overlapping change (clean rebase) and an
overlapping-key change (exercises `filterConflict`).

Coverage-only; no production change expected unless the test surfaces a rebase defect.
