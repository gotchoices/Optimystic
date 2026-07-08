description: A node recovering a missing block from peers now picks responsible peers using the same hashed address the rest of the network uses, so the inner-ring fallback recovery path actually queries the right peers instead of the wrong ones.
prereq:
files: packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/test/restoration-coordinator.spec.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts
difficulty: medium
----

# Review: restoration filtered by the wrong coordinate space

## What was wrong (one paragraph)

Peer responsibility in this system is computed in **hashed** coordinate space: a peer's
partition prefix comes from `hashPeerId(peer)` (`ring-selector.ts:95-99`), and the block's
cohort comes from `hashKey(blockId)` (`restoration-coordinator.ts`). But the inner-ring fallback
filter (`filterByPartition`) was deriving the block's partition prefix from the **raw UTF-8
bytes** of the block-id string — despite a comment claiming it hashed. Raw bytes and hashed
coords are unrelated spaces, so for any ring depth > 0 the fallback kept the peers that were
*not* responsible and dropped the ones that *were*. The fallback restoration loop
(`restoration-coordinator.ts` inner-ring `for` loop) was effectively dead for every block.

## What changed

All edits in `packages/db-p2p/src/storage/restoration-coordinator.ts`:

- Import `RingCoord` type from `p2p-fret` (line 2).
- `restore` now hashes the block id **once** into `blockCoord = await hashKey(encode(blockId))`
  and threads that value through both consumers (removes the duplicate hash that
  `getMyRingPeers` used to do internally).
- `getMyRingPeers(blockCoord: RingCoord)` — now synchronous, takes the pre-hashed coord and
  passes it straight to `assembleCohort`.
- `filterByPartition(peers, blockCoord: RingCoord, ringDepth)` — extracts the block prefix from
  the **hashed coord** via a new `extractPrefix(coord, bits)` helper whose bit loop is
  byte-for-byte identical to `RingSelector.extractPrefix` (`ring-selector.ts:165-174`).
- Deleted `extractBlockPrefix` (the raw-byte copy) and its misleading "Hash the block ID"
  comment.

Net behavior: `filterByPartition` now keeps exactly the peers whose `partition.prefixValue`
matches the block's hashed-coord prefix — the cohort actually responsible for the block.

## New test

`packages/db-p2p/test/restoration-coordinator.spec.ts` — hermetic, no libp2p.

- Finds a block id whose **raw-byte** prefix and **hashed-coord** prefix diverge at ring depth 4
  (iterates candidate ids; asserts the two disagree so the test is meaningful).
- Stubs `ArachnodeFretAdapter` so the cohort is empty (control reaches the inner-ring fallback),
  `getMyArachnodeInfo().ringDepth = 5` (loop reaches ring 4), and `findPeersAtRing(4)` returns
  peer-A (partition = hashed prefix, truly responsible) and peer-B (partition = raw prefix,
  decoy).
- Overrides the private `queryPeer` on the instance to record which peers get dialed and return
  `undefined` — avoids `peerIdFromString`/`SyncClient`/network entirely.
- Asserts peer-A is queried and peer-B never is.

**Verified failing pre-fix:** temporarily reintroducing the raw-byte prefix at the call site
made the test fail with `expected [ 'peer-B-raw' ] to include 'peer-A-hashed'` (the exact bug).
Reverted; passes post-fix.

## Validation performed

From `packages/db-p2p`:

- `yarn build` → exit 0 (whole package type-checks clean).
- `node ... mocha test/restoration-coordinator.spec.ts test/ring-selector.spec.ts` → **24 passing**
  (1 new + 23 existing ring-selector; no regression in the shared bit-extraction).
- `yarn test --grep restoration` → green.

## Things for the reviewer to poke at (known gaps / floor, not ceiling)

- **Coverage is one path only.** The new spec exercises the inner-ring fallback filter. It does
  **not** cover the my-ring (`assembleCohort`) path, the self-skip filter, `ringDepth === 0`
  (ring-0 returns all peers unconditionally — correct, but untested here), or the metrics
  bookkeeping. `queryPeer` itself (peer-id parse + `SyncClient.requestBlock`) is stubbed out, so
  the actual dial path is unexercised by this test.
- **`extractPrefix` is duplicated** in `RestorationCoordinator` and `RingSelector` (identical
  bodies). The ticket explicitly said a local copy is acceptable and "do not over-refactor," so
  they were left separate. If the reviewer prefers a shared helper, that's a clean small
  follow-up — but note it crosses two modules that otherwise don't share utilities.
- **No live-network / integration test.** The fix is validated only at the unit level. Whether
  the fallback now recovers a real block end-to-end across actual rings is unverified here.
- **`getMyRingPeers` is now sync** (dropped `async`/`await`). Its only caller (`restore`) was
  updated; grep confirms no other callers, but worth a second look.
- The full `yarn test` suite was **not** run — its glob (`test/**/*.spec.ts`) also matches
  `*.integration.spec.ts`, which spin up libp2p and can exceed the agent idle budget. Only the
  build (whole-package type-check) plus the two relevant specs were run. A human/CI full-suite
  pass is the backstop.

## Review findings

- No tripwires or latent defects parked during this ticket. The one deliberate non-change is the
  duplicated `extractPrefix` (documented above under "Things to poke at"), left per the ticket's
  "do not over-refactor" instruction.
