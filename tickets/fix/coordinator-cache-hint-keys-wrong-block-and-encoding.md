description: The client-side shortcut that remembers which peer coordinates a block computes its lookup key in a way that never matches how the network actually looks blocks up, so the shortcut silently never helps — and for multi-block writes it remembers the wrong block entirely.
prereq:
files:
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations — lines ~101-119)
  - packages/db-p2p/src/cluster/client.ts (recordCoordinatorForRecordIfSupported — lines ~53-65)
  - packages/db-core/src/utility/block-id-to-bytes.ts (blockIdToBytes — sha256; the real routing key encoding)
  - packages/db-core/src/transactor/network-transactor.ts (findCoordinator / recordCoordinator keyed via blockIdToBytes)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — correct pend block-id derivation)
difficulty: medium
----

# Client coordinator-cache-hint keys: wrong block (tailId / structural field) and wrong byte encoding

## Problem

Two client-side paths record a "this peer coordinates key K" hint into the peer-network coordinator cache
when they follow a redirect, so a follow-up op can dial the same coordinator directly:

1. `RepoClient.extractKeyFromOperations` (`packages/db-p2p/src/repo/client.ts` ~101-119)
2. `ClusterClient.recordCoordinatorForRecordIfSupported` (`packages/db-p2p/src/cluster/client.ts` ~53-65)

Both compute the cache key with the **same defects** the service redirect path had:

- **commit → keyed on `tailId`** (should be `blockIds[0]`, the block the commit is actually coordinated
  on — see the `commit-redirect-key-anchors-on-wrong-block` fix). For a non-tail commit batch
  (`blockIds[0] !== tailId`) the hint records the coordinator under the wrong block.
- **pend → `Object.keys(transforms)[0]`** (a structural field name `'inserts'`/`'updates'`/`'deletes'`,
  not a block id — see the `pend-redirect-key-uses-structural-field-not-block-id` fix). Should be
  `blockIdsForTransforms(transforms)[0]`.
- **raw `new TextEncoder().encode(id)` instead of `blockIdToBytes(id)` (sha256).** The real routing key
  used by `findCoordinator` / `recordCoordinator` in `network-transactor.ts` is the **sha256 digest** of
  the block id (`blockIdToBytes`). Encoding the id as raw UTF-8 bytes produces a *different key*, so the
  recorded hint can never be retrieved by a lookup that hashes — i.e. the cache hint is effectively a
  **no-op today**, masking the wrong-block defects above. Once the encoding is corrected to sha256, the
  wrong-block (tailId / structural-key) defects become live misroutes, so both must be fixed together.

## Why it matters

These are coordinator-cache **hints** (an optimization), so the immediate user-visible impact is a missed
cache hit (extra coordinator lookups), not a hard failure — the encoding mismatch currently neutralizes
the hint. But the keying is conceptually wrong in the same way as the service redirect bug, and a future
change that "fixes" the encoding without fixing the block selection would start misrouting follow-up ops
to the wrong cluster. Harmonize all three: derive the key from the same block the op is coordinated on
(`blockIds[0]` for commit, `blockIdsForTransforms(...)[0]` for pend), and encode it with `blockIdToBytes`
so the recorded hint and the `findCoordinator` lookup share identical key bytes.

## Fix sketch

- In `extractKeyFromOperations`: commit → `op.commit.blockIds[0]`; pend →
  `blockIdsForTransforms(op.pend.transforms)[0]`; return `await blockIdToBytes(id)` for all four cases
  (note: this makes the method async — thread the await through `recordCoordinatorForOpsIfSupported`).
- In `ClusterClient.recordCoordinatorForRecordIfSupported`: same block selection, encode via
  `blockIdToBytes`.
- Add tests asserting the recorded key bytes equal `blockIdToBytes(blockIds[0])` for a non-tail commit
  and a real-shaped pend, matching what `findCoordinator` would look up.

## Validation

- Build + typecheck `db-p2p` and `db-core`.
- Run `db-p2p` suite; confirm green (pre-existing flaky `reactivity / mesh — slow-subscriber isolation`
  is unrelated).
