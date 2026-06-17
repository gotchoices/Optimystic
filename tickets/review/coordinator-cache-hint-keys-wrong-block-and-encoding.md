description: The client's shortcut for remembering which peer handles a block after a redirect was recording its note under a key that never matched how blocks are looked up (and on one path read the request from the wrong place, so it recorded nothing at all); this fixes the key so the shortcut can actually work.
prereq:
files:
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations + recordCoordinatorForOpsIfSupported, now async; call site awaited)
  - packages/db-p2p/src/cluster/client.ts (recordCoordinatorForRecordIfSupported rewritten; now async; call site awaited)
  - packages/db-p2p/test/coordinator-cache-hint.spec.ts (NEW — 4 tests covering both client paths)
  - packages/db-core/src/utility/block-id-to-bytes.ts (blockIdToBytes — the real key encoding; unchanged, referenced)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — correct pend block-id derivation; unchanged, referenced)
  - packages/db-core/src/network/repo-protocol.ts (RepoMessage shape; unchanged, referenced)
  - packages/db-core/src/cluster/structs.ts (ClusterRecord.message: RepoMessage; unchanged, referenced)
difficulty: medium
----

# Review: client coordinator-cache-hint keys (block selection + byte encoding + message shape)

## What this ticket was

Both p2p client redirect paths record a "peer P coordinates key K" hint into the
peer-network coordinator cache after following a redirect, so a follow-up op can dial P
directly instead of re-running `findCoordinator`. Four defects made these hints useless
(and, once the encoding was fixed in isolation, would have made them actively wrong):

- **Defect 0 (ClusterClient only):** read `record.message.commit` / `record.message.pend`,
  which never exist — the op lives at `record.message.operations[0]`. `recordCoordinator`
  was therefore **never called** on the cluster path (dead code).
- **Defect 1 (both):** keyed the cache on raw `TextEncoder().encode(id)` (utf8) instead of
  `blockIdToBytes(id)` (sha256 digest). `findCoordinator`/`recordCoordinator` in
  `network-transactor.ts` always key on the sha256 digest, so a utf8-keyed hint could never
  be retrieved — a silent no-op.
- **Defect 2 (both, commit):** keyed a commit on `tailId` instead of `blockIds[0]` (the block
  consensus + `verifyResponsibility` actually run on). Wrong for a non-tail batch.
- **Defect 3 (both, pend):** keyed a pend on `Object.keys(transforms)[0]` — the structural
  field name `'inserts'`/`'updates'`/`'deletes'`, not a block id. Correct is
  `blockIdsForTransforms(transforms)[0]`.

## What was implemented

**`packages/db-p2p/src/repo/client.ts`**
- `extractKeyFromOperations` is now `async` (`Promise<Uint8Array | undefined>`) and returns
  `await blockIdToBytes(id)` for all four op variants. Per-op block selection:
  get → `blockIds[0]`; pend → `blockIdsForTransforms(transforms)[0]`; commit → `blockIds[0]`
  (was `tailId`); cancel → `actionRef.blockIds[0]`. Each guards an absent id → `undefined`
  (records nothing).
- `recordCoordinatorForOpsIfSupported` is now `async`; the redirect call site (`~line 96`)
  `await`s it. `recordCoordinator` feature-detection preserved.
- Added `blockIdToBytes` to the existing `@optimystic/db-core` value import (alongside
  `blockIdsForTransforms`).

**`packages/db-p2p/src/cluster/client.ts`**
- `recordCoordinatorForRecordIfSupported` rewritten: reads `record.message.operations[0]`
  (typed `RepoMessage`, **dropped the `any` cast** on the message), discriminates
  `'commit' in op` / `'pend' in op`, selects `op.commit.blockIds[0]` /
  `blockIdsForTransforms(op.pend.transforms)[0]`, encodes via `await blockIdToBytes(id)`.
  Scope kept to commit/pend (not widened to get/cancel — that's all the cluster path carries).
  Guards: empty `operations` / missing op / absent id → record nothing. Feature-detection kept.
- Now `async`; the redirect call site (`~line 47`) `await`s it.
- Added value import `{ blockIdToBytes, blockIdsForTransforms } from '@optimystic/db-core'`.

**`packages/db-p2p/test/coordinator-cache-hint.spec.ts` (NEW, 4 tests, all passing)**
A fake `IPeerNetwork` whose first dial returns a `redirect` (so the hint path runs once) and
second dial returns a terminal response (stops the retry), capturing every
`recordCoordinator(keyBytes, peerId)`. Transport-stub pattern mirrors
`cluster-error-propagation.spec.ts` (length-prefixed JSON over an async-iterable stub stream).
- RepoClient non-tail commit → key == `blockIdToBytes('block-A')`, **not** `tailId`, **not**
  raw utf8.
- RepoClient pend (`inserts: { 'block-A' }`) → key == `blockIdToBytes('block-A')`, **not** the
  literal `'inserts'` (raw or hashed).
- ClusterClient non-tail commit → `recordCoordinator` **is invoked** (it never was) with
  `blockIdToBytes('block-A')`, **not** `tailId`.
- ClusterClient pend → invoked with `blockIdToBytes('block-A')`, not `'inserts'`.

## Validation performed

- `yarn workspace @optimystic/db-p2p build` → exit 0 (clean tsc; `noUncheckedIndexedAccess`
  honored — `blockIds[0]` is `string | undefined`, guarded).
- `yarn workspace @optimystic/db-p2p test` → **808 passing, 28 pending, exit 0.** The known
  `reactivity / mesh — slow-subscriber isolation` flake did **not** fire; no
  `tickets/.pre-existing-error.md` was needed. (A `cohort-topic cold-start` line in the output
  is an error logged *inside* a passing test, not a failure.)
- db-core was **not** modified (no changes were expected there).

## Reviewer focus / known gaps (treat tests as a floor)

1. **get/cancel encoding is type-checked but not behavior-tested.** Only commit and pend have
   assertion coverage (those carry Defects 2/3). The get/cancel branches were also switched
   from raw utf8 to `blockIdToBytes` (Defect 1 applies to them too) but no test asserts their
   recorded bytes. Worth a glance: confirm the get/cancel branches are correct by inspection,
   or add two more cases if you want parity. (Note: `ClusterClient` intentionally does **not**
   handle get/cancel — scope was kept as-is.)
2. **No live end-to-end record→retrieve roundtrip.** The tests prove the *client records the
   exact bytes `blockIdToBytes` produces* — the same function every real `findCoordinator`
   caller passes — which is the strongest unit-level proof that writer and reader key bytes are
   identical. But no integration test actually records a hint and then observes
   `findCoordinator` return it from cache against a real `Libp2pKeyPeerNetwork`. If deeper
   confidence is wanted, an integration test exercising `recordCoordinator` →
   `getCachedCoordinator` via `toCacheKey` would close the loop.
3. **RepoClient internal timeout timer.** `processRepoMessage` arms a `setTimeout` race that is
   never `clearTimeout`'d on the success path (pre-existing, not introduced here). The new
   RepoClient tests pass `{ expiration: Date.now() + 2000 }` so that timer doesn't keep the
   node process alive ~30s after the (instant) stub responds. Harmless, but if a reviewer
   prefers, the production code could `clearTimeout` the loser — out of scope for this ticket.
4. **Guard semantics.** `extractKeyFromOperations` (RepoClient) does not pre-guard an empty
   `ops` array (matches the original; the public methods always pass exactly one op).
   `ClusterClient` *does* guard empty `operations`/missing op (records can be built externally).
   Confirm that asymmetry is acceptable.

## Suggested review commands

```
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log
# focused:
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/coordinator-cache-hint.spec.ts" --reporter spec
```
