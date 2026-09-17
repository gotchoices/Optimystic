description: A machine used to put itself into every block's replica group and pick itself as the coordinator even when it was not among the machines responsible for that block. The network layer now derives both the replica group and the coordinator pick from one ordered list of the nearest responsible machines, so a machine is in a block's group only when it genuinely belongs there.
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`ServingCohort`, `assembleServingCohort`, `selfServes`, `servesThisNetwork`, `membershipOf`, `filterByMembership`; `findCluster`; `findCoordinator`'s cohort tier, connected fallback, retry-futility input and last-resort self tier; `getNeighborIdsForKey` deleted)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (every FRET mock migrated from `getNeighbors` to `assembleCohort`; two `findCluster` membership cases flipped; new describe "cohort assembly — self is in a cohort only when it is among the nearest serving peers")
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (`ringPeersOf`; new describe "on the production key network over the same seeded ring")
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (write-side pins flipped; header and comments restated)
  - packages/db-p2p/src/repo/coordinator-repo.ts (comment on `isResponsibleForBlock`; the NOTE in `fetchBlockFromCluster` about an empty cohort)
  - packages/db-p2p/docs/cluster.md (§Network-Membership Scoping, §Self-Coordination Is Never Memoized)
  - docs/transactions.md (self-coordination guard section; tier names and the read row corrected in review)
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

Unit, `test/libp2p-key-network.spec.ts` (109 cases after review, all green), new describe near the end:

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

# Review findings

Reviewed 2026-09-16 against the implement commit `4966acd5`, reading the diff before the handoff. Commands run from `packages/db-p2p` unless noted: `yarn test` (2916 passing, 63 pending, 0 failing, before my edits), the key-network spec alone after my edits (109 passing), `yarn typecheck` (exit 0), and from the repo root `yarn lint` (exit 0) and `yarn lint:docs` (all citations resolve). The gated six-node integration spec was not re-run; the implementer's pasted summary stands as the record.

## Answers to the four questions left for the reviewer

- **Is HEAD half-changed until the second ticket lands? Yes, at every network size of two or more.** `consolidateCoordinators` in `packages/db-core/src/transactor/network-transactor.ts` assigns blocks to the peer covering the most blocks and breaks ties by first-seen. Cohorts are now in proximity order, so on a small network (every node in every cohort, all tied) the write goes to whichever peer is nearest the first block, not to the writer's own node. Read from the code rather than measured, that is roughly (N-1) of every N single-block writes on an N-node network at or under `clusterSize`; the integration run shows the same effect at six nodes (3 of the 11 blocks the driver was responsible for went remote). Writes still complete (a remote cohort member coordinates, and a failed remote batch retries through `findCoordinator`, which can pick self), but each pays a network hop and depends on the partner being dialable, which the maintainer's decision says must not happen at small sizes. Sereus runs against this HEAD through a linked workspace. **Recommendation: run `writer-and-harness-route-to-the-cohort` next, ahead of the fix queue.** I did not reorder the board; that is the runner's and the maintainer's call.
- **Can a real deployment have no FRET service? No.** `libp2p-node-base.ts` registers `fret` unconditionally in its services map, and the React Native entry builds on the same base. The only FRET-less callers are test doubles. The old code's self fallback there could not finish a write anyway, because `findCluster` throws without FRET. Now pinned by a unit case (below).
- **Does a one-machine deployment still commit end to end? Yes.** The node-count sweep's N = 1 arm runs on the mesh harness, not the production key network, so it is not the evidence. `test/fresh-node-ddl-libp2p.spec.ts` is: a real libp2p node, `clusterSize` 1, no bootstraps, committing through `NetworkTransactor`. It passes in the full run.
- **Renamed log tags.** No file in this repository (docs, source, tests) and nothing in the sereus checkout at `C:/projects/sereus` references `findCoordinator:fret-*` or `findCluster:membership`. Sereus's one error-text matcher (`control-write-retry.ts`) keys on the `Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.` sentence, which is unchanged.

## Found and fixed in this pass (minor)

- `docs/transactions.md` still described the old rule in its self-coordination section: it named a "FRET tier" where self "is a neighbour of the key", and its read row said a read is "never denied its own replica". Reworded to the cohort tier, the in-cohort condition on both self tiers, and the read row now says the guarantee holds for a responsible node only.
- Two unit cases added to the new describe in `test/libp2p-key-network.spec.ts`: a node with no FRET service fails with `NO_COORDINATOR_AVAILABLE` ("could not be derived") yet still routes through the connected fallback when a serving peer is connected; and an isolated read from a node outside the cohort fails the same way a write does.

## Tripwire recorded

- An isolated read of a block the node is not responsible for now fails instead of degrading to an older local copy. No effect while the serving peers number at most `clusterSize`. Parked as a `NOTE:` at the last-resort tier in `findCoordinator`, and pinned by the new read case.

## Checked and left alone

- **The three deviations the implementer listed** (retry-futility fed the wide band rather than the cut cohort; failed assembly means no self last resort; `NO_NETWORK_COORDINATOR` driven only by connected candidates). Each is argued at its code site and I agree with each: the band can only keep a retry window open, never close one, and the other two avoid a misleading result.
- **`filterByMembership` on the cohort tier can never drop anything**, because the assembly already cut the cohort to serving peers from the same records; it and the `protocolsByPeer` map exist only as a belt-and-braces check the plan asked for. Cost is one small object per lookup. Left as designed; remove both together if this path is ever trimmed.
- **Two nodes can still derive different cohorts while one of them has not finished identifying a peer.** Pre-existing and unchanged by this ticket (unidentified peers were never admitted); the partition-healing backlog item owns it.
- **Reputation sort direction** (ascending, 0 is clean) matches `IPeerReputation.getScore` usage elsewhere in the file; not changed.
- **Resource cleanup, error handling, type safety:** no new listeners, timers or caches; the assembly's throw is caught per attempt in `findCoordinator` and propagates from `findCluster` exactly as the old FRET call did; no new `any`.
- **File size:** `libp2p-key-network.ts` is 1377 lines (`wc -l`), most of it explanatory comment. Not filed: the change shrank the logic (one assembly instead of three paths), and splitting the file is outside this ticket.

## Major findings

None filed. The one substantial concern, the writer sending small-network writes to a remote peer, is exactly the scope of the already-written `writer-and-harness-route-to-the-cohort` ticket, so a new ticket would duplicate it; the action is sequencing, stated above.
