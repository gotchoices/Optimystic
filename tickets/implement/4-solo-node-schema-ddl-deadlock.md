description: First DDL on a solo/bootstrap libp2p node (no listen addrs, empty bootstrap list) fails with "Some peers did not complete: self[block:optimystic/schema](in-flight); root: No coordinator available for key (all candidates excluded)". Fix the broken self-coordination path and surface a useful error when it fails.
dependencies: libp2p-key-network.findCoordinator / shouldAllowSelfCoordination, cluster-coordinator 2PC path, network-transactor processBatches retry logic
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCoordinator, shouldAllowSelfCoordination, libp2p-key-network.ts:282-377)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (already has isLocal short-circuit at lines 351, 452, 532-540, 634-643)
  - packages/db-p2p/src/repo/coordinator-repo.ts (peerCount<=1 short-circuit at 245-247 and 318-321)
  - packages/db-core/src/transactor/network-transactor.ts (aggregate "Some peers did not complete" at 141-147 and 335-347; processBatches retry via excludedPeers)
  - packages/db-core/src/utility/batch-coordinator.ts (processBatches retry logic; adds failed peer to excludedPeers at 129)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (getRepo returns coordinatedRepo for self at 138-145)
  - packages/db-p2p/src/libp2p-node-base.ts (wires localCluster + coordinatedRepo at 354-359; restoreCallback at 400-402)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (existing unit tests; add solo-node scenarios)
  - packages/db-p2p/test/cluster-coordinator.spec.ts (existing; add 1-peer end-to-end)

----

## What research confirmed

- `CoordinatorRepo.pend` already short-circuits when `peerCount <= 1` and skips cluster consensus entirely (see `coordinator-repo.ts:244-247`). `commit` mirrors this.
- `ClusterCoordinator` already has `isLocal` short-circuits in `collectPromises`, `commitTransaction`, the post-majority broadcast, and `retryCommits` — each calls `this.localCluster!.update(record)` directly for self (`cluster-coordinator.ts:351, 452, 533, 636`).
- `collection-factory.ts:138-145` routes `getRepo(self)` to `coordinatedRepo`, so `NetworkTransactor.pend` also goes through the local path when a batch lands on self.
- `libp2p-node-base.ts:354-359` wires `localCluster: clusterImpl, localPeerId: node.peerId`, so the `localClusterRef` in `CoordinatorRepo` is non-undefined.

So the original ticket's fix direction #1 ("cluster-coordinator self short-circuit") is already in place. The ticket's other hypothesis — that the self-targeted call is doing a libp2p stream — is **not** the cause. Something else on the solo-node path is failing.

## What's actually broken

Two problems, at least one must be fixed:

### Problem A: findCoordinator retry loses self and masks the real error

`batch-coordinator.ts:129` on first failure of a batch adds the failed peer to `excludedPeers`, then re-runs `findCoordinator(key, { excludedPeers })`. On a solo node this excluded set now contains self. `findCoordinator` has no FRET neighbors, no connected peers, and self is excluded — it throws "No coordinator available for key (all candidates excluded)" at `libp2p-key-network.ts:376`.

That error then becomes the `root:` in the aggregate error at `network-transactor.ts:342-347`, completely hiding the real cause of the first-attempt failure. Anyone debugging on the mobile device sees only the retry error, not why the initial self-coordination attempt failed.

This is the meta-bug that made the underlying bug (Problem B) impossible to diagnose from logs.

### Problem B: the first self-targeted attempt fails

The reproducing test will surface this. Candidates, in order of likelihood:

1. **Restoration callback dialing nowhere.** `libp2p-node-base.ts:393-402` installs a `restoreCallback` that calls `RestorationCoordinator.restore(blockId)`, which dials other FRET peers. On a solo node with `listenAddrs: []` this either hangs or throws, and the error propagates through `StorageRepo.get/pend`. If it hangs, the outer 30s `timeoutMs` in `NetworkTransactor` wins and the batch promise rejects — matching the reported `(in-flight)` label (which is just `isResponse=false`, i.e. pending-or-errored, not strictly "never settled").
2. **`verifyResponsibility` bailing out.** `CoordinatorRepo.verifyResponsibility` calls `findCluster`, which depends on FRET. If FRET returns `{}` (not-including-self) for an edge node at cold start, `localPeerId.toString() in peers` is false and the schema pend is rejected with `Not responsible for block(s): optimystic/schema`. Short-circuiting on empty FRET with "include self" would prevent this. Research shows `findCluster` at `libp2p-key-network.ts:407` DOES include self, so this is less likely, but worth covering in tests.
3. **Tree.createOrOpen first-read path.** For a brand-new tree, schema-tree creation triggers a `get` that finds no block, then a `pend` to create it. If the `get` hits the restoration path (Problem B.1), it hangs.

The reproducing test should distinguish these without guessing.

## Fix plan (test-driven)

### Phase 1 — Reproducing test (must fail before any source change)

Add `packages/db-p2p/test/solo-node-self-coord.spec.ts` that:

- Spins up ONE `createLibp2pNode({ bootstrapNodes: [], listenAddrs: [], transports: [...], networkName: 'solo-test', clusterSize: 1, fretProfile: 'edge' })`. Use in-memory transports (loopback multiaddrs or the `memory` transport from `@libp2p/memory` / the existing `mesh-harness.ts` setup) so the test does not need real sockets.
- Builds a `NetworkTransactor` using the same `getRepo: (p) => p.toString() === node.peerId.toString() ? coordinatedRepo : RepoClient.create(...)` pattern used by `collection-factory.ts`.
- Executes `transactor.pend({ actionId, transforms: { 'optimystic/schema': <tiny insert> }})` with a short `timeoutMs` (e.g. 3000) so the failure is fast.
- Expected initial behavior (pre-fix): throws an aggregate error whose message includes `all candidates excluded`.
- Expected post-fix behavior: either (a) the pend succeeds, or (b) throws an error that clearly names the underlying cause (restoration timeout, not-responsible, etc.) — not "all candidates excluded".

Also add focused unit tests in `libp2p-key-network.spec.ts`:

- `findCoordinator: on solo bootstrap node, does not exclude self even after first-attempt failure`: construct a `Libp2pKeyPeerNetwork` with mock libp2p (no connections, empty FRET), call `findCoordinator(key, { excludedPeers: [selfPeerId] })` and assert it throws a **specific** error distinguishable from a regular "all-excluded" case — something like `Self-coordination exhausted on solo node (original cause not preserved). Check listenAddrs/transport and restoreCallback.` with a distinctive `error.code`.

### Phase 2 — Exclusion-set guard (Problem A)

Change `libp2p-key-network.ts:357-376`:

- When the last-resort block is reached and self IS in `excludedSet`, and `shouldAllowSelfCoordination()` would otherwise return `allow: true`:
  - If `networkHighWaterMark <= 1` (bootstrap node): ignore the exclusion of self and return self anyway IF this is the first excluded attempt; otherwise surface a distinct error code (`SELF_COORDINATION_EXHAUSTED`) so `NetworkTransactor` retry logic stops re-entering `findCoordinator`.
  - Prefer surfacing the distinct error. Do NOT silently re-return self — that would hide a real bug and cause infinite retry loops.

Also, in `network-transactor.ts` processBatches path: when the retry's `findCoordinator` throws `SELF_COORDINATION_EXHAUSTED` (or equivalent), don't swallow the original error as root. Keep the first attempt's error as `root:` — e.g. stash it in `batch.error` and reference it from the aggregate.

Simplest mechanical fix: in `processBatches` (`batch-coordinator.ts:126-147`), if `findCoordinator(...)` inside the catch throws, DON'T replace the original batch error — keep it accessible. Today the original `e` is rethrown at line 146 but only after failed retry; the aggregate in network-transactor re-queries `error` via the outer `try/catch` which captures whatever `processBatches` last threw. Switch the aggregate to use the ORIGINAL per-batch error, not the last retry's error, when both exist.

### Phase 3 — Diagnose & fix Problem B using the test

With the reproducing test from Phase 1 and the error-preservation fix from Phase 2, re-run the test and read the real underlying error. Likely outcomes:

- If the error is a restoration hang → short-circuit `restoreCallback` when the node has `networkHighWaterMark <= 1` AND no connected peers. Return `undefined` immediately instead of dialing. This also needs to happen in `BlockStorage` or in `RestorationCoordinator` — whichever is cheaper to change. Add a test that confirms restoration returns `undefined` fast on a solo node.
- If the error is `Not responsible for block(s): optimystic/schema` → ensure `findCluster` always includes self (it does today at `libp2p-key-network.ts:407`, but double-check for the schema-block path); alternatively, make `isResponsibleForBlock` return `true` when `peers` is empty OR contains only self.
- If the error is something else entirely → file a follow-up ticket.

### Phase 4 — Verify end-to-end in reference-peer

`packages/reference-peer/test/quick-test.ts` exercises a similar solo flow. Extend or add a new quick-test variant that uses `listenAddrs: []` and runs a DDL-equivalent tree create. Expected: success (or graceful error) within a few hundred ms, not a 30s timeout.

### Phase 5 — Docs

- Update `packages/db-p2p/README.md` with a short "Solo / mobile nodes" section explaining the expected behavior for bootstrap-mode nodes with no remote connectivity, and the self-coordination guarantee.
- Confirm whether mobile apps *should* set `listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws']` as a workaround on RN; if yes, document it; if no (because the fix makes empty listen addrs fully supported), state that explicitly.

## Out of scope

- Moving cluster-coordinator RPCs to a non-libp2p path (already done via `isLocal` short-circuit).
- Any change to FRET behavior. If FRET-related assumptions turn out to be wrong, open a separate ticket.
- Mobile-specific ticket work in `sereus-health/` — those are on the app side and only consume the fixed API.

## TODO

Phase 1 (tests-first):
- Add `packages/db-p2p/test/solo-node-self-coord.spec.ts` with the full-stack reproducer (NetworkTransactor + createLibp2pNode with empty listenAddrs and no bootstrap).
- Add `findCoordinator` unit tests to `libp2p-key-network.spec.ts` covering: solo-bootstrap retry with self in excludedSet, expected distinct error.
- Run the suite and confirm the reproducer fails with the documented error message before any fix is applied.

Phase 2 (error preservation + exclusion guard):
- In `libp2p-key-network.ts:findCoordinator`, introduce a distinguishable error (class or `error.code`) for the "self-excluded-on-solo-node" case and throw it from the last-resort branch.
- In `batch-coordinator.ts:processBatches`, keep the ORIGINAL per-batch error on the batch (e.g. `batch.request` retains the first error via Pending), and in `network-transactor.ts:formatBatchStatuses` / aggregate construction, prefer the first error as `root:` instead of the latest.
- Add a unit test proving the aggregate error now shows the real first-attempt cause, not `all candidates excluded`.

Phase 3 (root cause):
- Re-run the Phase 1 reproducer. Read the now-preserved real root cause.
- Fix whichever of Problem B.1 / B.2 / B.3 the test surfaces. Write a targeted test for that path and re-run.
- Re-run the full-stack reproducer; expect success (or a clear, specific error the caller can act on).

Phase 4 (end-to-end):
- Add/extend a `reference-peer` test scenario with `listenAddrs: []` solo DDL.
- Run the mobile RN app (`sereus-health/apps/mobile`) through the boot → addStrand → LogHistory flow and confirm the DDL deadlock is gone. Note: if RN environment is unavailable to the implementer, this verification step transfers to the review ticket.

Phase 5 (docs):
- Update `packages/db-p2p/README.md` with the solo-node section.
- Bump/note in CHANGELOG if one exists in the package.
