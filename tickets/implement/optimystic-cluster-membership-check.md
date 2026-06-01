----
description: Re-enable a correct responsibility/membership check on the ClusterService update path and reconcile the dead cluster-size init knobs
files: packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/redirect.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/test/redirect.spec.ts
----

# Re-enable cluster membership/responsibility scoping on the update path

## Problem (root cause)

`ClusterService.handleIncomingStream` (`packages/db-p2p/src/cluster/service.ts:101-106`)
unconditionally calls `this.cluster.update(message.record)` for every `'update'`
message. The membership check that used to scope this is disabled behind a
`TEMPORARY` comment. As a result there is **no responsibility-based scoping of
consensus**: any peer that receives a cluster update participates in that key's
consensus regardless of whether it is one of the peers responsible for the key.

The downstream layer does not gate either. `ClusterMember.processUpdate`
(`packages/db-p2p/src/cluster/cluster-repo.ts:169-333`) validates message hash,
signatures and expiration (`validateRecord`, service.ts:416-430) but **never
checks that our own peerId is in `record.peers`** — when the phase is
`OurPromiseNeeded` (`getTransactionPhase`, cluster-repo.ts:512-529, triggered by
`!record.promises[ourId] && !hasConflict`) it adds our promise unconditionally.
So the ClusterService check is the *only* intended membership gate, and it is off.

### Why the original check was disabled (the "empty promises" symptom)

The historical check (see `git show 91167eb:packages/db-p2p/src/cluster/service.ts`)
recomputed the responsible cluster **independently** from the record:

```
tailId  = record.message.commit?.tailId ?? Object.keys(record.message.pend.transforms)[0]
key     = sha256(encode(tailId))
cluster = networkManager.getCluster(key)
isMember = cluster.some(p => peersEqual(p, selfId))
if (!isMember) response = encodePeers(cluster without self)   // redirect
else           response = cluster.update(record)
```

This diverged from how the **coordinator** actually formed the cluster, and so
even legitimately-addressed peers were handed a redirect instead of producing a
promise — the coordinator then collected too few promises ("empty promises").
Two concrete sources of divergence:

1. **Key-derivation mismatch.** The coordinator forms the cluster via
   `keyNetwork.findCluster(encode(blockId))` →
   `hashKey(encode(blockId))` → `assembleCohort` (see
   `cluster-coordinator.ts:87-98` `getClusterForBlock` and
   `libp2p-key-network.ts:466-520` `findCluster`). It uses the **raw blockId
   bytes**. The disabled check used `sha256(encode(tailId))` and
   `NetworkManagerService.getCluster` (`network-manager-service.ts:293-342`),
   i.e. an **extra sha256 step**. Same logical key, different coordinate → a
   different cohort → membership disagreements.
   The `tailId` extraction itself also had an operator-precedence bug
   (`a ?? b ? c : d` parses as `(a ?? b) ? c : d`).

2. **No small-mesh bypass / no trust in the coordinator's set.** Recomputing
   ignores `record.peers`, which the coordinator already computed and embedded.

The coordinator only ever dials the peers in `record.peers`
(`cluster-coordinator.ts:210-233` `executeTransaction` → `collectPromises(peers,
record)` where `peers === record.peers`). Therefore **every peer that legitimately
receives an update is, by construction, already in `record.peers`.**

## The reference pattern

`RepoService.checkRedirect` (`packages/db-p2p/src/repo/service.ts:139-164`) is the
shape to mirror: derive the responsible set, check self-membership, bypass on a
small mesh (`cluster.length < responsibilityK`), and return a
`RedirectPayload` (`repo/redirect.ts`, `encodePeers`) when not responsible. The
existing `ClusterClient.update` already **follows** redirect responses
(`cluster/client.ts:36-49`, with hop-limit + loop detection), so returning a
`RedirectPayload` from the cluster service requires no client-side change.

## Recommended fix

Make `record.peers` the **authoritative** membership source for the cluster
update path (NOT an independently-recomputed `getCluster`). This is consistent in
spirit with `checkRedirect` (same `RedirectPayload`/`encodePeers`/`smallMesh`/
`responsibilityK` shape and the same "redirect when not responsible" semantics)
while being **regression-proof against the empty-promises symptom**: a peer the
coordinator legitimately included is always in `record.peers`, so it is never
redirected.

Add a testable method on `ClusterService` analogous to `checkRedirect`:

```
checkRedirect(record: ClusterRecord): RedirectPayload | null {
  const selfId = this.getSelfId()          // from components.peerId
  if (!selfId) return null                  // can't scope without identity → process locally
  const peerIds = Object.keys(record.peers ?? {})
  if (peerIds.length === 0) return null      // nothing to scope against → process locally
  const isMember = peerIds.includes(selfId.toString())
  const smallMesh = peerIds.length < this.responsibilityK
  if (!smallMesh && !isMember) {
    const others = peerIds.filter(id => id !== selfId.toString())
    return encodePeers(others.map(id => ({
      id,
      addrs: record.peers[id]?.multiaddrs ?? this.getPeerAddrs(id)
    })))
  }
  return null
}
```

In `handleIncomingStream`'s `processStream`, for the `'update'` operation:
`const redirect = this.checkRedirect(message.record); response = redirect ?? await
this.cluster.update(message.record)`.

Notes / pitfalls for the implementer:
- Prefer `record.peers[id].multiaddrs` for redirect addrs (the coordinator already
  resolved them in `findCluster`); fall back to a `getConnectionAddrs`-style lookup
  if empty. This makes redirects actionable even when we have no live connection.
- **Do NOT** reintroduce an independent `getCluster(sha256(...))` recompute as the
  redirect decision — that is exactly what caused the empty-promises regression. If
  a defense-in-depth cross-check against a recomputed cohort is ever wanted (to
  defend against a coordinator that stuffs `record.peers` with non-cohort peers),
  it MUST use the coordinator's exact derivation (`keyNetwork.findCluster` /
  `getCluster` on the **raw** `coordinatingBlockIds[0]` bytes, no sha256) and must
  still never redirect a peer that is present in `record.peers`. Treat this as out
  of scope unless trivially safe; document if deferred.

## Wiring (currently missing)

`createLibp2pNode` builds the cluster service with only `{ logger, registrar,
cluster }` (`libp2p-node-base.ts:237-250`) — it does **not** forward `peerId`, so
`ClusterService` cannot identify itself. (For reference, the repo wrapper has the
same gap at `libp2p-node-base.ts:252-262`, which leaves `RepoService.checkRedirect`
inert in the real node wiring — `getNetworkManager()`/`getSelfId()` both return
`undefined`. The redirect unit tests in `test/redirect.spec.ts` pass `peerId`/
`networkManager` explicitly, so the logic is covered but never exercised in a live
node.)

- Extend `ClusterServiceComponents` with optional `peerId?: PeerId` (and, if the
  optional cross-check is implemented, `networkManager?: NetworkManagerLike` +
  `getConnectionAddrs?`), mirroring `RepoServiceComponents`
  (`repo/service.ts:22-31`).
- In `libp2p-node-base.ts` cluster wrapper, pass `peerId: components.peerId` (libp2p
  exposes `peerId` on the component registry) to the cluster service.
- While here, also forward `peerId`/`networkManager`/`getConnectionAddrs` to the
  **repo** wrapper so `RepoService.checkRedirect` is no longer inert. Keep this
  minimal; if it risks breaking live behavior, isolate it and note the deferral.

## Reconcile the dead init knobs

`ClusterServiceInit` advertises `kBucketSize`, `configuredClusterSize`,
`allowClusterDownsize`, `clusterSizeTolerance`, `responsibilityK`
(`cluster/service.ts:19-38`) and `createLibp2pNode` passes the first four +
`responsibilityK` (`libp2p-node-base.ts:238-244`), but the constructor
(`service.ts:56-64`) reads **none** of them.

- `responsibilityK` — make it **live**: read it in the constructor
  (`this.responsibilityK = init.responsibilityK ?? 1`) and use it for the
  `smallMesh` bypass above. Keep it in the init type.
- `configuredClusterSize`, `allowClusterDownsize`, `clusterSizeTolerance`,
  `kBucketSize` — consensus quorum / downsize policy is **already** governed
  elsewhere: `consensusConfig` flows into `ClusterMember` and `CoordinatorRepo`
  (`libp2p-node-base.ts:331-364`) and `NetworkManagerService`
  (`libp2p-node-base.ts:275-285`). The `ClusterServiceInit` copies are genuinely
  dead. **Remove** these four from `ClusterServiceInit` and stop passing them in
  the cluster wrapper (`libp2p-node-base.ts:240-242`) so the surface area no longer
  advertises no-op knobs. (Verify nothing else references
  `ClusterServiceInit.configuredClusterSize` etc. — a repo-wide grep showed only
  the node-base wiring.)

## Optional cleanup

The verbose `cluster-service:pre-serialize` / `post-serialize` diagnostic logging
(`service.ts:112-133`) was added while debugging the empty-promises issue. Once the
membership check is restored and tested, this block can be removed or reduced to a
single concise log line. Low priority; keep if it aids the implementer's debugging.

## Reproduction / test

There is currently **no** unit test for `ClusterService` (only
`test/redirect.spec.ts` covers `RepoService`). Add a sibling spec modeled on it:

- Construct a `ClusterService` with a stub `ICluster` whose `update` records that it
  was called and returns the record, plus `peerId` in components and an init
  `{ responsibilityK }`.
- Build a `ClusterRecord` with a `peers` map (use real Ed25519 peer ids via
  `generateKeyPair`/`peerIdFromPrivateKey`, as `redirect.spec.ts` does) and assert:
  - self **not** in `record.peers`, `peers.size >= responsibilityK` →
    `checkRedirect` returns a `RedirectPayload` with `reason: 'not_in_cluster'`,
    peers exclude self, and `this.cluster.update` is **not** called.
  - self **in** `record.peers` → `checkRedirect` returns `null` and the stub
    cluster's `update` **is** called (no empty-promises regression).
  - `peers.size < responsibilityK` (small mesh), self not a member →
    `checkRedirect` returns `null` (processed locally).
  - no `peerId` in components / empty `record.peers` → `null` (processed locally).
- Refactor the membership decision into the standalone `checkRedirect(record)`
  method (as above) so it is unit-testable without driving the lp-stream pipe.

Test runner: `cd packages/db-p2p && yarn test` (mocha via `register.mjs`). Stream
the output (`yarn test 2>&1 | tee /tmp/db-p2p-test.log`) — the suite includes
integration specs and can run long. To iterate quickly, target the new file:
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cluster-service-redirect.spec.ts"`.

## TODO

- [ ] Add optional `peerId` (and, if cross-check implemented, `networkManager`/
      `getConnectionAddrs`) to `ClusterServiceComponents`; read `responsibilityK`
      and self peerId in the `ClusterService` constructor.
- [ ] Implement `ClusterService.checkRedirect(record)` using `record.peers` as the
      authoritative membership source, with the `responsibilityK` small-mesh bypass,
      returning `encodePeers(...)` (reuse `repo/redirect.ts`).
- [ ] Replace the `TEMPORARY` unconditional `cluster.update` (`service.ts:101-106`)
      with `const redirect = this.checkRedirect(record); response = redirect ?? await
      this.cluster.update(record)`.
- [ ] Wire `peerId` into the cluster service in `libp2p-node-base.ts`; also forward
      `peerId`/`networkManager`/`getConnectionAddrs` to the repo wrapper to un-inert
      `RepoService.checkRedirect` (keep minimal; document if deferred).
- [ ] Remove the dead `kBucketSize`/`configuredClusterSize`/`allowClusterDownsize`/
      `clusterSizeTolerance` from `ClusterServiceInit` and the cluster wrapper args;
      confirm consensus quorum is unaffected (still driven by `consensusConfig`).
- [ ] Add `packages/db-p2p/test/cluster-service-redirect.spec.ts` covering member /
      non-member / small-mesh / no-identity cases (model on `test/redirect.spec.ts`).
- [ ] (Optional) Remove or trim the `pre-serialize`/`post-serialize` debug logging.
- [ ] Build + test: `cd packages/db-p2p && yarn build && yarn test 2>&1 | tee /tmp/db-p2p-test.log`.
