description: A machine used to put itself into every block's replica group and pick itself as the coordinator even when it was not among the machines responsible for that block. The network layer now derives both the replica group and the coordinator pick from one ordered list of the nearest responsible machines, so a machine is in a block's group only when it genuinely belongs there.
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`ServingCohort`, `assembleServingCohort`, `selfServes`, `servesThisNetwork`, `membershipOf`, `filterByMembership`; `findCluster`; `findCoordinator`'s cohort tier, connected fallback, retry-futility input and last-resort self tier; `getNeighborIdsForKey` deleted)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (every FRET mock migrated from `getNeighbors` to `assembleCohort`; two `findCluster` membership cases flipped; new describe "cohort assembly — self is in a cohort only when it is among the nearest serving peers")
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (`ringPeersOf`; new describe "on the production key network over the same seeded ring")
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (write-side pins flipped; header and comments restated)
  - packages/db-p2p/src/repo/coordinator-repo.ts (comment on `isResponsibleForBlock`; the NOTE in `fetchBlockFromCluster` about an empty cohort)
  - packages/db-p2p/docs/cluster.md (§Network-Membership Scoping, §Self-Coordination Is Never Memoized)
difficulty: hard
----

# What was built

Maintainer decision of 2026-09-14, arm B: a machine is in a block's cohort only when it is genuinely among the nearest `clusterSize` serving peers. This is the first of three tickets; `writer-and-harness-route-to-the-cohort` and `coordinator-refuses-blocks-it-is-not-responsible-for` build on it.

**One assembly for both questions.** `assembleServingCohort` in `packages/db-p2p/src/libp2p-key-network.ts` is the only place a key becomes a cohort. It hashes the routing key once, asks FRET for the nearest live ring members (the over-fetch width on the membership-scoped path, `clusterSize` otherwise), appends a serving self last when FRET did not list it (absence means self is farther than every listed member), removes a non-serving self wherever it sits, keeps `serves` members in proximity order on the scoped path, and cuts to `clusterSize`. `findCluster` builds the replica record from that cohort, reusing the assembly's peerStore reads for its address backfill exactly as before; everything after membership classification (backfill, the addressless and self-relay-only diagnostics, self's memoized addresses) is untouched.

**Self is classified like everyone else.** `selfServes` reads the protocols this node itself registers with libp2p and applies the same `cluster`/`repo` test `membershipOf` applies to a remote peer's peerStore list (factored into `servesThisNetwork`). No prefix configured, or a libp2p double without `getProtocols`, counts as serving. `membershipOf(self)` routes through it instead of returning `serves` unconditionally.

**The coordinator comes from the same ordered cohort.** `findCoordinator`'s first tier now filters the cohort by `isSelectable`, then by "connected, or self and admissible", then stably sorts by reputation score (a comment says why stability matters and that `Array.prototype.sort` guarantees it). `filterByMembership` stays as the final scope check but takes the assembly's already-read protocols, so it costs no second peerStore read. Self is admissible on that tier only when it is in the cohort and today's guard allows it (the isolated-read degrade is unchanged). The last-resort self tier runs only when self is in the last attempt's cohort. A node outside the cohort therefore fails with `NO_NETWORK_COORDINATOR` when the membership filter dropped a connected unconfirmed candidate, otherwise `NO_COORDINATOR_AVAILABLE` with a message naming the reason; `SELF_COORDINATION_EXHAUSTED` keeps its meaning (caller excluded self on a solo node). The connected fallback is unchanged and carries the requested `NOTE:`.

**Tripwires recorded as NOTEs:** cache trust at `getCachedCoordinator`; per-band peerStore read cost at `assembleServingCohort`; the out-of-cohort connected fallback at that tier.

# Deviations from the ticket text, for the reviewer to weigh

- **`retryCouldImprove` is fed the proximity band, not the cut cohort.** The ticket says "the cohort's non-self ids". The old input was FRET's neighbour list with the membership filter deliberately not applied, and the surrounding comment explains why: an `unknown` neighbour is exactly the peer that flips to `serves` inside the retry window, and a connection to any serving band member makes the connected fallback succeed. Feeding the serves-only cohort would close the window in those cases. The band preserves the documented behaviour; on the scoped path it is wider than the old input (the over-fetch width rather than `clusterSize`), which can only keep a window open, never close one.
- **A failed assembly means self is not the last resort.** If `assembleServingCohort` throws on every attempt (FRET not registered), `lastCohort` stays undefined and the lookup fails with `NO_COORDINATOR_AVAILABLE` rather than degrading to self as the old code did. A node without FRET cannot run `findCluster` either, so self-coordination there could never complete a write; no test exercised that path before or after. Stated in a comment at the tier.
- **`NO_NETWORK_COORDINATOR` is still driven only by connected candidates.** The assembly classifies the whole band, but its foreign/unknown counts feed only the `cohort:membership` log line. The error flag is set, as before, by `filterByMembership` over connected peers (the fallback tier). Using the band's counts would report "peers are unconfirmed" for a node whose real problem is that the serving cohort members are simply not connected.
- **The clusterSize-1 membership case also flipped.** The ticket named the "self counts toward it" case; "with clusterSize 1 yields a self-only cohort even when serving peers are nearer" follows from the same rule (the one slot goes to the nearest serving peer) and was rewritten too.
- **Log tags renamed** from `findCoordinator:fret-*` to `findCoordinator:cohort-*`, and `findCluster:membership` to `cohort:membership` (it now fires for both callers). Nothing in the repo asserted on the old tags.

# Confirmed rather than assumed

- This node's own FRET ring entry passes `isLiveMember`: `FretService` upserts self and calls `setMembership(self, 'member')` at insert, and the predicate's doc says self is seeded `member` and never marked dead. The integration run shows it in practice (`driverInCohort` 11 of 24, self appearing in `coordinatorView` at its proximity position).
- Prefix consistency of FRET's walk: the scoped path (over-fetch, cut to `k`) and the unscoped path (`k` directly) both equal `assembleCohort(store, coord, k)` for 60 block ids at every width from 1 to 32, so the two paths cannot disagree on a cohort when every member serves.
- A client-only node and a serving node compute the same cohort for the same block (the serving node drops the client as not-serving from the same band the client drops itself from).

# Use cases for testing and validation

Unit, `test/libp2p-key-network.spec.ts` (109 cases, all green), new describe near the end:

- solo node → self-only cohort on both paths; self excluded when `clusterSize` serving peers are nearer; self included at its proximity position when among the nearest; small network keeps everyone; a nearer unidentified peer does not displace self; a non-serving self is in no cohort and may see an empty `findCluster`; a double without `getProtocols` counts as serving.
- `findCoordinator` picks the cohort's second entry (A) when self is denied, even though a `getNeighbors` mock lists B second and B is connected; equal scores keep proximity order; a better score reorders within the cohort only; a write from an outsider goes to a cohort member although the guard allows self; the connected fallback still picks an out-of-cohort serving peer when no member is reachable; an outsider with nobody connected fails `NO_COORDINATOR_AVAILABLE` (this case pays the 1 s retry window and has a 5 s timeout); a non-serving self fails for both intents, `NO_NETWORK_COORDINATOR` with only an unidentified peer connected, and routes to a connected serving peer; `SELF_COORDINATION_EXHAUSTED` unchanged.

Unit, `test/routing-key-convention-divergence.spec.ts` (seeded ring, no I/O): cohort equals FRET's nearest-`k` walk with the coordinator as its first entry at widths 1 to 32 on both paths; every serving node in every cohort at widths 1 to `k`; from every member's view self is in a cohort iff among the nearest `k` at width 12; a non-serving member is in no cohort and agrees with a serving member at widths 1 to 16.

Integration, `test/routing-key-convention-divergence.integration.spec.ts` (six real nodes, `clusterSize` 2, gated on `OPTIMYSTIC_INTEGRATION=1`), one run on 2026-09-17:

```
write summary  { blocks: 24, failures: 0, writerPickOutsideCohort: 0, pendHandledLocally: 8, driverInCohort: 11,
                 blocksRedirected: 0, totalRedirects: 0, blocksWithPhantomHolder: 0, blocksWithCohortGap: 0 }
read summary   { readOk: 24, readMiss: 0, readThrew: 0, getsHandledRemotely: 19, getChecks: 19, getRedirects: 0,
                 blocksGrownByReads: 0, replicasAddedInsideCohort: 0, replicasAddedOutsideCohort: 0 }
```

The three blocks where the driver is in the cohort but second (`pendHandledLocally` 8 versus `driverInCohort` 11) went to the nearer peer: that is the transactor's first-seen tie-break, which the second ticket replaces. The pin is `at.most` until then.

Also run: `test/two-party-cohort-is-collection-independent.spec.ts` (both cases still hold, as the fix ticket predicted), `packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts` (3 passing against the fresh db-p2p build), full db-p2p suite (2916 passing, 63 pending, 0 failing), root `yarn lint`, `yarn lint:docs`, `yarn typecheck`, `tsc` build of db-p2p.

# Gaps the reviewer should treat as a floor

- No unit case drives a real `FretService` end to end; the live-member claim rests on reading `fret-service.ts` plus the integration run.
- The seeded-ring specs give every peer equal reputation, so the "coordinator is the cohort's first entry" invariant is not exercised with a real reputation service; the mock-based reorder case is the only coverage of score-driven reordering.
- The mesh harness's key network still appends self (second ticket). `mesh-harness.ts` still says "findCluster always includes self" in its own doc comment; that statement is about the harness and is correct until the second ticket lands.
- Production reputation scores ascend with penalties (0 is clean), so the ascending sort picks the best-scored member; I did not change or test that direction.
- The `cohort:membership` log line fires on every `findCoordinator` attempt as well as every `findCluster`, so a verbose log grows faster than before on the scoped path.
