description: A safety check meant to reject clusters that are too small to be trusted currently lets them through whenever the node can't confidently estimate the network's size — fix it to refuse by default; also removes a redundant peer-directory lookup done twice per write.
files: packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig ~40-95), packages/db-p2p/src/repo/cluster-coordinator.ts (validateSmallCluster ~347-380; caller ~253), packages/db-p2p/src/libp2p-key-network.ts (findCluster ~585-627; getPeerStoreAddrsByPeer ~670; getPeerStoreProtocolsByPeer ~693), packages/db-p2p/src/repo/coordinator-repo.ts (~95-101), packages/db-p2p/src/libp2p-node-base.ts (~603-608), packages/db-p2p/src/testing/mesh-harness.ts (~143-148, ~258-262)
difficulty: medium
----

# validateSmallCluster fails open; hot-path double peerStore reads

Two independent fixes in the db-p2p cluster path. They don't overlap in code; do
both in one ticket.

## Background

A "cluster" is the small set of peers that must agree (super-majority) before a
write commits. If that set is too small, agreement is meaningless — a lone or
near-lone node can rubber-stamp its own writes. `minAbsoluteClusterSize` (default
3, but 2 in the node/test configs) is the floor below which a cluster is
considered unsafe.

---

## (a) validateSmallCluster fails open — correctness / security

### What happens

`executeTransaction` (`repo/cluster-coordinator.ts:253`) only calls
`validateSmallCluster` when `peerCount < this.cfg.minAbsoluteClusterSize`. So this
gate is the last line of defense for an undersized cluster.

`validateSmallCluster` (`cluster-coordinator.ts:347-380`) tries to justify the
small size using the FRET network-size estimator: if FRET has a confident
estimate (`confidence > 0.5`) and the observed size is within one order of
magnitude of the estimate, accept. Otherwise it falls through to:

```ts
// Fallback: accept small clusters in development/testing scenarios
log('cluster-tx:small-cluster-accepted-without-validation', { ... });
return true;
```

That fallback returns `true` — **admit** — whenever there is no confident
estimate. Estimator confidence at or below 0.5 is the *normal* state on a young or
churning network, so the "development/testing" carve-out is in fact the default
production path. It fails **open** exactly when it should fail **closed**.

### Fix

Add a config flag (default `false`) that gates the permissive fallback. When the
estimator gives no confident acceptance and the flag is off, return `false` so the
caller rejects the write.

Add to `ClusterConsensusConfig` (`db-core/src/cluster/structs.ts:40`):

```ts
/**
 * When FRET has no confident network-size estimate, allow an undersized cluster
 * (peerCount < minAbsoluteClusterSize) to proceed anyway. Default false: with no
 * confident estimate an undersized cluster is REJECTED. Turn on only for
 * single-node / local dev where you knowingly run below the safe floor.
 */
allowUnvalidatedSmallCluster?: boolean;
```

Change the fallback in `validateSmallCluster` to return
`this.cfg.allowUnvalidatedSmallCluster ?? false` instead of `true` (keep the log
line; it already records `reason: 'no-confident-network-size-estimate'`). The
FRET-confident acceptance branch (:352-366) is unchanged.

### Callers / defaults — IMPORTANT, don't skip

The gate only fires for `peerCount < minAbsoluteClusterSize`. With the flag
defaulting off, that path now **rejects** instead of admitting. Two config
composers set `minAbsoluteClusterSize: 2`, so any single-peer (peerCount 1) write
now hits the reject:

- `libp2p-node-base.ts:603-608` — production node config. Leave the flag **unset**
  (defaults false) so production fails closed. This is the intended behavior
  change: a genuinely single-node network can no longer silently self-approve.
- `mesh-harness.ts:143-148` and `:258-262` — test harness. Many integration tests
  spin up small/single-node meshes on purpose. Set
  `allowUnvalidatedSmallCluster: true` here (both config blocks) so existing tests
  that legitimately run below the floor keep working. If you leave it off, expect
  single-node harness tests to start failing with
  `Cluster size 1 below minimum 2 and not validated` — that's the gate doing its
  job, not a regression, but the harness's job is to opt into it.
- `coordinator-repo.ts:95-101` — default policy builder. Leave unset (false).

After wiring, run the db-p2p integration/spec suite and fix any fallout by adding
the flag where a test *intends* to run undersized — do NOT weaken the default.

---

## (b) Double peerStore read on the hot path — perf

### What happens

In `findCluster` (`libp2p-key-network.ts:556`), when `protocolPrefix != null`
(membership scoping active), each cohort member is read from the libp2p peerStore
**twice** on the per-pend / per-commit hot path:

- `:589` `getPeerStoreProtocolsByPeer(nonSelf)` → `store.get(pid)` for protocols.
- `:627` `getPeerStoreAddrsByPeer(ids)` → `store.get(pid)` again for addresses.

`ids` (the selected serving subset, :615) is always a subset of `nonSelf`, so
every finally-selected member is fetched from the peerStore twice. One
`store.get(pid)` returns a peer record carrying both `protocols` and `addresses`.

### Fix

Add a combined helper next to the two existing ones (`getPeerStoreAddrsByPeer`
~:670, `getPeerStoreProtocolsByPeer` ~:693) that does one `store.get` and returns
both fields, e.g.:

```ts
private async getPeerStoreRecordsByPeer(
  ids: string[]
): Promise<Record<string, { protocols: string[]; addrs: string[] }>>
```

Same shape as the two existing helpers: guard on `store?.get`, `Promise.all` over
ids, swallow per-peer errors (leave missing → absent from map).

In `findCluster`:
- In the scoped branch (`protocolPrefix != null`, :585-618), call
  `getPeerStoreRecordsByPeer(nonSelf)` once. Classify membership from
  `records[id]?.protocols` (feed into `membershipOf`, :594). Keep this record map.
- At the backfill (:627), when the record map exists, build `peerStoreAddrs` from
  it for `ids.filter(id => id !== selfId)` (reuse `records[id]?.addrs`) — no second
  peerStore read. When `protocolPrefix == null` (map not built), keep the existing
  single `getPeerStoreAddrsByPeer(ids...)` call (that path never double-read).

Leave `getPeerStoreProtocolsByPeer` in place — `filterByMembership` (:757) still
uses it for coordinator selection and is out of scope here. `getPeerStoreAddrsByPeer`
stays for the unscoped path. Net: scoped hot path drops from 2 reads/member to 1.

---

## TODO

- [ ] Add `allowUnvalidatedSmallCluster?: boolean` (documented, default false) to
      `ClusterConsensusConfig` in `db-core/src/cluster/structs.ts`.
- [ ] Change `validateSmallCluster` fallback to return
      `this.cfg.allowUnvalidatedSmallCluster ?? false` (keep log line).
- [ ] Set `allowUnvalidatedSmallCluster: true` in both `mesh-harness.ts` config
      blocks; leave `libp2p-node-base.ts` and `coordinator-repo.ts` unset (false).
- [ ] Add `getPeerStoreRecordsByPeer` (single `store.get`, returns
      `{ protocols, addrs }`) to `libp2p-key-network.ts`.
- [ ] Rewire `findCluster` scoped branch to fetch records once and reuse the addrs
      for backfill; unscoped branch unchanged.
- [ ] Test: low-confidence (or no FRET) + undersized cluster is **rejected** when
      the flag is off, and **admitted** when the flag is on. Add to
      `packages/db-p2p/test/cluster-coordinator.spec.ts` (or a sibling spec).
- [ ] Build + typecheck db-core and db-p2p; run the db-p2p test suite (stream
      output with `tee`) and reconcile any single-node harness failures by opting
      those tests into the flag — not by reverting the default.
