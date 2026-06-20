description: Fix the repo-path redirect so it computes the responsible peer set the same way the cluster coordinator does, then turn the (currently disabled) repo redirect back on with a real multi-node test proving a redirected request still completes.
files: packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Reconcile repo-path redirect key derivation, then un-inert RepoService.checkRedirect

## Root cause (confirmed by reading the call chains)

The repo-path redirect double-hashes the routing key; the coordinator single-hashes it.
`getCluster`/`findCluster` **both already hash internally** — so the extra `sha256` in
`checkRedirect` is the entire bug.

**Coordinator path** (`packages/db-p2p/src/repo/cluster-coordinator.ts:87-90`
→ `packages/db-p2p/src/libp2p-key-network.ts:466-470`):
```
getClusterForBlock(blockId):
  blockIdBytes = encode(blockId)            // raw bytes
  keyNetwork.findCluster(blockIdBytes)
    └─ findCluster(key):
         coord = await hashKey(key)         // hashKey == sha256  → ONE hash of encode(blockId)
         cohort = fret.assembleCohort(coord, clusterSize)
```

**Repo redirect path** (`packages/db-p2p/src/repo/service.ts:179-181`
→ `packages/db-p2p/src/network/network-manager-service.ts:307-313`):
```
checkRedirect(blockKey):
  mh  = await sha256.digest(encode(blockKey))   // FIRST hash (the redundant one)
  key = mh.digest
  nm.getCluster(key)
    └─ getCluster(key):
         coord = await hashKey(key)             // SECOND hash → hashKey(sha256(encode(blockKey)))
         cohort = fret.assembleCohort(coord, targetSize)
```

So the coordinator assembles the cohort at FRET coordinate `hashKey(encode(blockId))`, while
the repo redirect assembles it at `hashKey(sha256(encode(blockKey)))` — a completely different
ring coordinate. `assembleCohort` returns the closest peers *to that coordinate*, so the two
cohorts are uncorrelated. A peer the coordinator legitimately routed a request to recomputes a
cohort for an unrelated coordinate, finds itself "not a member", and redirects the request away
— the "empty promises" regression class the cluster-path fix avoided.

`hashKey` is FRET's sha256 (verified against `RingHash` in
`packages/db-p2p/test/cohort-topic/coord-byte-compat.spec.ts`: byte-for-byte equal to sha256 at
256-bit ring width). Other call sites (`rebalance-monitor.ts`, `spread-on-churn.ts`,
`restoration-coordinator-v2.ts`, `libp2p-key-network.ts#getNeighborIdsForKey`) all pass
`encode(blockId)` raw into `hashKey` — the coordinator's convention is the established one. The
repo redirect is the lone outlier that pre-hashes.

## The fix

In `RepoService.checkRedirect` (`packages/db-p2p/src/repo/service.ts:179-181`) stop pre-hashing.
Pass the raw encoded block-key bytes into `getCluster`, letting the single internal `hashKey`
match the coordinator:
```
// before
const mh = await sha256.digest(new TextEncoder().encode(blockKey))
const key = mh.digest
const cluster = await nm.getCluster(key)

// after
const key = new TextEncoder().encode(blockKey)
const cluster = await nm.getCluster(key)
```
This makes the repo path `hashKey(encode(blockKey))` — identical to the coordinator's
`hashKey(encode(blockId))`. Drop the now-unused `sha256` import if nothing else in the file
uses it (it does not).

## Residual divergence to weigh during activation (do NOT skip this)

Aligning the hash fixes the *coordinate*. Two second-order differences remain between
`NetworkManagerService.getCluster` and `Libp2pKeyPeerNetwork.findCluster`, both of which feed
`fret.assembleCohort(coord, size)` but with different `size`/post-filtering:

- **Cohort size.** `getCluster` uses `targetSize = clamp(1, min(clusterSize, networkSizeEstimate))`
  (`network-manager-service.ts:310`); `findCluster` uses `clusterSize` exactly
  (`libp2p-key-network.ts:470`). Because `assembleCohort` returns distance-sorted peers, a
  smaller `targetSize` yields a *prefix* of the larger cohort. Direction matters: a boundary
  peer the coordinator included (full `clusterSize`) could be excluded by the repo's smaller
  `targetSize` cohort and still redirect. In a small mesh with `allowDownsize` this is usually
  moot (cohort ≈ all reachable peers), but the mesh test must actually exercise a cohort that is
  a *proper subset* of the mesh for the redirect to fire at all.
- **Self handling / fallback.** `findCluster` force-adds self and backfills peerStore addrs;
  `getCluster` does not force-add self (correct for a membership check — we want to know if FRET
  genuinely places self in the cohort) and has a non-FRET fallback path. Force-adding self is
  *not* wanted on the redirect path, so `getCluster`'s behavior is the right one here.

Recommended stance: the hash fix is the required correctness change; keep using
`getCluster` for the membership check (its no-force-self semantics are correct for redirect).
Treat the `targetSize` gap as a test-design constraint — size the mesh / `responsibilityK` /
`clusterSize` so the round-trip test proves a real redirect lands on a responsible peer. If the
implementer finds the `targetSize` gap causes spurious redirects in the mesh test, the fallback
is to route the membership check through the same `keyNetwork.findCluster` the coordinator uses
(keyNetwork is in scope at `libp2p-node-base.ts:707`); document the choice either way.

## Activation

In `libp2p-node-base.ts:397-416` the `repo:` wrapper currently forwards only
`{ logger, registrar, repo }` and carries a NOTE comment explaining the deferral. Mirror the
`cluster:` wrapper above it (lines 371-394):

- Forward `peerId: components.peerId` (so `getSelfId()` resolves).
- Forward `getConnectionAddrs` (the same connection-addr resolver the cluster wrapper uses) for
  redirect targets whose multiaddrs aren't otherwise known.
- Make `getNetworkManager()` resolve a live manager. Note the service-construction order: the
  `repo` service is registered (line 397) **before** `networkManager` (line 442), so
  `components.networkManager` may be undefined at repo-factory construction time. `checkRedirect`
  resolves the manager lazily at request time via `getNetworkManager()`, whose fallback reads
  `(components as any).libp2p?.services?.networkManager` (`service.ts:112-115`). So forward
  `libp2p: components.libp2p` and rely on that lazy fallback (resolves after all services exist),
  rather than passing a possibly-undefined `networkManager` value at construction. Verify in the
  mesh test that `getNetworkManager()` returns a real `NetworkManagerService` at request time.
- Remove the NOTE deferral comment.

## Test requirements

- Update `packages/db-p2p/test/redirect.spec.ts`: the `blockKeyDigest`/`digestMapKey` helpers
  (lines 18-35) currently key the stub network-manager map on `sha256(encode(blockKey))`, mirroring
  the old double-hash. After the fix, `checkRedirect` passes `encode(blockKey)` raw to
  `getCluster`, so the keyed-NM tests must key on `Array.from(encode(blockKey))` (drop the sha256
  step) to stay meaningful. The plain `makeNetworkManager` tests (single cluster regardless of key)
  are unaffected. Keep the existing `deriveBlockKey` and explicit-key `checkRedirect` assertions.
- Add a **running-mesh** round-trip test (not just the isolated unit test): a non-member node
  receives a repo op, redirects, the client follows the redirect (`repo/client.ts:83-98`,
  max 2 hops), the request reaches a responsible peer, and consensus/read still succeeds. The
  real-libp2p integration harness is the right home: `real-libp2p.integration.spec.ts` already
  spins multi-node TCP meshes via `spawnNode`/`createLibp2pNode` and reaches the repo through
  `(node as any).coordinatedRepo`. It is gated behind `OPTIMYSTIC_INTEGRATION=1` (`before()` skip),
  so it does not run in default `yarn test` — if the round trip must be covered by the default
  suite, build the equivalent over the existing in-memory/mock mesh harness instead. Pick a
  block whose cohort excludes the entry node (size `responsibilityK`/`clusterSize` so the cohort
  is a proper subset) so the redirect actually fires.
- `yarn build` + `yarn test` green in `packages/db-p2p`. If the round-trip test is integration-gated,
  note that explicitly in the review handoff and state how it was run (or that it was deferred to
  CI/human because it exceeds the agent idle-timeout budget).

## TODO

- [ ] In `service.ts#checkRedirect`, replace the `sha256.digest(encode(blockKey))` pre-hash with
      `new TextEncoder().encode(blockKey)` passed directly to `nm.getCluster`; drop the unused
      `sha256` import.
- [ ] In `libp2p-node-base.ts` `repo:` wrapper, forward `peerId`, `getConnectionAddrs`, and
      `libp2p` (for lazy `getNetworkManager()` resolution); remove the deferral NOTE comment.
- [ ] Update `redirect.spec.ts` keyed-NM helpers (`blockKeyDigest`/`digestMapKey`) to key on raw
      `encode(blockKey)` bytes; confirm all existing redirect/deriveBlockKey assertions still pass.
- [ ] Add the running-mesh redirect-then-reroute round-trip test (prefer the real-libp2p
      integration harness; note its `OPTIMYSTIC_INTEGRATION` gating). Size the mesh so a real
      redirect fires and the rerouted request completes consensus + read.
- [ ] Decide and document the `targetSize` residual-divergence stance (keep `getCluster`, or
      route through `findCluster`); ensure no spurious redirects in the mesh test.
- [ ] `yarn build` + `yarn test` green in `packages/db-p2p`; document how the mesh/integration
      test was exercised in the review handoff.
