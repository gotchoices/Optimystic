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

## Promoted 2026-10-19: GitHub #43

GitHub [#43](https://github.com/gotchoices/Optimystic/issues/43) is the re-measure asked for above, from the idle side rather than the read-latency side: with a second cohort member, nearly every read of a held block past `readRepairWindowMs` becomes a background `sync` request, about 0.9 per `NetworkTransactor.get`. sereus's `message-cost-accounting` scenario (2026-10-19, `f22a8cb7`) counted 103–134 `sync` requests a minute between two idle machines of one party, and gotchoices/sereus#50's comment ~8 inbound requests a minute per strand on a Galaxy S7. The request count is now the cost that matters, on phones in particular. sereus is cutting its own idle reads (change-driven pollers), but app reads keep paying it.

#43 adds two arms on the same consult path; plan them with this one, splitting into separate implement tickets if they land separately:

1. **Per peer, not per block** (this ticket's original subject).
2. **A revision-only consult.** Ask for (revision, action id, proof) and fetch bytes only when the peer is ahead. Today the answer is the full archive, with the block serialized twice (`block-archive.ts`: in `action.transform.insert` and in `block`), and most background consults on a quiet cohort answer "current".
3. **Freshness from received commits.** `lastSeenCommitMs` is set only inside `CoordinatorRepo` (own coordinated commits, consult exits). A commit this node took part in as a cohort member, or a certified pushed block, leaves the block stale, so the next read of every block the other member wrote is a consult. Stamping on those writes is also where `debt-freshness-state-scattered-across-coordinator-repo` bites; read it first, and keep the absence-memo lesson in the comment above `readRepairBlock` (a memo must be cleared by every writer of local storage).

## Interaction with `a-cold-read-reuses-the-consults-archives` (2026-10-19)

That implement ticket (GitHub #39) lets a read-repair acquisition restore from the archive the consult already received instead of asking each peer again. A revision-only consult (arm 2 above) must keep that working: when the peer is ahead of what the asker holds — the only case in which an acquisition follows — return the archive with the claim. A consult answer without bytes still works, since the acquisition then fetches as before, but a cold read goes back to two requests per peer.
