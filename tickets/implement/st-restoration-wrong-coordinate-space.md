description: When a node recovers a missing block from peers, it picks which peers are responsible using raw block-id bytes instead of the hashed address the network actually uses, so it asks the wrong peers and the inner-ring fallback recovery never works. Fix it to hash the block id the same way the rest of the system does.
prereq:
files: packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts, packages/db-p2p/test/ring-selector.spec.ts
difficulty: medium
----

# Restoration filters by the wrong coordinate space

> NOTE: the original ticket named `restoration-coordinator-v2.ts`. That path only
> exists as a compiled artifact under `dist/`. The real source is
> `packages/db-p2p/src/storage/restoration-coordinator.ts`; line numbers below match it.

## Root cause (confirmed)

Peer responsibility in this system is computed in **hashed coordinate space**, not from raw
identifier bytes:

- A peer's partition is set by `RingSelector.calculatePartition` (`ring-selector.ts:88-102`):
  `coord = await hashPeerId(peer)` (a 32-byte `RingCoord`), then
  `prefixValue = extractPrefix(coord, ringDepth)`.
- `RestorationCoordinator.getMyRingPeers` (`restoration-coordinator.ts:102-106`) likewise hashes
  the block: `coord = await hashKey(encode(blockId))`, then `assembleCohort(coord, 10)`.

`hashKey` and `hashPeerId` (from `p2p-fret`, see
`packages/db-p2p/node_modules/p2p-fret/dist/src/ring/hash.d.ts`) both return a
`RingCoord = Uint8Array` of `COORD_BYTES = 32`. That is the shared coordinate space.

But `extractBlockPrefix` (`restoration-coordinator.ts:136-153`) does **not** hash. Its comment
says "Hash the block ID to get uniform distribution", yet the loop just copies the raw first
bytes of the UTF-8 blockId string into a 32-byte buffer:

```ts
const bytes = new TextEncoder().encode(blockId);
const hash = new Uint8Array(32);
for (let i = 0; i < Math.min(bytes.length, hash.length); i++) {
    hash[i] = bytes[i]!;   // raw copy — no hashing
}
```

So `filterByPartition` (`restoration-coordinator.ts:119-131`) compares a **raw-byte** prefix
against **hashed-coordinate** `prefixValue`s. The two spaces are unrelated, so for any ring
depth > 0 the inner-ring fallback selects peers that are *not* responsible for the block and
filters *out* the ones that are. The fallback restoration path (the `for (ringDepth …)` loop at
`restoration-coordinator.ts:68-82`) is effectively dead for every block.

The bit-extraction math itself is already correct and identical to the canonical one:
`extractBlockPrefix`'s bit loop (`restoration-coordinator.ts:145-152`) matches
`RingSelector.extractPrefix` (`ring-selector.ts:165-174`) byte-for-byte. **Only the input is
wrong** — it must be the hashed coord, not raw blockId bytes.

## Fix approach

Feed `filterByPartition` the same hashed coordinate the rest of the coordinator already uses.

`hashKey` is async, so the prefix source cannot be produced inside the current synchronous
`extractBlockPrefix`. Cleanest shape (also removes duplicate hashing):

- Compute the block coord **once** at the top of `restore`:
  `const blockCoord = await hashKey(new TextEncoder().encode(blockId));`
- Reuse `blockCoord` for `getMyRingPeers` (drop its internal re-hash) and pass it into
  `filterByPartition`.
- Change `filterByPartition(peers, blockCoord: RingCoord, ringDepth)` to extract the prefix from
  `blockCoord` via the same bit logic as `ring-selector.ts`'s `extractPrefix`. Replace
  `extractBlockPrefix` with an `extractPrefix(coord: RingCoord, bits)` that takes the coord
  directly (identical body to `RingSelector.extractPrefix` — consider sharing it, but a local
  copy is acceptable; do not over-refactor).

Import `RingCoord` (and `hashKey` is already imported at `restoration-coordinator.ts:2`) from
`p2p-fret`.

Net behavioral change: after the fix, `filterByPartition` keeps exactly the peers whose
`partition.prefixValue` matches the block's hashed-coord prefix — the cohort actually
responsible for the block — so the inner-ring fallback queries the right peers.

## Reproduction / test

There is currently **no** test targeting `RestorationCoordinator` (grep confirms). Add one under
`packages/db-p2p/test/`; model it on `ring-selector.spec.ts`.

The defect is exercisable without a live network by driving `filterByPartition` through the
public `restore` path with a stubbed `ArachnodeFretAdapter` + `IPeerNetwork`:

- Pick a `blockId` whose **raw-byte** prefix and **`hashKey`-derived** prefix land in different
  ring partitions for some `ringDepth` (e.g. 4). Compute both offline to choose the id:
  raw prefix via the old copy-bytes logic, correct prefix via
  `extractPrefix(await hashKey(encode(blockId)), bits)`.
- Stub `findPeersAtRing(ringDepth)` to return two peers: peer-A with
  `partition.prefixValue = <hashed prefix>` (the truly responsible peer) and peer-B with
  `partition.prefixValue = <raw prefix>` (the wrongly-selected peer). Give `getMyArachnodeInfo`
  a `ringDepth` > that ring so the inner-ring loop runs, and make `assembleCohort` /
  my-ring peers empty so control reaches the fallback loop.
- Assert the coordinator queries **peer-A** (matching the hashed coord) and never peer-B.
  Pre-fix this fails (it queries peer-B); post-fix it passes.

Keep the test hermetic — no libp2p. Follow the existing stub style in `ring-selector.spec.ts`
and the `test/util` helpers.

## Validation

From `packages/db-p2p`:

```
yarn build 2>&1 | tee /tmp/db-p2p-build.log
yarn test --grep restoration 2>&1 | tee /tmp/db-p2p-restore-test.log
```

(Adjust the grep to whatever `describe` name you give the new spec.) Also run `ring-selector`
tests to confirm no regression in the shared bit-extraction if you refactor it.

## TODO

- [ ] In `restore`, compute `blockCoord = await hashKey(new TextEncoder().encode(blockId))` once.
- [ ] Refactor `getMyRingPeers` to accept `blockCoord` (or reuse it) instead of re-hashing.
- [ ] Change `filterByPartition` to take `blockCoord: RingCoord`; extract the prefix from the
      hashed coord using the same bit logic as `RingSelector.extractPrefix`.
- [ ] Delete/replace `extractBlockPrefix` (raw-byte copy) and its misleading comment.
- [ ] Update the call site at `restoration-coordinator.ts:72` to pass `blockCoord`.
- [ ] Add a hermetic `RestorationCoordinator` spec that fails pre-fix and passes post-fix
      (see reproduction above).
- [ ] `yarn build` + `yarn test` from `packages/db-p2p`; both green.
