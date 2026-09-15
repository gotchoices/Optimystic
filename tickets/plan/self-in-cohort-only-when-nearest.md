description: A machine that writes a block always keeps a copy and always appoints itself the coordinator, even when it is not one of the machines responsible for that block, so on real networks most blocks end up one responsible copy short with the spare copy sitting somewhere nobody looks. Change the rule so a machine is in a block's group only when it genuinely is one of the nearest, at every network size.
prereq: routing-key-single-encoding
files:
  - packages/db-p2p/src/libp2p-key-network.ts:972-1043 (`findCluster`: always unions self in; on the membership-scoped path builds `[self, ...nearest clusterSize−1 serving peers]`, so self reserves a slot; the unscoped path appends self as an extra)
  - packages/db-p2p/src/libp2p-key-network.ts:709-926 (`findCoordinator`: drops self from the FRET tier unless `shouldAllowSelfCoordination`; admits self at the last-resort tier on a deferrable denial; `NO_NETWORK_COORDINATOR`; the grace-period "Self-coordination blocked" refusal)
  - packages/db-core/src/transactor/network-transactor.ts:439 (`consolidateCoordinators`: greedy pick of the peer covering the most blocks, first-seen wins, so self always wins today)
  - packages/db-p2p/src/repo/coordinator-repo.ts:720-756 (`isResponsibleForBlock` and `verifyResponsibility` — vacuous today; become live; note `findCluster` throwing currently means "assume responsible")
  - packages/db-p2p/src/repo/coordinator-repo.ts:752 (the NOTE on `get` about soft-served reads acquiring replicas; re-read its condition once this lands)
  - packages/db-p2p/src/repo/coordinator-repo.ts:2107-2109,2534-2575 (the solo short-circuit when the derived cohort has at most one peer — must keep working for a node with no peers)
  - packages/db-p2p/src/repo/service.ts:229 (`checkRedirect` — after this change it sees writes for the first time)
  - packages/reference-peer/src/cli.ts:464 and packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:280 (production transactor wiring: self goes straight to the local coordinated repo, bypassing the redirect check — the coordinator for a block self is not responsible for must now be reached through `RepoClient`)
  - packages/db-p2p/src/testing (mesh harness key network adds self as an extra; must match production's new rule or the harness keeps modelling a different world)
  - docs/correctness.md:64 (the durability gate's remark that a coordinator outside `record.peers` is not a reconcile target — under this rule the coordinator is always inside the cohort by construction; update the prose)
  - packages/db-p2p/docs/cluster.md:786 ("only peers returned by findCluster participate" — becomes literally true)
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (write-side table: expect responsible-holder shortfall 0 of 24 and phantom copies 0 of 24)
difficulty: hard
----

# Decision (2026-09-14, maintainer)

Arm B of `blocked/writer-and-servers-disagree-on-where-a-block-lives`, decided as **option (b): self is in a block's cohort only when it is genuinely among the nearest `clusterSize` serving peers.** Option (a), "self as an extra copy", was rejected because it enshrines the assumption that the writer is a holder, which is exactly the assumption that fails once a network is wider than the replication factor, and which owner-aware placement and the sole-holder repair rule would both have to undo later.

The reason this rule is acceptable at small sizes: when the serving peers number at most `clusterSize`, the nearest `clusterSize` peers are all of them, self included. Every sereus deployment documented today (one phone, phone plus pod, parties up to seven under a strand width of four or a control width of sixteen) is in that regime, so this changes nothing for them. The "own writes now cost a network hop" cost is paid only where it is the correct cost.

# What this plan must settle

This is a plan ticket rather than an implement ticket because several paths were written assuming self is always present and each needs a decision, not just an edit.

1. **`findCluster` on both paths.** Scoped: `nonSelfTarget` becomes `clusterSize` nearest *serving* peers with self counted as a serving candidate on the same footing (self is "serving" iff this node registers the network's repo or cluster protocol). Unscoped: stop appending self. A node with no visible peers still yields a self-only cohort, which keeps the solo short-circuit intact.
2. **`consolidateCoordinators`.** Pick the coordinator from the union of the blocks' cohorts by coverage as today, but self is only a candidate when self is in a cohort. When self is not chosen, the pend goes over `RepoClient` to the chosen coordinator, which is the first time production writes pass through `RepoService.checkRedirect`. Decide how a pend that spans blocks with disjoint cohorts is batched (the ticket `debt-no-mesh-fixture-forces-two-coordinator-batches` in backlog has the background; production may now genuinely produce two batches).
3. **`findCoordinator`'s self-coordination logic.** Re-read `shouldAllowSelfCoordination`, the grace-period refusal, and the last-resort self admission against the new rule. Proposed: self-coordination is allowed exactly when self is in the block's cohort; the grace period applies only to the solo-cohort case (a node that just lost its last connection must not immediately declare itself a cohort of one). Say explicitly what a pure client node (registers no storage protocols) does when no coordinator is reachable: it must fail with `NO_NETWORK_COORDINATOR` rather than self-coordinate.
4. **`isResponsibleForBlock` failure mode.** Today a `findCluster` throw means "assume responsible". Under a live check that default turns a routing hiccup into an accepted write on the wrong node. Decide: fail closed on the write path, fail open on reads (which are best-effort anyway). GitHub #19 (2026-09-14) is today's default already causing user harm, independent of this ticket's rule change: with every cohort lookup throwing, a write passes the responsibility check, commits solo, and returns plain success, so two phones each kept only their own row with no error. The result-type half is the #19 arm of `plan/commit-result-carries-durability-class`.
5. **Durability gate and reconcile target.** `correctness.md:64` notes a coordinator outside `record.peers` is not a reconcile target. Under this rule the coordinator is inside the cohort by construction; state that as the invariant and add a guard that refuses to run a cluster transaction from a node not in the record's peer set.
6. **Harness parity.** The mesh harness key network must implement the same rule, and a spec should assert harness and production agree on cohort composition for the same ring (the divergence spec's fixture is a good base).
7. **Soft-served read replicas.** The NOTE at `coordinator-repo.ts:752` said to gate acquisition on `isResponsibleForBlock` if soft serves became routine. After arm A they should be rare again and after this ticket the gate is live; decide whether to add the gate or leave the NOTE with its condition re-stated.

# Edge cases & interactions

- Solo node, zero peers: cohort is self, short-circuit unchanged, single-signer proof unchanged.
- Two phones over a relay: both serve, both in every cohort, both required. Unchanged.
- Phone plus pod where the phone registers no storage protocols: the phone is never in a cohort; every write goes to the pod. Confirm the sereus "transaction-only profile" actually still registers the protocols (its docs say profile only changes the FRET edge/core choice), otherwise this is a behaviour change for sereus and needs a note in its architecture doc.
- Network wider than `clusterSize`: the writer's node is in a block's cohort for about `clusterSize / N` of blocks; the rest go remote. The integration spec at six nodes with width two should show roughly one third of blocks self-coordinated and every block on both responsible peers.
- Partition: a node that sees only itself derives a self-only cohort and commits solo. That is the downsizing leak recorded in `backlog/more-design/6.5-partition-healing.md` and is *not* fixed here; do not widen scope, but do not make it worse (the grace-period refusal is the existing mitigation).
- Coordinator-cache hints: a cached coordinator that is no longer in the cohort must be evicted rather than trusted; check `recordCoordinator` and the redirect-on-hint path.
- Reads: with the writer no longer a phantom holder, a read from the writer's own node for a block it does not hold goes remote. Confirm the local cache layer (`CacheSource`) still serves the writer's own recent writes for the session, or a write-then-read on the same node regresses to a network round trip.

# Tests to plan for

- Divergence integration spec write-side table: shortfall 0, phantom copies 0, redirect decisions on writes greater than 0.
- A unit spec that a non-serving node never appears in any cohort and never self-coordinates.
- A unit spec that on a ring no wider than `clusterSize`, every serving node is in every cohort (the small-network invariant).
- Harness-versus-production cohort parity spec.
- Sereus `strand-membership-closed-strand-e2e` and `harness-party-control-cohort` integration scenarios, run once against the branch.

# Arm found while landing routing-key-single-encoding (2026-09-15)

`findCoordinator` and `findCluster` choose from two different orderings of the same ring, so "the coordinator is inside the cohort" holds today only by coincidence. `findCluster` (and `NetworkManagerService.getCluster`, which `RepoService.checkRedirect` uses) take FRET's `assembleCohort`, which alternates successor and predecessor outward from the key's coordinate. `findCoordinator`'s FRET tier takes `getNeighborIdsForKey`, which is FRET's `getNeighbors(coord, 'both', clusterSize)`: all successors first, then predecessors, cut to `clusterSize` — so on any ring with at least `clusterSize` live members its candidates are successors only. The first entry is the same in both lists; the second is not. When self is the nearest successor and `findCoordinator` does not pick self on a write (its FRET tier drops self unless `shouldAllowSelfCoordination` allows it), the pick is the second successor, which the cohort may not contain.

Observed in `packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts` (six nodes, `clusterSize` 2): the writer's `findCoordinator` pick was outside the servers' cohort for 1 of 24 blocks on one run and 0 of 24 on another (the ring is random per run). The spec reports it as `writerPickOutsideCohort` and deliberately does not pin it. Today's cost is at most one redirect hop, and only on write paths that consult `findCoordinator` (a commit with no cached pend coordinator, a cancel, the `consolidateCoordinators` fallback when `findCluster` throws), because the writer's pends still self-coordinate. Once item 2 sends pends to remote coordinators, the same mismatch sits on the main write path.

Settle it with item 3: pick the coordinator from the same ordered cohort `findCluster` returns (after the same exclusions), not from a second FRET primitive, so the coordinator is inside the cohort by construction.
