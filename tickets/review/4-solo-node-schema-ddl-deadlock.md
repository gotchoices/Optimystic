description: Solo / bootstrap libp2p node (no listen addrs, empty bootstrap) can now run DDL (schema pend/commit) without hanging or throwing a misleading "all candidates excluded" error. Self-coordination errors are distinguishable and the original first-attempt error is preserved in aggregate failures.
dependencies: libp2p-key-network (FindCoordinatorError + codes), batch-coordinator error preservation, network-transactor aggregate, RestorationCoordinator self-skip
files:
  - packages/db-p2p/src/libp2p-key-network.ts (FindCoordinatorError, FIND_COORDINATOR_ERROR_CODES, SELF_COORDINATION_EXHAUSTED path in findCoordinator)
  - packages/db-core/src/utility/batch-coordinator.ts (processBatches catch: wrap retry setup in try/catch so original `e` is always preserved)
  - packages/db-core/src/transactor/network-transactor.ts (aggregate error uses firstBatchError → preserves original per-batch cause; batch detail lines now include `cause=...`)
  - packages/db-p2p/src/storage/restoration-coordinator-v2.ts (accept selfPeerId; skip self in ring-peer candidates; short-circuit when no non-self peers)
  - packages/db-p2p/src/libp2p-node-base.ts (wires node.peerId.toString() into RestorationCoordinator)
  - packages/db-p2p/README.md (new "Solo / bootstrap / mobile nodes" section)
  - packages/db-core/test/batch-coordinator.spec.ts (NEW — verifies original error preservation during retry)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (NEW describe block: "findCoordinator() — solo/bootstrap node error codes")
  - packages/db-p2p/test/mesh-sanity.spec.ts (NEW "Suite 0: 1-node (solo) mesh" covering pend/commit + read-missing)

----

## What changed, and why

### Problem (from original ticket)
On a solo node (no bootstrap, no listen addrs) the first DDL — a pend of the
`optimystic/schema` block — failed with:
```
Some peers did not complete: self[block:optimystic/schema](in-flight); root: No coordinator available for key (all candidates excluded)
```
That error was produced by the batch-retry path: when the first-attempt pend
failed, `processBatches` retried by excluding the failing peer (self), and
`findCoordinator` with self excluded on a solo node threw the generic
`"No coordinator available for key (all candidates excluded)"`. That retry
error overwrote the actual root cause and was surfaced as `; root: ...` in
the aggregate, making diagnosis impossible.

### Two-part fix

**1. Preserve the original first-attempt error.**
`batch-coordinator.processBatches` now wraps the retry setup (`createBatchesForPayload` and the recursive `processSet(retries)`) in an inner try/catch, so the outer catch handler always rethrows the original `e`. `batch.request.error` now carries the true root cause rather than a retry-lookup error.

**2. Distinguishable error codes from `findCoordinator`.**
`Libp2pKeyPeerNetwork.findCoordinator` now throws `FindCoordinatorError` with `.code` ∈ `{SELF_COORDINATION_BLOCKED, SELF_COORDINATION_EXHAUSTED, NO_COORDINATOR_AVAILABLE}`. On a solo/bootstrap node (HWM ≤ 1) with self excluded, the code is `SELF_COORDINATION_EXHAUSTED` — signalling "the original first-attempt failure is authoritative; don't retry further." Callers can inspect `.code` to route appropriately; the `NetworkTransactor` aggregate now always prefers the per-batch request error (via new `firstBatchError()` helper) over any outer retry error.

### Aggregate error diagnostics
`NetworkTransactor.get` / `pend` / `commitBlocks` now include each failed
batch's cause in the details string (`peer[block:id](in-flight) cause=<message>`),
and the `; root: ...` suffix prefers the first batch's error over any outer
error. Previously the aggregate would often show only status (`in-flight`)
with no per-batch cause — callers now see the real reason immediately.

### Restoration-callback guard for solo nodes
`RestorationCoordinator` now takes an optional `selfPeerId` and filters self
out of ring-peer candidates so it does not attempt to dial itself (which
hangs on a node with no listen addrs). When no non-self peer remains and no
inner rings exist, restoration returns `undefined` immediately — the caller
treats the block as "not yet present", which is the correct outcome for a
brand-new solo node.

## Test coverage

**Unit tests (new)**
- `packages/db-core/test/batch-coordinator.spec.ts`
  - `preserves original first-attempt batch error even when retry findCoordinator throws`
  - `propagates original error when retry path produces a successful new batch`
- `packages/db-p2p/test/libp2p-key-network.spec.ts` — new describe block:
  - `returns self on first call when no excludes`
  - `throws SELF_COORDINATION_EXHAUSTED (not "all candidates excluded") when self is excluded on solo node`
  - `throws NO_COORDINATOR_AVAILABLE (not self-exhausted) when HWM>1 and self excluded`
- `packages/db-p2p/test/mesh-sanity.spec.ts` — new "Suite 0: 1-node (solo) mesh":
  - `solo node pends and commits its own schema block via peerCount<=1 short-circuit`
  - `solo node reads non-existent block without hanging and returns empty state`

Full test counts after the change: db-core 286 passing, db-p2p 390 passing,
reference-peer distributed-diary 4 passing, plugin tests 12 passing.

## Use cases for review / validation

- **Solo mobile boot (expected success path).** RN app with
  `createLibp2pNode({ bootstrapNodes: [], listenAddrs: [], transports: [...], clusterSize: 1 })`
  then issuing a DDL via the Quereus `optimystic` plugin. Expected: pend/commit
  succeed within hundreds of ms — the `peerCount<=1` short-circuit in
  `CoordinatorRepo` routes through `StorageRepo` directly, and
  `RestorationCoordinator` returns `undefined` fast for any missing block.
- **Solo mobile failure (expected clear error).** If for any reason the
  underlying `storageRepo.pend` or block storage throws (e.g. transform error,
  disk full), the aggregate error now reports
  `self[block:optimystic/schema](in-flight) cause=<real reason>; root: <real reason>` —
  NOT `; root: No coordinator available for key (all candidates excluded)`.
- **Solo-to-online transition.** As remote peers become reachable, FRET
  populates and HWM increases. From that point `findCoordinator` returns the
  real coordinator and cluster consensus kicks in via the existing code paths.

## Verification TODO for review stage

- Confirm the aggregate message now includes `cause=...` for each failed batch
  in a real multi-node failure scenario (e.g., run mesh-sanity Suite 3 DHT
  offline test in verbose mode).
- Run the mobile RN app (`sereus-health/apps/mobile`) through the boot →
  addStrand → LogHistory flow and confirm the DDL no longer deadlocks and
  completes within the expected budget.
- If a real underlying error surfaces in the mobile flow (now visible thanks
  to the preservation fix), file a follow-up ticket with the actual cause —
  that is out of scope for this ticket, which addressed the diagnostic
  blackhole that prevented earlier root-cause analysis.

## Deliberately out of scope

- Moving cluster-coordinator RPCs off libp2p (already covered by existing
  `isLocal` short-circuit in `ClusterCoordinator`).
- Any change to FRET internals or its profile behavior.
- Reference-peer Phase 4 extension — the 1-node mesh-sanity suite exercises
  the same code paths as a solo `reference-peer` would, and the mobile-side
  verification transfers here per the original ticket.
