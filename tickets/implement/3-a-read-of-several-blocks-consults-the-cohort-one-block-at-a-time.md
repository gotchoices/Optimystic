description: When a node answers a read naming several blocks, it checks each block with its cohort peers one after another instead of all at once. On a slow link every table refresh (which reads two blocks together) therefore takes two full network waits where one would do.
architecture: docs/transactions.md#read-consistency-and-staleness
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CoordinatorRepo.get`: the `for (const blockId of blockGets.blockIds)` loop that awaits `fetchBlockFromCluster` per block)
  - packages/db-p2p/test/coordinator-repo-read-repair.spec.ts (existing consult-stub fixtures to copy from; a new spec is fine too)
  - docs/transactions.md (§ Read Consistency and Staleness / § Lazy read-repair window: say a multi-block read consults its blocks concurrently)
repro: verified
----
# A read of several blocks consults the cohort one block at a time

## What was observed

Measured with sereus's re-attach scenario (`packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts` in the sereus repo, `REATTACH_SYNC_MEASURE=1`, 900 ms one-way latency injected on every socket, two-machine group), on the optimystic build at `ce5a0068`, with `DEBUG=optimystic:db-p2p:coordinator-repo*,optimystic:db-p2p:sync-service*,optimystic:db-core:network-transactor*`. Traces: `tickets/.logs/catch-up-stale-kept.log` and `tickets/.logs/catch-up-stale-empty.log` (auto-pruned after 14 days).

- Every cohort consult (one `clusterLatestCallback` → sync-service request to a peer) takes 3.62–3.65 s at 900 ms one-way: four one-way delays, because opening a stream costs one round trip even on an open connection (`test/stream-open-costs-a-round-trip.spec.ts`) and the request/reply is the second.
- A two-block read took exactly two consults back to back. Example from the kept-store trace: `get blockIds=2` at 16:09:29.944; `read-repair-triggered` for `default/app/Data`, its `certified-selected` at 16:09:33.577; only then `read-repair-triggered` for the next block, its `certified-selected` at 16:09:37.217; `get:done blockIds=2 ms=7274`. The same shape recurs throughout both traces (`ms=7274`, `ms=7294`).
- The two-block read is the refresh every live query runs per tree: `Collection.readLogEnds` asks for the collection header and the log tail in one request (docs/internals.md § Quereus vtab read path). So on a slow link each tree's refresh costs two consults instead of one whenever the read-repair window has expired for both blocks, which on a link this slow is almost every poll (a poll cycle outlasts the 10 s window).

## Cause

`CoordinatorRepo.get` walks `blockGets.blockIds` with `for … of` and `await`s `this.fetchBlockFromCluster(...)` and the follow-up `storageRepo.get` inside the loop body, so block N+1's consult starts only after block N's has finished. Nothing in the per-block work depends on another block: the freshness stamps, the unsettled-claim memo (`recordAheadClaim` / `flagUnconfirmedCurrency`), the absence flags and the results entry are all keyed by block id, and acquisition (`restoreCorroborated` → `saveReplicatedBlock`) takes a per-block latch.

## Expected behaviour

A read naming N blocks that each need a consult finishes in about one consult's time, not N. Everything else about each block's answer is unchanged: the same triggers (missing, window, floor), the same verdicts, flags and log lines, the same refreshed local re-read per block.

## Notes for the implementer

- Split the loop body into a per-block method (it is already long) and run the blocks with `Promise.all` over that method. Keep the per-block `try/catch` inside the method so one block's thrown consult still flags only that block; the method should never reject.
- Deduplicate `blockGets.blockIds` before fanning out, so a request that names one block twice cannot run two consults of it concurrently against the same memo entries.
- The responsibility pre-check at the top of `get` is a cheap cached local lookup; leave it serial or fold it in, either is fine.
- Concurrent consults to the same peer open one stream each; that is what the serial loop already did, only later. Batching several blocks into one sync request per peer would save streams but not latency once the consults run concurrently; it is out of scope.
- `NetworkTransactor.get`'s per-batch retry note on `BlockGets.floors` (`packages/db-core/src/network/struct.ts`) is unaffected.

## Test

One reproduction test at the `CoordinatorRepo` layer: a two-block `get` where both blocks need a consult, with a `clusterLatestCallback` stub that holds each call open until the other block's call has also arrived (resolve a shared promise when both block ids have been seen; give the wait a generous fallback timer so the serial code fails the assertion rather than hanging). Assert both calls were in flight at once. No timing assertions.

## What the fix stage established about the original report

This ticket and `a-coordinator-asks-the-reader-what-the-reader-already-holds` came out of the fix ticket "catch-up from a stale replica is slower than from empty" (sereus re-attach report for optimystic #22). Its other findings, recorded here so nobody re-derives them:

- **The partial-versus-empty gap does not reproduce on `ce5a0068`.** After the two prerequisite fixes landed (`a-peer-that-joins-soon-after-a-check-never-gets-a-copy`, `a-restarted-node-forgets-which-peers-serve-its-network`), one run of each arm: from the kept (partial) store, A's new row was readable on B at 39.0 s; from the empty store, B was only writable at 57.0 s (its row time was lost: the host slept mid-run and the test timed out). The report had 140–162 s versus 57–90 s. One run per arm is not a distribution, so this says the gap is no longer large, not that it is gone.
- **The ~18 s steps are not a timer.** Every consult costs a fixed four one-way delays (3.62–3.65 s at 900 ms), and the reads that make up a catch-up run strictly one after another, so completion times fall on a lattice of about 3.63 s. The report's repeated values fit it: 56.9, 74.9 and 78.6 s sit 5, 10 and 11 consults after 38.7 s (18.2, 36.2 and 39.9 s). An ~18 s step is five consults, about one more pass of a table's refresh; none of `readRepairWindowMs`, the `RebalanceMonitor` intervals, `reconcilePassTimeoutMs` or `cohortQueryTimeoutMs` is involved.
- **"Should the coordinator skip consulting the reader?"** Yes, when the reader states what it holds and the coordinator's own copy is at least that current. That is the sibling ticket.

## TODO

- Extract the per-block body of the consult loop in `CoordinatorRepo.get` into its own method; run the deduplicated block ids concurrently.
- Add the reproduction test described above; confirm it fails on the serial loop and passes after.
- Update docs/transactions.md (read-repair section) to state that a multi-block read consults its blocks concurrently.
- Run `yarn workspace @optimystic/db-p2p test` (build db-core/db-p2p first if the freshness guard asks).
