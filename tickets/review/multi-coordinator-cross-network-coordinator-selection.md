description: Two databases sharing the same machines could pick a coordinator that belongs to the wrong database and can't speak its protocol, so writes failed; coordinator/cohort selection now only considers peers that actually serve the writing database's network. Review the fix and its tests.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (the fix: ctor protocolPrefix param, membershipOf/filterByMembership/getPeerStoreProtocolsByPeer helpers, findCoordinator scoping, findCluster over-fetch + scoping, NO_NETWORK_COORDINATOR error code)
  - packages/db-p2p/src/libp2p-node-base.ts (production wiring — passes protocolPrefix into Libp2pKeyPeerNetwork at L501-ish)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (8 new unit tests in the "network-membership scoping (protocolPrefix)" describe block; createMockLibp2p extended with peerStore)
  - packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts (new two-network integration spec, gated on OPTIMYSTIC_INTEGRATION=1)
  - packages/db-p2p/docs/cluster.md (added "Network-Membership Scoping" bullet under Access Control)
difficulty: medium
----

# Review: scope coordinator / cohort selection to peers that serve the target network

## What the original bug was

When two control networks (`control-A`, `control-B`) run on the **same physical nodes / shared
bootstraps**, FRET's network-agnostic seeding admits a `control-B` peer into `control-A`'s routing
ring. A `control-A` write could then select that `control-B` peer as its second coordinator / cohort
member, fail to negotiate the `control-A` cluster/repo protocol on it (the peer never registered it),
collect only 1/2 promises, and surface as `Failed to get super-majority: 1/2 approvals ... could not
negotiate /optimystic/control-B/repo/1.0.0`.

The exploitable asymmetry: `identify` is network-namespaced, so a cross-network peer's identify never
completes here and its **peerStore protocol list stays empty forever** — a stable, local discriminator
between same-network and cross-network peers.

## What was implemented

All changes are in the db-p2p selection layer (`Libp2pKeyPeerNetwork`); FRET (separate portal repo)
was intentionally **not** touched.

- **Constructor**: optional final param `protocolPrefix?: string`. When absent the membership filter is
  a complete no-op (today's behavior — every existing call site keeps compiling and behaving the same).
  Production threads it in via `libp2p-node-base.ts`.
- **Membership classification** (`membershipOf` + `getPeerStoreProtocolsByPeer`): reads a peer's
  peerStore protocols → `serves` (advertises `${prefix}/cluster|repo/1.0.0`, or self), `foreign`
  (non-empty list but none for this network), or `unknown` (empty list / absent — a fresh same-network
  peer **or** a permanent cross-network contaminant; indistinguishable at an instant).
- **`findCoordinator`** (`filterByMembership`): drops `foreign`, ranks `serves` ahead of `unknown`
  (reputation order preserved within tier), self always eligible. Applied to both the FRET-neighbor
  pick and the connected-peer fallback. The existing 3×500ms retry window lets a fresh same-network
  peer flip from `unknown`→`serves` and win over a permanently-`unknown` cross-network peer.
- **`findCluster`** (the load-bearing path for the 2-of-2 write): **over-fetches** a wider proximity
  band from FRET (`membershipOverfetch() = max(clusterSize*4, clusterSize+16)`) so a cross-network peer
  sitting nearer the key cannot displace a legitimate same-network coordinator out of the nearest-
  `clusterSize` window; then keeps self + the nearest `serves` peers, dropping `foreign` always and
  backfilling `unknown` only while serving-incl-self is below `min(2, clusterSize)` (so a fresh single-
  network mesh is never starved below quorum).
- **Clearer failure**: new `FIND_COORDINATOR_ERROR_CODES.NO_NETWORK_COORDINATOR`, thrown when the
  candidate set empties because the only other peers were cross-network and self is excluded — instead
  of a generic `NO_COORDINATOR_AVAILABLE` / super-majority error.

### Why over-fetch is sufficient and consistent (key reviewer check)

`ClusterService.checkRedirect` scopes a member's "am I responsible?" decision against
**`record.peers`** — the cohort the coordinator already computed and embedded — *not* an independent
recomputation (see `cluster/service.ts:104-142`). So once the coordinator's `findCluster` produces
`{A1, A2}` and embeds it, A2 sees itself in `record.peers` and processes locally (no redirect), even
though A2's own polluted ring might rank `{A1, B1}`. **Confirm this invariant still holds** — it is the
reason a coordinator-side-only fix is correct and the member side did not need changes.

## How to validate

```
# from repo root
yarn build:db-core ; yarn build:db-p2p          # both exit 0

# from packages/db-p2p — fast unit suite (no integration)
yarn test                                        # 1053 passing, 37 pending

# the 8 new unit tests specifically
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-key-network.spec.ts" --grep "network-membership scoping" --reporter spec

# integration (real libp2p) — single-network regression + new two-network case
$env:OPTIMYSTIC_INTEGRATION=1
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/multi-coordinator-write.integration.spec.ts" "test/multi-coordinator-cross-network-write.integration.spec.ts" --reporter spec
# → 3 passing: existing 2 (single-network 2-of-2 still works) + new cross-network selection
```

All of the above were run green during implement. The integration specs are gated on
`OPTIMYSTIC_INTEGRATION=1`; the default `yarn test` skips them.

### Use cases the tests cover

- `findCoordinator` never returns a cross-network peer when a same-network peer (or self) is available.
- `findCoordinator` prefers self (`serves`) over a not-yet-identified cross-network peer.
- `findCoordinator` throws `NO_NETWORK_COORDINATOR` when the only candidate is foreign and self is excluded.
- `findCluster` excludes a cross-network member when a serving cohort exists; always drops `foreign`
  (even below the floor); backfills `unknown` when no serving peer exists (fresh mesh not starved).
- `protocolPrefix` **absent** → membership filtering is fully disabled (two regression guards).
- Integration: a `control-A` write selects A2, never the `control-B` node, and reaches 2-of-2, with an
  explicit assertion that A1's cohort never contains B1.

## Known gaps / honest flags for the reviewer (treat tests as a floor)

- **Over-fetch is a heuristic, not a guarantee.** If a ring is polluted by **more** cross-network peers
  nearer the key than the band width (`max(clusterSize*4, clusterSize+16)`), a legitimate serving peer
  could still be pushed out of the fetched pool. The real cure for heavy pollution is the **FRET-side
  eviction follow-up** (out of scope here; see ticket notes / file a backlog item). Reviewer may want to
  decide whether the band should scale with FRET's size estimate instead of a fixed multiple.
- **`findCoordinator` deliberately does NOT over-fetch** (only `findCluster` does) to avoid changing
  coordinator-proximity selection in large single-networks. Consequence: if a caller excludes self and
  the nearest `clusterSize` band is entirely `foreign`/`unknown` while a serving peer sits just beyond
  the band, `findCoordinator` may return an `unknown` peer or throw `NO_NETWORK_COORDINATOR` rather than
  reaching that farther serving peer. Judged acceptable (self is the usual safety net; the failing path
  was the cohort, not the coordinator) but worth a second opinion.
- **Transient exclusion of slow-to-identify legitimate peers.** A same-network peer whose identify
  hasn't completed at write time is `unknown` and, above the viability floor, transiently excluded from
  `findCluster`; it self-heals on retry once identify completes. For `clusterSize:2` (the floor is 2)
  this only bites once ≥1 other serving peer already exists.
- **FRET ring pollution itself is unfixed** (by design). B1 still lingers in A's ring and skews
  size/`d_max` estimates; only the *selection* is scoped, not ring admission.
- **Other construction sites unscoped.** `reference-peer/src/cli.ts` and the `quereus-plugin-optimystic`
  sites construct `Libp2pKeyPeerNetwork(node)` with no `protocolPrefix`, so the filter is disabled there
  (safe — behavior unchanged). If any of those ever run multi-network on shared nodes, they'd need the
  prefix threaded too.
- **Cohort-size note.** When scoping is active and a healthy network has fewer serving peers than
  `clusterSize`, `findCluster` returns a smaller (correct) cohort rather than padding with `unknown`
  contaminants; consensus already tolerates `clusterSize`±1 cohorts (`allowDownsize`). Confirm this does
  not interact badly with any min-absolute-cluster-size assertion in a specific deployment.

## Acceptance status

- [x] A `control-A` write only selects coordinators/cohort members that serve `control-A`; a
      cross-network peer is never chosen (unit + integration).
- [x] Single-network behavior unchanged when `protocolPrefix` is absent, and the existing single-network
      2-coordinator integration test still reaches 2-of-2.
- [x] Cross-network-only candidate set yields a clear `NO_NETWORK_COORDINATOR` signal.
- [x] `yarn build` (db-core → db-p2p) and `yarn test` (db-p2p) pass; downstream consumers
      (quereus-plugin-optimystic, reference-peer) still build.

## Non-goals (carried forward)

- FRET-side hardening (evict/never-admit peers that fail the network-namespaced protocol) — separate
  portal repo `C:/projects/Fret`; file as a backlog follow-up if pursued.
- Case (a) (relayed inter-coordinator stream reset) was handled separately as
  `multi-coordinator-write-relay-stream-reset`.
