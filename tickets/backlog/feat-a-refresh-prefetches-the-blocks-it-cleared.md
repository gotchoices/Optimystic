description: After another writer's change is noticed, a retrying write re-reads the changed blocks one at a time, each a full network round trip, which makes a slow client's retry window long enough to lose to any fast rival. Fetching the changed blocks in one request would shorten that window.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-core/src/collection/collection.ts (`updateInternal`: the walk that clears each entry's blocks from the read cache, and `replayActions` which then re-reads them one at a time through the tree descent)
  - packages/db-core/src/transactor/transactor-source.ts (`tryGet` is single-block; a batched read would need a sibling that admits several answers through the same floor and cache rules)
  - packages/db-core/test/refresh-read-cost.spec.ts (the request budgets a refresh is held to)
difficulty: medium
tradeoffs: It is an optimisation of a window that the slot hold already bounds, so a maintainer may defer it until a workload shows the hold's throughput cost mattering; and a prefetch can fetch blocks the replay never touches, which costs bandwidth on every contended retry.
----

# A refresh prefetches the blocks it cleared

## What was measured

In the plan-stage measurement for `slot-hold-for-an-aged-writer` (three-node mesh, one fast writer every 200 ms, one slow writer whose every repo call is delayed 120 ms), the slow writer made about four `get` calls per attempt, each a sequential round trip: the header-and-tail read, the log walk, and the re-reads the replay of its staged action needs for the blocks the walked entries named. Its read-to-pend window was 0.6 to 0.8 s against a rival commit interval of about 0.25 s, so nine out of ten of its pends were refused as stale. With a 40 ms delay the window dropped to about the rival's interval and every slow write landed.

## The idea

`updateInternal` already knows, from the walked entries, exactly which blocks it dropped from the cache. The replay then re-reads them through the tree's descent, root to leaf, one request each. Issuing one batched read for the cleared blocks before the replay turns those sequential round trips into one. Reads already travel batched below `TransactorSource` (`ITransactor.get` takes a list, and `NetworkTransactor` batches per coordinator), so the work is a batched entry point above the cache that applies the same floor, below-floor and overtaken-while-in-flight rules `CacheSource.tryGet` applies per block.

## Expected behaviour

A contended retry costs at most two sequential read round trips before its pend (the tail, then one batch), regardless of tree depth. The refresh-cost spec gains a budget for the contended case. Correctness rules are unchanged: a prefetched answer is cached only if a single read of it would have been.

## Rejected neighbour

Having the stale refusal itself carry the new tail block (saving the refresh's first round trip) was considered and set aside: the member's reject reason is signed prose, so carrying a block means a new field on the coordinator's `StaleFailure` and a second copy of the tail-read logic on the client, for one round trip.
