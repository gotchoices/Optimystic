description: Reconcile RepoService.checkRedirect's key derivation (sha256(blockKey)) with the coordinator's findCluster(encode(blockId)) raw-bytes derivation, then activate the inert repo-path redirect.
files: packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/redirect.spec.ts
----

# Reconcile repo-path redirect key derivation, then un-inert RepoService.checkRedirect

## Background

`RepoService.checkRedirect` (membership/responsibility scoping on the **repo** request
path) is currently inert in a live node: `libp2p-node-base.ts` deliberately does **not**
forward `peerId`/`networkManager`/`getConnectionAddrs` into the repo service wrapper, so
`getNetworkManager()` returns `undefined` and `checkRedirect` short-circuits to `null`
(process locally). A code comment at the repo wrapper documents this deferral.

This was deferred out of the `optimystic-cluster-membership-check` ticket (which restored
the *cluster*-path gate by trusting the coordinator-embedded `record.peers`). The repo
path has no equivalent authoritative peer set in the message, so it recomputes the cohort
— and that recomputation diverges from the coordinator's.

## The divergence (the core bug to fix)

- `RepoService.checkRedirect` (`packages/db-p2p/src/repo/service.ts:143-145`) derives the
  responsible set as:
  ```
  const mh = await sha256.digest(encode(blockKey))   // extra sha256 over the raw bytes
  const cluster = await nm.getCluster(mh.digest)
  ```
- The coordinator forms the cluster (`packages/db-p2p/src/repo/cluster-coordinator.ts:87-90`)
  as:
  ```
  const blockIdBytes = encode(blockId)               // raw bytes, NO sha256
  const peers = await this.keyNetwork.findCluster(blockIdBytes)
  ```

Because one path hashes the key bytes and the other does not, `getCluster(sha256(...))`
can return a different cohort than the coordinator actually used. If the repo redirect
were activated as-is, a peer the coordinator legitimately routed to could redirect the
request away — the same "empty promises" failure class that the cluster-path fix was
created to avoid (a non-member-by-recomputation rejecting a legitimately-routed request).

## Requirements / expected behavior

- Repo-path membership scoping must use the **same key coordinate** the coordinator/
  key-network uses to form the cluster, so that a peer legitimately routed a request is
  never seen as a non-member by its own recomputation. Concretely: either both sides hash
  or neither does — pick one derivation and make `RepoService.checkRedirect`,
  `nm.getCluster`, and the coordinator's `findCluster` agree on it. (Confirm whether
  `getCluster` already hashes internally before changing call sites — the fix must not
  introduce a *second* divergence.)
- Once the derivation is reconciled and proven consistent, forward `peerId` /
  `networkManager` / `getConnectionAddrs` into the repo service wrapper in
  `libp2p-node-base.ts` (remove the deferral comment) so `RepoService.checkRedirect`
  becomes live.
- Activation must be covered by a running-mesh test that asserts a redirect-then-reroute
  round trip actually completes (a non-member redirects, the request reaches a responsible
  peer, and consensus/read still succeeds) — not just the isolated `checkRedirect` unit
  test that exists today (`test/redirect.spec.ts`).
- No regression to the cluster path or to existing repo behavior; full `yarn build` +
  `yarn test` green in `packages/db-p2p`.

## Notes

- This is a latent issue, not an active bug: the repo redirect is inert today, so nothing
  currently misbehaves. It is filed in backlog because activating it is a discrete unit of
  design + regression work, and doing it incorrectly re-introduces a known regression class.
- Do **not** un-inert the repo path without first fixing the derivation mismatch.
