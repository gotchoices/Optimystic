description: The client's shortcut for remembering which peer handles a block after a redirect was recording its note under a key that never matched how blocks are looked up; this fixes the key so the shortcut actually works, and the fix passed an adversarial review.
prereq:
files:
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations + recordCoordinatorForOpsIfSupported, async; awaited at redirect site)
  - packages/db-p2p/src/cluster/client.ts (recordCoordinatorForRecordIfSupported rewritten, async; awaited at redirect site)
  - packages/db-p2p/test/coordinator-cache-hint.spec.ts (6 tests: 4 from implement + 2 added in review for get/cancel parity)
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey + checkRedirect — server routing key the client must mirror; unchanged, referenced)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit/pend anchor on blockIds[0] / blockIdsForTransforms; unchanged, referenced)
  - packages/db-p2p/src/libp2p-key-network.ts (recordCoordinator/findCoordinator/toCacheKey; unchanged, referenced)
  - packages/db-core/src/transactor/network-transactor.ts (findCoordinator/recordCoordinator call sites key on blockIdToBytes; unchanged, referenced)
  - packages/db-core/src/utility/block-id-to-bytes.ts (blockIdToBytes = sha256 digest; unchanged, referenced)
difficulty: medium
----

# Complete: client coordinator-cache-hint keys (block selection + byte encoding + message shape)

## What this was

Both p2p client redirect paths (`RepoClient`, `ClusterClient`) record a "peer P coordinates
key K" hint into the coordinator cache after following a redirect, so a follow-up op can dial P
directly instead of re-running `findCoordinator`. Four defects made the hints useless: reading
the op from the wrong place on the cluster path (so it never fired), keying on raw utf8 instead
of the sha256 digest, keying a commit on `tailId` instead of `blockIds[0]`, and keying a pend
on a structural field name instead of a real block id. The implement stage fixed all four and
added 4 tests; this review verified the fix end-to-end and closed a coverage gap.

## Review findings

### What was checked

- **Read the implement diff first, fresh eyes** (`git show ef00bd7`), before the handoff
  summary. Re-derived each of the four defect claims against the live codebase rather than
  trusting the writeup.
- **Keying alignment (the crux).** Confirmed the recorded bytes and the lookup bytes are
  produced by the same function:
  - Client now records `recordCoordinator(blockIdToBytes(id), peer)`.
  - `blockIdToBytes` (`db-core/src/utility/block-id-to-bytes.ts`) = `sha256.digest(utf8(id)).digest`.
  - `Libp2pKeyPeerNetwork.recordCoordinator`/`findCoordinator`/`getCachedCoordinator` all key
    the cache via `toCacheKey = base64url(bytes)` — so identical input bytes ⇒ identical cache key.
  - Every real `findCoordinator` caller in `network-transactor.ts` passes
    `await blockIdToBytes(blockId)`. Writer and reader bytes are therefore byte-identical.
  - Independent cross-check: the server's `RepoService.checkRedirect` computes the redirect on
    `sha256.digest(utf8(blockKey)).digest` — the *same* bytes — so the client records a hint for
    exactly the block whose redirect it just followed.
- **Block selection mirrors the server.** Client `extractKeyFromOperations` now matches
  `RepoService.deriveBlockKey` op-for-op: get→`blockIds[0]`, pend→`blockIdsForTransforms[0]`,
  cancel→`actionRef.blockIds[0]`, commit→`blockIds[0]`. Confirmed `CoordinatorRepo.commit`
  anchors consensus + `verifyResponsibility` on `request.blockIds` / `getClusterSize(blockIds[0])`,
  **not** `tailId` — so the old `tailId` key would have routed a non-tail batch to the wrong
  cluster. `CommitRequest` type confirmed to carry both `blockIds` (via `ActionBlocks`) and a
  distinct `tailId`.
- **Cluster message shape.** Confirmed `ClusterRecord.message` is a `RepoMessage`
  (`{ operations: [...] }`); the old `record.message.commit`/`.pend` reads were always
  `undefined`, so `recordCoordinator` was genuinely dead code on that path. The rewrite reads
  `record.message.operations[0]` and dropped the `any` cast — now strongly typed.
- **Type safety.** `noUncheckedIndexedAccess` honored — `blockIds[0]` / `blockIdsForTransforms()[0]`
  are `string | undefined` and every branch guards `id == null` → records nothing.
- **async/await propagation.** `blockIdToBytes` is async; both `extractKey*`/`record*` helpers
  became async and both redirect call sites `await` them before the (already-async) retry. No
  fire-and-forget; ordering is deterministic and testable.
- **Lint/build/tests.** `yarn workspace @optimystic/db-p2p build` → exit 0 (clean tsc).
  Full suite `yarn workspace @optimystic/db-p2p test` → **810 passing, 28 pending, exit 0.**

### What was found and done

- **Minor — get/cancel branches had no behavior test (fixed in this pass).** The implement
  tests covered only commit and pend (the branches carrying defects 2/3). The get and cancel
  branches were also switched from raw utf8 to `blockIdToBytes` (defect 1 applies to them too)
  but nothing asserted their recorded bytes. **Added two `RepoClient` cases** to
  `coordinator-cache-hint.spec.ts` asserting get → `blockIdToBytes(blockIds[0])` and
  cancel → `blockIdToBytes(actionRef.blockIds[0])`, each proving it is not raw utf8. Suite is
  now 6/6 here, 810 total. (ClusterClient intentionally carries only commit/pend — scope
  unchanged, correctly.)

- **No major findings → no new tickets filed.** The fix is correct, well-scoped, well-commented,
  and the keying is provably consistent across writer (client), reader (`findCoordinator`), and
  the server's redirect derivation.

- **Acknowledged, not acted on (each justified):**
  - *No live record→retrieve integration test.* Closing the loop against a real
    `Libp2pKeyPeerNetwork` would add confidence, but the unit tests already prove the client
    emits the exact bytes `blockIdToBytes` produces — the identical function every real
    `findCoordinator` caller and the server's `checkRedirect` use — which is the strongest
    unit-level guarantee that writer and reader keys match. Not a defect; an optional
    confidence-add. Left for a future integration ticket if desired.
  - *`RepoClient.processRepoMessage` arms a `setTimeout` race never `clearTimeout`'d on success.*
    Pre-existing, not introduced here, and out of scope. The new tests pass a near-future
    `expiration` so the timer can't keep the process alive after the instant stub responds.
    Harmless; flagged for awareness only.
  - *Guard asymmetry:* `RepoClient.extractKeyFromOperations` does not pre-guard an empty `ops`
    array (public methods always pass exactly one op), while `ClusterClient` does guard empty
    `operations`/missing op (records can be built externally). Reviewed and accepted — the
    asymmetry matches each path's actual caller contract.

### Categories with nothing to report

- **Regressions:** none — full db-p2p suite green at 810 passing (was 808; delta is the 2 added
  tests). No behavior outside the two client redirect paths is touched.
- **Pre-existing failures:** none triggered. The `cohort-topic cold-start: parent registration
  ... parent unreachable` line in the output is an error *logged inside a passing test*
  (`host-antidos-coldstart.spec.ts`), not a test failure. No `tickets/.pre-existing-error.md`
  needed.
- **Docs:** the explanatory comments in both client files and the `deriveBlockKey` docblock in
  `service.ts` were read and accurately describe the new reality (block selection, encoding, the
  tailId pitfall). No doc drift introduced or pre-existing in the touched files.
- **db-core:** not modified, none expected.

## Validation performed (review)

- `yarn workspace @optimystic/db-p2p build` → exit 0.
- Focused: `coordinator-cache-hint.spec.ts` → 6 passing (4 original + 2 added).
- Full: `yarn workspace @optimystic/db-p2p test` → 810 passing, 28 pending, exit 0.

## End
