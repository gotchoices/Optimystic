description: Every 20–30 seconds, each machine re-checks every watched table over the network even when nothing has changed, so an idle phone watching 18 tables sends about 54 network requests a minute. Make the periodic safety check cost little or nothing when the table is idle.
files: packages/db-p2p/src/reactivity/collection-watch.ts (`armTick`, `tick`, `checkTail`), packages/db-core/src/collection/collection.ts (`readCommittedTail`, `readLogEnds`), packages/db-p2p/src/repo/coordinator-repo.ts (`runHeldBlockConsult`)
----
# The reactivity backstop check costs nothing while idle

GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48) (kjeib). Read the issue in full (`gh issue view 48`).

`ReactivityCollectionWatch` reads each watched collection's tail on every tick (30 s core, 20 s edge). On a two-member strand where the other member holds the block, that local read starts a held-block consult over the network: one `sync` request per watched collection per tick, about 360 ms each at 44 ms one-way latency. Each collection has its own timer, so the ticks fire within a few ms of each other but go out separately, and per-member consult batching never sees them together. The `armTick` comment anticipated this and named remedies.

## Expected

- An idle node watching N collections does not send N network requests per tick. Options from the issue (the planner chooses; combinations are fine): skip a collection's tail read on a tick since which a notification or local apply reached it; read the tick's tail locally without the held-block consult; run one timer for all watched collections and batch their reads into one consult per member. The tick is the backstop that catches a lost notification, so whatever replaces the remote check (for example a longer interval for it) must keep that.
- Renewal cadence (TTL / 3) is unchanged.
- The backstop still recovers from a lost notification within a stated bound. Update docs/internals.md and docs/reactivity.md for the new cost and bound.

## Test

A spec over the watch service counting tail reads and consult requests across idle ticks, and one showing that a commit whose notification was dropped is still picked up within the stated bound.
