description: When a machine notices it was registered to watch a table with the wrong group of machines, it tries to fix this straight away — but the retry asks a cached list of machines that is the very list that was wrong, so it usually makes the same mistake again and the watcher stays unnotified for another half-minute.
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/reactivity/collection-watch.ts, docs/cohort-topic.md, docs/reactivity.md
repro: static
difficulty: medium
----

# One placement, two views of the group

A machine that starts watching a table registers itself with the group of machines responsible for the table's log tail. Which machines those are is decided by one rule — the key network's storage rule at the tail's ring position. Two parts of the system now read that rule through **different** paths, and that is the bug:

- **The check that judges a placement** reads it *live*: `ReactivityCollectionWatchOptions.rootGroupMembers` is bound on a node to `resolveReactivityCohort`, i.e. the key network's `servingCohortAt`, which is deliberately uncached (see its own NOTE in `packages/db-p2p/src/libp2p-key-network.ts`, which explains that a cache could only be bounded by a TTL and a membership change would then go unseen).
- **The register walk that performs a placement** reads it through a *cache*: the cohort-topic host hands its router a `rootGroupMembers` backed by `RootGroupSnapshots.ensure` (`createCohortTopicHost` in `packages/db-p2p/src/cohort-topic/host.ts`), whose maximum age is the gossip interval — `DEFAULT_GOSSIP_INTERVAL_MS` in `packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts`, 5 s by default. `routeToRoot` (`FretTopicRouter` in `packages/db-p2p/src/cohort-topic/topic-router.ts`) dials that member list in order and takes the first reply.

So `verifyRootGroup` (`packages/db-p2p/src/reactivity/collection-watch.ts`) can correctly detect that a registration is held outside the announcing group, and then repair it by a walk that is handed the very member list the misplacement came from. The landing check runs milliseconds after the walk it is reacting to — always inside the snapshot's 5 s window, since that walk is what filled or refreshed the snapshot — so it dials the same machines in the same order and the same machine admits it again with the same view. The repair that actually lands is the next mismatched reading, one watch tick later (30 s on Core).

The effect is that a watcher whose registration landed wrong is deaf to pushed commits for up to a tick rather than for the one round-trip the design intends. That still beats the ≈ 90 s it replaced (the renewal failover's keep-alive strike-out), but a caller that commits immediately after `watch` returns — the shape of the originating report, a scenario in the sibling `sereus` repository — sees no notification at all.

## Why this is one site, not two

The invariant worth having is: **a placement's verification and its repair read the group through one rule and one read.** Today they do not, and nothing in the code says they must; the next consumer of root placement can introduce the same split without noticing. Matchmaking registers at root-placed topics through the same router, so this is not reactivity-specific.

## Expected behaviour

- A register walk's root step dials the group as the placement rule reads it now, not as a snapshot read up to a gossip interval ago remembers it. A repair walk issued immediately after a misplaced one must be able to reach a different member set.
- The watch service's mismatch check and the walk it repairs with agree about what "the root group" means, by construction rather than by coincidence.
- A watcher whose first registration lands outside the group is pushed the next commit — not left waiting for a watch tick.

## Things the implementation has to weigh

- **Why the snapshot exists.** `RootGroupSnapshots` is there for the host sites that must read a root group *synchronously* (the engine's cohort view, its signers, the `/sign` endorser, the gossip targets) and to keep the gossip-cadence driver from re-reading the rule per site. The router's root step is already async and runs once per register walk, which is rare — attach, tail rotation, repair — so reading live there is a different trade from reading live in those synchronous paths. `servingCohortAt` is a FRET ring read plus cached peerStore records (`PeerRecordCache` in `packages/db-p2p/src/network/peer-record-cache.ts`), not a network round-trip.
- **Concurrent walks.** `ensure` and `refresh` share one in-flight read per coordinate, so coalescing does not have to be given up to stop serving a stale list.
- **The alternative shape.** Rather than changing what the walk dials, the check could compare the latched member set against *the list the walk itself dialed*, carried back on the handle. That removes the two-views problem from the other end and also settles the asymmetry recorded as a NOTE at the comparison in `verifyRootGroup` (this node's live view versus the admitting member's reported view), but it needs a new field on `RegistrationHandle` and it does not help any other consumer of root placement. Worth considering alongside the first option, not instead of it.
- **Docs to move with the code.** `docs/reactivity.md` §The node's watch service currently states the tick bound and names this ticket; `docs/cohort-topic.md` §Root placement at a routing key says `routeToRoot` "resolves the group by `membersAt`", which is true only through the snapshot — it should say which.

## How to confirm the report

Read-only so far; nothing was run. A unit-level confirmation is possible without a mesh: drive two register walks through a `FretTopicRouter` whose injected `rootGroupMembers` is the host's snapshot-backed one, change the underlying `membersAt` answer between them, and observe the second walk dialing the first walk's member list. The end-to-end signal is the sibling-repo scenario `packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in the `sereus` repository going green over a run of about a dozen attempts.
