description: A member reading a block it does not hold asks the other cohort member for it twice in a row (the consult, then the acquisition re-requests the same revision), and opens a collection's blocks and index trees one sequential read at a time, so a joiner attaching a two-table strand makes about 16–25 relayed sync requests in series; reuse the consult's answer and fetch independent blocks concurrently.
architecture: docs/internals.md#read-path-block-retrieval
files: packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `fetchArchiveFromPeer` and its NOTE on the duplicate request), packages/db-p2p/src/repo/coordinator-repo.ts (`queryClusterForLatest`, `restoreCorroborated`), packages/db-p2p/src/cluster/reconcile-block.ts (`fetchAnswer`), packages/db-core/src/collection/collection.ts (collection open sequence), packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`initialize`: index and unique-enforcement trees opened one at a time)
----
# A cold read fetches each block once

GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39) (measurements, debug traces and a Node repro are there, plus a comment on an 8 s replication push stalling the attach). Filed from sereus's planning of GitHub gotchoices/sereus#50, where it is `blocked/optimystic-attach-fetches-each-block-twice`.

## What happens

1. **Consult.** `queryClusterForLatest` → `clusterLatestCallback` sends `requestBlock({ blockId, rev: undefined })` and gets the full archive back. The consult keeps only (revision, action id, proof).
2. **Acquire.** `restoreCorroborated` → `reconcileBlock` → `fetchArchiveFromPeer` sends the identical request and saves the answer. The NOTE at `fetchArchiveFromPeer` already says so: "a read that goes on to repair pays two identical round trips per peer rather than one … carry the consult's archive through to the acquisition instead".
3. Opening a collection is a chain of awaits (header probe, log tail, chain open re-reading the header, tail, `update()`), and `IndexManager.initialize` opens index and unique trees one after another.

## Measured

- #39: 16 sequential `sync` requests for a two-table strand's attach, 8 distinct blocks each fetched exactly twice; ~1.6 s of a ~2.4 s attach on relay.sereus.org. Phones: a two-table join 7–12 s on a Galaxy S21, 18–25 s on a Galaxy S7.
- sereus `message-cost-accounting` scenario (2026-10-19, loopback, 1.15.0 + main `f22a8cb7`): the joiner's attach 25 `sync` requests B→A, its first insert 20 more.

## Direction (to settle in planning)

1. When the consult's answer already holds the selected revision's block and action, restore from it; do not fetch again. Decide what corroboration the acquisition adds when the consult had a single claimant, and keep it if it is load-bearing.
2. Issue independent reads together: a collection's header and tail in one `get`, index trees with `Promise.all`. B-tree descent stays level by level.

## TODO

- Plan both arms; name the tests that pin "one request per cold block per peer" (the issue's repro counts are the expected values).
