description: A node recovering a missing block from peers now picks responsible peers using the same hashed address the rest of the network uses, so the inner-ring fallback recovery path queries the right peers instead of the wrong ones.
prereq:
files: packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/test/restoration-coordinator.spec.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts
difficulty: medium
----

# Complete: restoration filtered by the wrong coordinate space

## What the change did

`RestorationCoordinator`'s inner-ring fallback (`filterByPartition`) used to derive a block's
partition prefix from the **raw UTF-8 bytes** of the block-id string, while peer partitions
are computed from **hashed** coordinates (`hashPeerId` → sha256). Two unrelated spaces, so for
any ring depth > 0 the fallback kept the wrong peers and dropped the responsible ones — the
fallback loop was effectively dead.

The fix hashes the block id once (`hashKey(blockId)` → 32-byte coord) in `restore`, threads
that coord through `getMyRingPeers` and `filterByPartition`, and extracts the block prefix
with a bit loop byte-for-byte identical to `RingSelector.extractPrefix`. Both spaces are now
sha256 digests, so `filterByPartition` keeps exactly the peers whose `partition.prefixValue`
matches the block's hashed-coord prefix.

## Review findings

### Verified — the diff itself is correct

- **Coordinate spaces now match.** Confirmed `hashKey` (blocks) and `hashPeerId` (peers) both
  produce a sha256 digest into the same 256-bit space (`p2p-fret/src/ring/hash.ts:11-21`), so
  matching a block's hashed prefix against a peer's `hashPeerId`-derived `prefixValue` is the
  correct responsibility test.
- **`extractPrefix` mirror is exact.** Byte-for-byte identical to `RingSelector.extractPrefix`
  (`ring-selector.ts:165-174`). Ring depth is capped at 16, so max byte index is 1 — well
  within the 32-byte coord. No out-of-bounds.
- **`getMyRingPeers` made sync — safe.** `assembleCohort` returns `string[]` synchronously
  (build passes with the non-async signature); its only caller (`restore`) was updated. Grep
  confirms no other callers of `getMyRingPeers`, `filterByPartition`, or the deleted
  `extractBlockPrefix`.
- **Build + tests green.** `yarn build` → exit 0 (whole-package type-check). Ran
  `restoration-coordinator.spec.ts` + `ring-selector.spec.ts` → **24 passing**.

### Test coverage — adequate for scope, gaps noted

- The new spec is hermetic (no libp2p) and pins the exact bug: it finds a block id whose
  raw-byte and hashed-coord prefixes diverge at depth 4, stubs the adapter so control reaches
  the inner-ring fallback, and asserts the hashed-partition peer is queried and the raw-byte
  decoy never is. Verified failing pre-fix per the implement handoff.
- Untested (acceptable — floor, not regression): the my-ring `assembleCohort` path,
  `ringDepth === 0` all-peers case, self-skip filter, metrics, and the real `queryPeer`
  dial path (stubbed). No inline test added — the reviewed defect is covered and these are
  pre-existing coverage gaps, not introduced by this diff.

### Major finding (filed as new ticket, NOT fixed here)

- **`RingSelector.calculatePartition` throws for any ring > 0**, which means the peer side of
  the comparison this fix repaired is never populated at scale. `calculatePartition`
  (`ring-selector.ts:95`) calls `hashPeerId({ toString: () => peerId } as any)`, but
  `hashPeerId` reads `peerId.toMultihash().bytes` — the fake object has no `toMultihash`.
  Verified directly: **`TypeError: peerId.toMultihash is not a function`**. Ring-0 nodes exit
  `calculatePartition` early (no throw), which is why dev/test (everyone on ring 0) stays
  green; ring > 0 nodes throw during `createArachnodeInfo` at startup
  (`libp2p-node-base.ts:885`) and never publish a partition into FRET metadata. Net: at ring >
  0 in production, `filterByPartition` has no peer `prefixValue` to match, so this fix — though
  coordinate-correct — is inert until the upstream bug lands.
  → **`tickets/backlog/bug-arachnode-partition-hashpeerid-throws.md`** (reachable now, so
  `bug-`, not `debt-`). That ticket also flags the empty-`catch` in `ring-selector.spec.ts`
  that masks the throw as a vacuous pass.

### Tripwires / conditional concerns

- **None parked.** The only deliberate non-change is the `extractPrefix` copy duplicated
  between `RestorationCoordinator` and `RingSelector`. The implement ticket explicitly said a
  local copy is acceptable and "do not over-refactor," so it was left as-is. It is not a
  latent defect (both copies are identical and each is unit-covered), just mild DRY debt — not
  worth a ticket or a code comment beyond what's already in the mirror docstring.

### Not run

- Full `yarn test` (glob also matches `*.integration.spec.ts`, which spin up libp2p and can
  exceed the agent idle budget). Whole-package type-check + the two relevant specs stand in;
  full-suite is the human/CI backstop.
