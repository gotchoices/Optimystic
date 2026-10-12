description: When a machine checks several blocks with the other members of their group, it sends one request per block to each member, so a read touching five blocks makes five sequential requests over a slow relay. Ask each member about all the blocks in one request instead.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/client.ts
tradeoffs: Since reads of blocks this machine already holds no longer wait on the consult, and the stream-reuse ticket removes the extra round trip per request, what remains may be too small to justify a new sync request shape that both builds must understand.
----

# A cohort consult batches its blocks per peer

GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29), question 3. Split out of plan ticket `feat-fewer-relay-round-trips-per-write-and-read`.

## The behaviour today

A coordinator reconciles each block of a read with its cohort separately: `CoordinatorRepo.get` runs one `readRepairBlock` per block, concurrently, and each consult calls `clusterLatestCallback` (`packages/db-p2p/src/libp2p-node-base.ts`) once per (peer, block) — a `SyncClient.requestBlock` carrying a single `blockId` (`SyncRequest` in `packages/db-p2p/src/sync/protocol.ts`). The acquisition fetch (`fetchArchiveFromPeer`) is the same shape. `docs/transactions.md` already notes per-peer batching is not done.

Reported on 1.10.1: a read of a few rows made five sequential `sync` requests (~0.6 s each between phones); an 8-row chat refresh took 3.3 s.

## What has changed since

- Implement ticket `a-read-does-not-wait-on-a-connected-but-silent-member` (complete) moved the window consult for a block the reader already holds off the read path: served at once, consulted behind it. So for held blocks only the request *count* remains, not the latency.
- Implement ticket `a-request-reuses-a-pre-negotiated-stream` removes the negotiation round trip from every request after the first in a spell, which halves each remaining consult.

The consults that still block a read are: a block this machine does not hold, a held block whose read carries a floor above it, and every consult under `readRepairMode: 'paranoid'`. The "five sequential requests" shape is mostly a sequence of reads (header and tail, then the walk), each blocking on its own consult, so batching within one `get` helps only the blocks one read names together.

## What it would take

A sync request that names several block ids and returns one answer per block (a new field or a new protocol version, with an older peer answering only the single-block form), a per-peer grouping step in front of the per-block passes in `CoordinatorRepo.get` that still lets one block's failure or silence flag only that block (the three-way contract of `ClusterLatestCallback`: claim, "holds nothing", silence), and the per-peer deadline (`cohortQueryTimeoutMs`) applied to the batch.

Re-measure with the reporter's `classic-level-driver.mjs` after the stream-reuse ticket lands before promoting this.
