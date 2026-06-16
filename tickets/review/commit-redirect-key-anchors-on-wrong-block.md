description: A peer deciding whether to forward an incoming commit to another group was checking the wrong block, so multi-block writes could be bounced to a group that can't handle them. Fixed the routing key and added regression tests.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey extracted; commit redirect now keys on blockIds[0])
  - packages/db-p2p/test/redirect.spec.ts (new deriveBlockKey derivation tests + large-mesh commit redirect regression test)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit handler this redirect protects — anchors on blockIds[0], guards verifyResponsibility(blockIds))
  - packages/db-core/src/transactor/network-transactor.ts (per-block commit routing via findCoordinator; tailId threaded into every batch for the change-event stamp, not routing)
  - packages/db-core/src/network/struct.ts (CommitRequest = ActionBlocks + tailId + rev)
difficulty: medium
----

# Commit redirect key anchored on the collection tail, not the block(s) being committed — FIXED

## What was wrong (recap)

`RepoService.handleIncomingStream` runs a responsibility-driven **redirect** check before handling
each op: it derives an op-specific `blockKey`, calls `checkRedirect(blockKey, …)`, and if this peer
isn't a member of `H(blockKey)`'s cluster (and the mesh isn't "small"), it redirects the caller to
that cluster.

The **commit** branch derived `blockKey` from `operation.commit.tailId`. But the handler it protects —
`CoordinatorRepo.commit` (coordinator-repo.ts:402-419) — anchors consensus on `blockIds[0]`
(`getClusterSize(blockIds[0])`, `executeClusterTransaction(blockIds[0])`) and guards with
`verifyResponsibility(blockIds)`. `NetworkTransactor.commit` (network-transactor.ts:455-525) splits one
collection commit into **per-block batches** routed by `findCoordinator(blockId)` and threads the
collection's `tailId` into *every* batch (purely for the `CollectionChangeEvent` stamp, not routing).
For header/remaining-block batches `blockIds[0] !== tailId`, so the receiving coordinator was
redirect-checked against the **tail's** cluster — and if not a member, bounced the commit to the
tail's cluster, which then fails `verifyResponsibility` for the non-tail block.

Latent today because every existing test runs in a "small mesh" (`cluster.length < responsibilityK`),
where `checkRedirect` returns `null` regardless of key. Reachable only on a large multi-cluster mesh
whose collection blocks span clusters.

## What changed

**`packages/db-p2p/src/repo/service.ts`**
- Extracted the per-op key derivation out of `handleIncomingStream` into a pure, public, testable
  method `deriveBlockKey(operation): { blockKey: string | undefined, opName: string }` covering
  get/pend/cancel/commit.
- Fixed the **commit** case to derive `blockKey` from `operation.commit.blockIds[0]` (was `tailId`) —
  now consistent with get/cancel (`blockIds[0]`) and with `CoordinatorRepo.commit`'s `blockIds[0]`
  consensus anchor.
- Rewrote `handleIncomingStream`'s dispatch to: derive once → redirect-check iff `blockKey !==
  undefined` → dispatch to the matching handler. Behavior preserved, including cancel's
  "no blockKey → handle locally without redirect" fallback (now generalized: any op with no routable
  key handled locally). This also removed the four duplicated redirect-check blocks.

**`packages/db-p2p/test/redirect.spec.ts`**
- New `deriveBlockKey` describe: asserts get→blockIds[0], pend→first transforms key,
  cancel→actionRef.blockIds[0], empty-cancel→undefined, and the regression assertion
  **commit→blockIds[0], NOT tailId** for a non-tail batch (`blockIds: ['block-A',…]`, `tailId:'tail-Z'`).
- New `commit redirect keys on blockIds[0] (large mesh)` describe: end-to-end via a keyed
  network-manager (`makeKeyedNetworkManager`, mapping each blockKey's sha256 digest to a distinct
  cluster) with `responsibilityK: 2`. block-A's cluster excludes self (redirect must fire toward
  block-A's coordinator); tail-Z's cluster includes self (so keying on tailId would NOT redirect). The
  test drives the **derived** key through `checkRedirect` and asserts the redirect targets block-A —
  and adds a sanity assertion that the tail-keyed call returns `null`. This is the
  `!smallMesh && !isMember` path the prior commit suite never hit (it passed the key explicitly).

## Validation performed

- `yarn build:db-core` and `yarn build:db-p2p` (tsc typecheck) — both exit 0, no errors.
- `redirect.spec.ts`: **19 passing** (6 new).
- Full `db-p2p` suite (`test/**/*.spec.ts`): **732 passing, 27 pending, 0 failing** (32s). The 27
  pending are pre-existing documentation-expectation placeholders, unrelated to this change.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.

## Use cases / what to verify in review

- **Primary correctness**: a commit batch whose `blockIds[0] !== tailId` is redirect-checked against
  `blockIds[0]`'s cluster, so it reaches a coordinator that passes `verifyResponsibility(blockIds)`.
  Covered by the two new describes; verify the keyed-network-manager logic actually distinguishes
  block-A from tail-Z (it maps real sha256 digests, the same hash `checkRedirect` computes).
- **Behavior parity**: confirm the dispatch rewrite preserves the original four branches — especially
  cancel-with-empty-blockIds handled locally with no redirect, and the `(message as any).cluster`
  side-effect still attached for every keyed op.
- **Tail batch unaffected**: for the tail batch `blockIds[0] === tailId`, so the key is unchanged.

## Known gaps / honest flags for the reviewer

1. **`pend` redirect key derivation is questionable and was preserved verbatim (out of scope).**
   `deriveBlockKey` keeps `Object.keys(operation.pend.transforms)[0]`. The real `Transforms` type is
   `{ inserts?, updates?, deletes? }` (db-core/src/transform/struct.ts), so `Object.keys(...)[0]`
   yields a **structural key** (`'inserts'`/`'updates'`/`'deletes'`), *not* a block id — unlike
   `getAffectedBlockIds` in cluster-repo.ts which correctly uses `blockIdsForTransforms(...)`. This
   looks like a *separate latent bug* in pend redirect keying. The existing and new pend tests pass a
   *flat* block-id-keyed transforms object (`{ 'block-A': {} }`), which does NOT match the real
   `Transforms` shape, so neither old nor new tests exercise the real-shaped pend derivation. **This
   ticket deliberately did not touch pend** (scope was commit). Recommend filing a follow-up `fix/`
   ticket to harmonize pend redirect keying with `blockIdsForTransforms` and add a real-shaped test.

2. **Client-side cache-hint keys still use `tailId` for commit (separate mechanism, out of scope).**
   `packages/db-p2p/src/repo/client.ts` `extractKeyFromOperations` (~line 112) and
   `packages/db-p2p/src/cluster/client.ts` `recordCoordinatorForRecordIfSupported` both key commit on
   `tailId` when recording a redirect target into the coordinator cache. These are NOT part of the
   service redirect path this ticket fixed — they compute their own keys — and additionally use raw
   `TextEncoder().encode(...)` rather than db-core's `blockIdToBytes` (sha256), so their cache key
   bytes already don't match the per-block routing key bytes used by `findCoordinator`. This is the
   same conceptual tailId-vs-blockIds[0] smell in a different subsystem. Left untouched (out of scope);
   recommend a follow-up to harmonize the cache-hint keys with the per-block routing key.

3. **No real multi-cluster libp2p integration test.** The new test simulates a large multi-cluster
   mesh via a keyed in-memory network manager; it does not stand up a real multi-node libp2p mesh.
   The unit test is a floor, not a full integration proof.

4. **`handleIncomingStream` (private, stream-based) is still not tested end-to-end.** The derivation
   was extracted specifically so it IS unit-testable, and it is. But the wiring inside
   `handleIncomingStream` (call `deriveBlockKey` → redirect-check → dispatch) is verified by reading,
   not by a libp2p `Stream`-level test.
