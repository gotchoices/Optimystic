description: Two databases sharing the same machines could pick a coordinator from the wrong database that can't speak its protocol, so writes failed; coordinator/cohort selection now only considers peers that actually serve the writing database's network.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (the fix + review fix: cohort off-by-one corrected in findCluster, membershipOf JSDoc relocated, NO_NETWORK_COORDINATOR block re-indented)
  - packages/db-p2p/src/libp2p-node-base.ts (production wiring — passes protocolPrefix into Libp2pKeyPeerNetwork)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (8 implement-stage unit tests + 1 review-added cohort-size regression test)
  - packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts (two-network integration spec, gated on OPTIMYSTIC_INTEGRATION=1)
  - packages/db-p2p/docs/cluster.md ("Network-Membership Scoping" bullet under Access Control)
difficulty: medium
----

# Completed: scope coordinator / cohort selection to peers that serve the target network

## Summary of the delivered change

When two control networks (`control-A`, `control-B`) run on the same physical nodes / shared
bootstraps, FRET's network-agnostic seeding admits a cross-network peer into the other network's
routing ring. A write could then select that peer as a second coordinator / cohort member, fail to
negotiate the network-namespaced cluster/repo protocol on it, and stall below super-majority.

The fix scopes `Libp2pKeyPeerNetwork` selection to peers that serve THIS network's
`${protocolPrefix}/cluster|repo/1.0.0` protocol:

- Optional `protocolPrefix` ctor param (absent → filter is a no-op, exact legacy behavior). Production
  threads `/optimystic/<networkName>` in via `libp2p-node-base.ts`.
- Peers classified `serves` / `foreign` / `unknown` from their peerStore protocol list.
- `findCoordinator` drops `foreign`, ranks `serves` ahead of `unknown`; self always eligible.
- `findCluster` over-fetches a wider proximity band, keeps self + nearest serving peers, drops
  `foreign`, backfills `unknown` only below a small viability floor.
- New `NO_NETWORK_COORDINATOR` error code for the cross-network-only-and-self-excluded case.

The fix is coordinator-side only; `ClusterService.checkRedirect` scopes members against the
coordinator's embedded `record.peers`, so members need no change.

## Review findings

I read the implement diff (`7406b69`) with fresh eyes before the handoff summary, traced the FRET
`assembleCohort` source in `C:/projects/Fret`, confirmed the registered protocol strings, ran the full
unit suite and the gated integration suite, and checked the load-bearing invariants.

### What was checked

- **Correctness of the cohort-sizing math** (`findCluster`) — **found a real regression, fixed inline.**
- **The `checkRedirect` coordinator-side-only invariant** (`cluster/service.ts:120-142`) — confirmed: it
  scopes against `record.peers` (the coordinator's embedded cohort), not an independent recomputation,
  so an embedded member never redirects itself. The coordinator-only fix is sound.
- **Protocol-string match** — `membershipOf` checks `${prefix}/cluster|repo/1.0.0`; `ClusterClient`/
  `ClusterService`/repo `client`/`service` all register exactly `${protocolPrefix}/{cluster,repo}/1.0.0`,
  and `libp2p-node-base` passes the same `/optimystic/<networkName>` prefix to both the services and the
  key network. Match confirmed — no silent mismatch that would mark every same-network peer `foreign`.
- **Backward compatibility** — with `protocolPrefix` absent, `membershipOf` returns `serves` for all and
  both `filterByMembership`/`findCluster` short-circuit; two regression-guard unit tests cover this.
- **Docs** — the `cluster.md` "Network-Membership Scoping" bullet accurately describes the behavior
  (and, post-fix, its "nearest-`clusterSize` cohort" wording now matches the actual cohort size).
- **Type safety / resource handling** — peerStore access is duck-typed exactly like the pre-existing
  `getPeerStoreAddrsByPeer`, errors swallowed to degrade to `unknown`; no leaks.

### Major finding (fixed inline — contained off-by-one, now unit + integration covered)

**`findCluster` produced `clusterSize + 1`-member cohorts in any network larger than the cluster.**
FRET's `assembleCohort` seeds and returns **self** when self is near the key (the coordinator case;
verified in `fret-service.ts` `seedFromPeerStore` + `cohort.ts`). The unscoped path therefore yields
`clusterSize` members (self among the nearest). The new scoped path filtered self out, then took
`serves.slice(0, clusterSize)` non-self peers and **always added self on top** → `clusterSize + 1`.

Because production always sets `protocolPrefix`, every multi-node production cluster was affected, not
just multi-network ones. Impact: super-majority is `Math.ceil(peerCount * threshold)`
(`cluster-repo.ts:596`), so for `clusterSize:2, threshold:0.67` the cohort grew from 2 (→ 2-of-2) to 3
(→ `ceil(3*0.67)=3`, i.e. 3-of-3), requiring one extra node reachable for every write — an availability
regression contradicting the configured `clusterSize`. (`clusterSize:1` was also inflated to 2.)

**Fix:** reserve self's slot — take the nearest `clusterSize - 1` serving peers (and backfill `unknown`
to the same `clusterSize - 1` target below the viability floor), so a healthy same-network cohort lands
at exactly `clusterSize`. Disposition: fixed inline rather than filed as a new ticket because the change
is a one-line target adjustment, the behavior is now pinned by a direct unit test, and shipping the
ticket with a known cohort-size regression in the production path would be worse than fixing it here.

Added regression test: *"findCluster sizes the cohort to clusterSize (self counts toward it) when more
serving peers are available"* — red before the fix (cohort 3), green after (cohort 2).

### Minor findings (fixed inline)

- **Orphaned JSDoc**: the `membershipOf` doc block was sitting above `membershipOverfetch` (which had its
  own doc), leaving `membershipOf` undocumented and `membershipOverfetch` double-documented. Relocated
  the block onto `membershipOf`.
- **Broken indentation**: the `NO_NETWORK_COORDINATOR` block in `findCoordinator` was indented one tab
  too deep (cosmetic; `tsc` is unaffected). Re-indented to match the surrounding scope.

### Verified empty categories

- **Error-path coverage**: adequate. `NO_NETWORK_COORDINATOR` is unit-tested; `foreign`-always-dropped,
  fresh-mesh-backfill, and protocolPrefix-absent no-op are all covered. Nothing missing here.
- **No new test gaps introduced by the fix**: the single-network and cross-network integration specs
  both still produce 2-member cohorts (each has only one other serving peer), and both pass.

### Carried-forward (not defects — documented non-goals, intentionally NOT actioned)

These were explicitly scoped out by the implement ticket and remain accurate limitations, not bugs in
the delivered work, so no new tickets were filed:

- **FRET-side ring eviction** (separate repo `C:/projects/Fret`): cross-network peers still pollute the
  ring; only *selection* is scoped, not *admission*. Over-fetch is a heuristic that fails under
  pollution heavier than `max(clusterSize*4, clusterSize+16)` peers nearer the key. This is the real
  cure for heavy pollution and is a cross-repo follow-up; left as a non-goal.
- **`findCoordinator` does not over-fetch** (only `findCluster` does), so a serving peer just beyond the
  nearest `clusterSize` band can be missed when self is excluded — documented tradeoff; self is the
  usual safety net.
- **Other construction sites** (`reference-peer/src/cli.ts`, `quereus-plugin-optimystic`) build
  `Libp2pKeyPeerNetwork` without a prefix → filter disabled (safe; behavior unchanged). Would need the
  prefix threaded only if they ever run multi-network on shared nodes.

## Validation

- `yarn build:db-core` / `yarn build:db-p2p` — exit 0.
- `yarn test` (db-p2p) — **1054 passing, 37 pending** (1053 baseline + 1 review-added regression test).
- Scoping describe block — **9 passing** (8 implement + 1 review-added).
- `OPTIMYSTIC_INTEGRATION=1` integration specs (`multi-coordinator-write` + `…-cross-network-write`) —
  **3 passing**: single-network 2-of-2 (×2) and the new cross-network selection.
- Lint: not configured at the repo (`"lint": "echo 'Lint not configured for all packages'"`); the
  TypeScript build is the type-check gate and passes.

## Acceptance status

- [x] A `control-A` write only selects coordinators/cohort members that serve `control-A`; a
      cross-network peer is never chosen (unit + integration).
- [x] Single-network behavior unchanged when `protocolPrefix` is absent; existing single-network
      2-coordinator integration still reaches 2-of-2.
- [x] Cross-network-only candidate set yields a clear `NO_NETWORK_COORDINATOR` signal.
- [x] **Cohort size is exactly `clusterSize` in populated networks (review fix), preserving the intended
      super-majority threshold** — previously inflated to `clusterSize + 1`.
- [x] `yarn build` (db-core → db-p2p) and `yarn test` (db-p2p) pass; downstream consumers build.
