description: When two database networks run on the same physical machines, a write in one network can pick a coordinator that only belongs to the other network and can't speak the first network's protocol, so the write fails. Scope coordinator/cohort selection to peers that actually serve the writing network.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (Libp2pKeyPeerNetwork.findCoordinator / findCluster / getNeighborIdsForKey — the selection point to scope; ctor takes no networkName today)
  - packages/db-p2p/src/libp2p-node-base.ts (constructs Libp2pKeyPeerNetwork at L501; protocolPrefix `/optimystic/<networkName>` computed at L503; identify is network-namespaced at L362-364)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (mock-libp2p + mock-fret unit harness; findCluster peerStore-backfill test at L625 is the pattern to extend)
  - packages/db-p2p/test/multi-coordinator-write.integration.spec.ts (real two-node OPTIMYSTIC_INTEGRATION harness to fork for a two-network reproduction)
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts (seedFromPeerStore L666 / seedFromBootstraps L719 / peer:connect L249-279 — the network-agnostic store-seeding that admits cross-network peers; FRET-side hardening is an optional follow-up, NOT in scope here)
  - C:/projects/Fret/packages/fret/src/rpc/protocols.ts (makeProtocols — FRET protocols ARE network-namespaced; identify likewise)
difficulty: medium
----

# Scope coordinator / cohort selection to peers that serve the target network's protocol

## Problem (root cause — confirmed by code reading; not reproduced locally yet)

When two parties run **distinct control networks** (`control-<partyA>`, `control-<partyB>`) on the
**same physical nodes / shared bootstraps**, a write on network A can select, as a second coordinator
or cohort member, a peer that only serves network B. The coordinator then dials
`/optimystic/control-<partyA>/{cluster,repo}/1.0.0` on that peer, which never registered it, so the
dial **cannot negotiate a protocol**. The coordinator collects only its own promise (1/2), the
super-majority check fails, and it surfaces as:

```
Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)
  cause=Protocol selection failed - could not negotiate /optimystic/control-<partyB>/repo/1.0.0
  (also surfaces as FindCoordinatorError: NO_COORDINATOR_AVAILABLE)
```

### Why a cross-network peer is selectable

The selection set comes from FRET — `findCoordinator` → `getNeighborIdsForKey` → `fret.getNeighbors`,
and `findCluster` → `fret.assembleCohort` (`libp2p-key-network.ts`). FRET's routing store
(`DigitreeStore`) is seeded from **network-agnostic** libp2p sources:

- `seedFromPeerStore()` — every peer in the libp2p peerStore (`fret-service.ts:666`).
- `seedFromBootstraps()` — every configured bootstrap (`fret-service.ts:719`).
- `peer:connect` / `peer:discovery` event handlers (`fret-service.ts:249-279`).

None of these are scoped by `networkName`. Noise + yamux are network-agnostic, so a network-B node
that shares a bootstrap (or is mutually dialed) opens a real libp2p connection to a network-A node and
lands in network-A's peerStore. FRET upserts it into the ring, and it becomes a `getNeighbors` /
`assembleCohort` candidate for keys near its coordinate.

### The key asymmetry that makes a clean fix possible

`identify` is **network-namespaced**: `identify({ protocolPrefix: '/optimystic/<networkName>' })`
(`libp2p-node-base.ts:362-364`) makes this node's identify protocol `/optimystic/<networkName>/id/1.0.0`.
A cross-network peer registers a *different* identify protocol, so identify **never completes between
the two networks**. Consequences for a network-A node's peerStore:

- **Same-network peer** → identify completes → `peerStore.get(peer).protocols` contains the network's
  namespaced protocols (`/optimystic/<networkName>/cluster/1.0.0`, `.../repo/1.0.0`, `.../fret/1.0.0/...`).
- **Cross-network peer** → identify never completes → its `protocols` list stays **empty forever**.

So "does this peer serve network A's protocol?" is answerable locally from the peerStore, and the
answer is a stable, permanent discriminator between same-network and cross-network peers. That is the
signal the selection layer must consult.

## Fix: a network-membership filter at the db-p2p selection layer

Add the filter in `Libp2pKeyPeerNetwork` (the optimystic-repo layer, exactly where selection feeds the
dial), **not** in the Fret portal package. This is local, low-risk, and sits at the point of failure.

### Threading the network identity in

`Libp2pKeyPeerNetwork`'s constructor takes no network name today, and it is constructed in **many**
places, most as `new Libp2pKeyPeerNetwork(node)` (see all call sites: `libp2p-node-base.ts:501`,
`reference-peer/src/cli.ts:399`, several `quereus-plugin-optimystic` sites, and ~30 spec lines).
Add an **optional final** constructor parameter `protocolPrefix?: string` so every existing call site
keeps compiling unchanged. When it is **absent, the filter is disabled** (today's exact behavior —
required for backward compatibility, since most callers don't know the network name). The production
path (`libp2p-node-base.ts`) already computes `protocolPrefix` at L503 and MUST pass it.

### The membership predicate

A small async helper over the peerStore (mirroring the existing `getPeerStoreAddrsByPeer`):

```
peerServesNetwork(idStr): 'serves' | 'foreign' | 'unknown'
  // reads (libp2p.peerStore.get(peerId)).protocols
  // 'serves'  : protocols includes `${protocolPrefix}/cluster/1.0.0` OR `${protocolPrefix}/repo/1.0.0`
  //             (any network-namespaced protocol is sufficient; identify is itself namespaced)
  // 'foreign' : protocols is NON-empty but contains no `${protocolPrefix}/...` entry → another network
  // 'unknown' : protocols empty / peer absent → not yet identified (could be a fresh same-network peer
  //             OR a permanently-unidentifiable cross-network peer — indistinguishable at this instant)
```

The cross-network contaminant is `'unknown'`, **not** `'foreign'` (its protocol list is empty, not
mismatched). So the rule cannot be "drop foreign"; it must **prefer positively-serving peers** and
demote unknowns. The retry/stabilization window lets a genuine fresh same-network peer flip from
`'unknown'` to `'serves'`, while the cross-network peer stays `'unknown'` permanently — so over a
short window the two become distinguishable and the serving peer wins.

### Apply in `findCoordinator`

- Partition FRET candidates by membership. **Never** pick a `'foreign'` peer.
- Prefer `'serves'` candidates (rank them ahead of `'unknown'`); keep the existing reputation ordering
  within each tier.
- Fall back to `'unknown'` candidates only when no `'serves'` candidate exists this attempt — the
  existing 3×500ms retry loop gives identify time to complete, after which a same-network peer becomes
  `'serves'` and is chosen over the cross-network `'unknown'`.
- Self is always eligible (self trivially serves its own network).

### Apply in `findCluster`

`findCluster` must not regress the super-majority floor — there is an explicit comment at
`libp2p-key-network.ts:530-535` refusing to drop addressless members because shrinking below
`clusterSize` puts super-majority out of reach. The cross-network filter has the same hazard. Rule:

- Always keep self.
- Drop `'foreign'` members unconditionally.
- Build the cohort from `'serves'` members first. Only **backfill with `'unknown'` members** if the
  `'serves'` (+ self) count is below a viability floor (e.g. `< 2`, or `< clusterSize` — pick and
  document), so a freshly-formed legitimate single-network mesh whose members haven't all identified
  yet is never starved. In steady state a healthy same-network cohort is all `'serves'`, so the
  cross-network contaminant is simply excluded.
- Dropping a contaminant that was guaranteeing failure is strictly better: a `{self, foreignPeer}`
  cohort at `clusterSize:2` always failed 1/2; excluding `foreignPeer` lets the node fall back to a
  clear "no second network-A coordinator" outcome instead of a generic super-majority error.

### Clearer failure

When the membership filter is what empties the candidate set (i.e. the only other peers were
`'foreign'`/cross-network), surface a distinct signal rather than the generic
`NO_COORDINATOR_AVAILABLE` / super-majority error. Either a new
`FIND_COORDINATOR_ERROR_CODES` entry (e.g. `NO_NETWORK_COORDINATOR`) or at minimum a log line +
message naming "peer(s) do not serve this network's protocol", so the Sereus-style trace points at the
real cause. Match the existing `FindCoordinatorError` shape (`libp2p-key-network.ts:40-47`).

## Reproduction to build (first task)

Two layers; the unit test is the primary acceptance gate (fast, deterministic), the integration test
is the end-to-end confirmation.

**Unit (primary, in `libp2p-key-network.spec.ts`):** extend the existing mock-libp2p + mock-fret
harness. Give the mock libp2p a `peerStore.get` that returns a `protocols` array per peer (the
`findCluster` backfill test at L625 already mocks `peerStore.get` for addresses — add `protocols`).
Construct the network WITH a `protocolPrefix`. Have the mock fret return a mix: a same-network peer
(`protocols: ['/optimystic/netA/cluster/1.0.0', ...]`) and a cross-network peer (`protocols: []`).
Assert:
- `findCoordinator` never returns the cross-network peer when a same-network peer (or self) is available.
- `findCluster` excludes the cross-network peer from the returned cohort when a serving cohort exists.
- With `protocolPrefix` absent, behavior is unchanged (regression guard for all existing call sites).

**Integration (confirmation, gated on `OPTIMYSTIC_INTEGRATION=1`):** fork
`multi-coordinator-write.integration.spec.ts` into a two-network variant. Stand up nodes A1/A2 on
`networkName: 'control-A'` and B1 on `networkName: 'control-B'`, all sharing one bootstrap multiaddr
(or mutually dialed) so B1 enters A1's peerStore. Drive a `clusterSize:2` write on A1 for a block
whose coordinate sits near B1. Assert the write selects A2 (never B1) and reaches 2-of-2 — i.e. it no
longer fails with "could not negotiate /optimystic/control-B/...". Stream test output with `tee` per
the runner's idle-timeout rule.

## Acceptance

- A write targeting a network-A keyspace only ever selects coordinators / cohort members that serve
  network A's `cluster`/`repo` protocol; a peer from another network is never chosen for network A.
- Single-network behavior (the existing `multi-coordinator-write` integration test and all
  `libp2p-key-network.spec.ts` cases) is unchanged — no cohort shrinkage, no new flakiness when
  `protocolPrefix` is absent.
- When only cross-network peers remain, the failure is a clear "no network coordinator / peer does not
  serve this network" signal, not a generic `NO_COORDINATOR_AVAILABLE` / super-majority error.
- `yarn build` and `yarn test --workspace @optimystic/db-p2p` pass.

## Notes / non-goals

- **FRET-side hardening is out of scope here** (and lives in a separate portal repo,
  `C:/projects/Fret`). FRET still admits cross-network peers into its ring via the network-agnostic
  seeding above; it pings them over its network-namespaced protocol, fails, and applies failure
  scoring — but never evicts them, so they linger and skew ring/size estimates. A follow-up backlog
  item should make FRET evict (or never admit) a peer that fails protocol negotiation over the
  network-namespaced FRET protocol. The db-p2p selection filter in this ticket fixes the reported
  write failure independently of that; file the FRET hardening separately if pursued.
- Intersection with `cohort-topic-participant-coord-routing-key-mismatch` (backlog): that ticket's
  core mismatch is **resolved** (residual `d≥1` uniformity only) and is unrelated to cross-network
  scoping — no coordination needed beyond awareness.
- This is the case-(b) split from `multi-coordinator-write-stream-reset-supermajority`; case (a) (the
  relayed inter-coordinator stream reset) was handled separately as
  `multi-coordinator-write-relay-stream-reset`.

## TODO

### Phase 1 — selection-layer filter (the fix)
- Add optional final ctor param `protocolPrefix?: string` to `Libp2pKeyPeerNetwork`; store it; pass it
  from `libp2p-node-base.ts:501` (use the `protocolPrefix` already at L503). Filter is a no-op when absent.
- Add `peerServesNetwork(idStr)` helper over `peerStore.get().protocols` returning `serves`/`foreign`/`unknown`
  (model it on `getPeerStoreAddrsByPeer`); prefetch protocols for candidate ids in one `Promise.all`.
- `findCoordinator`: drop `'foreign'`, rank `'serves'` ahead of `'unknown'`, keep reputation ordering within tier,
  self always eligible; fall back to `'unknown'` only when no `'serves'` candidate exists.
- `findCluster`: keep self; drop `'foreign'`; prefer `'serves'`; backfill `'unknown'` only below a documented
  viability floor so a fresh single-network mesh is not starved.
- Add the clear cross-network failure signal (new `FIND_COORDINATOR_ERROR_CODES` entry or explicit message/log).

### Phase 2 — tests
- Extend `libp2p-key-network.spec.ts`: mock `peerStore.get` with `protocols`; assert cross-network exclusion in
  `findCoordinator`/`findCluster`, and unchanged behavior when `protocolPrefix` is absent.
- Add a two-network `OPTIMYSTIC_INTEGRATION` spec forked from `multi-coordinator-write.integration.spec.ts`;
  assert A-network write selects A2 (never the B-network node) and reaches 2-of-2.

### Phase 3 — validate
- `yarn build` (db-core → db-p2p).
- `yarn test --workspace @optimystic/db-p2p 2>&1 | tee /tmp/db-p2p-test.log` (stream output).
- Optionally run the new integration spec with `OPTIMYSTIC_INTEGRATION=1` if it stays under the idle-timeout
  budget; otherwise document the deferral for CI/human.
