description: A storage machine that receives a write for a block it is not responsible for should send the writer to the right machines or refuse, never quietly accept it, and it must not accept a write when it cannot even tell whether it is responsible. Today it accepts in both cases. Make the check real now that the replica-group rule makes it meaningful.
prereq: writer-and-harness-route-to-the-cohort
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`isResponsibleForBlock`, which returns true when the lookup throws; `verifyResponsibility`, called by `pend`, `cancel` and `commit`; the soft check and its two NOTEs at the top of `get`; `soloCohortDurability`, whose `unrouted` class becomes defence in depth)
  - packages/db-p2p/src/repo/service.ts (`checkRedirect`, which decides responsibility through `NetworkManagerService.getCluster`, a different rule from the writer's; it sees writes for the first time once the writer stops self-coordinating everything)
  - packages/db-p2p/src/network/network-manager-service.ts (`getCluster` loses its last production caller)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`executeClusterTransaction`, after `getClusterForBlock`: the place to refuse running a cluster transaction from a node outside the cohort it is about to declare)
  - packages/db-p2p/src/optimystic-node.ts (`OptimysticNodeAttachments.keyNetwork`, the handle the repo service reads through the node injected by `setLibp2p`)
  - packages/db-p2p/test/coordinator-repo-proximity.spec.ts ("assumes responsible when findCluster fails (fail-open)" flips for writes and stays for reads)
  - packages/db-p2p/test/redirect.spec.ts and packages/db-p2p/test/cluster-coordinator.spec.ts (redirect decisions on writes; coordinator built with a local member whose id is outside the mocked cohort)
  - docs/correctness.md (§Commit durability reporting: the remark that a coordinator outside `record.peers` is not a reconcile target and that keeping it inside is the routing convention's job)
  - docs/internals.md (§Proximity Verification lists "Fail-open"; the solo-proof paragraph near "A failed `findCluster` (cohort size 0) lands in the same branch")
  - docs/transactions.md (the paragraph "A cohort of zero deliberately does not", which says the production key network always includes this node)
  - packages/db-p2p/docs/cluster.md (§Access Control: "Only peers returned by `findCluster()` participate", which becomes literally true)
  - tickets/backlog/debt-network-manager-coordinator-selection-is-a-stale-duplicate.md (carries an arm: `getCluster` is dead too once the redirect check moves)
  - ../sereus/packages/integration-tests (the `strand-membership-closed-strand-e2e` and `harness-party-control-cohort` scenarios, to run once if that checkout type-checks against this repository)
difficulty: medium
----

# What becomes live

Until the first ticket, `isResponsibleForBlock` was vacuous: the node's own key network put the node in every cohort. Now it can say no. Three sites turn that answer into behaviour.

## The responsibility check fails closed on writes and open on reads

Today a thrown `findCluster` is treated as "assume responsible" everywhere. That default is what GitHub #19 looked like from the outside: with every cohort lookup throwing, a write passed the check, committed solo, and returned plain success, so two phones each kept only their own row. The result-type half of that issue landed as the `unrouted` durability class. This is the acceptance half.

Decision: `verifyResponsibility` (the write path: `pend`, `cancel`, `commit`) refuses when the lookup throws, with a distinct error from "not responsible" so a log can tell a routing fault from a misrouted request. The `get` soft check keeps serving on a thrown lookup, because reads are best-effort and the layers below already flag what they could not confirm. Introduce a small typed error (one class, a `kind` of `'not-responsible'` or `'undetermined'`, the offending block ids) so the transactor's retry path and the proximity spec can match on it rather than on message text. The transactor needs no change: a refusal from the local coordinated repo or from a remote one is a batch error, `processBatches` excludes that peer and re-picks through `findCoordinator`, which after the first ticket lands inside the cohort.

Cancel deserves a sentence: a fail-closed refusal on a transient lookup fault leaves a pending record standing until the writer's `dischargeCancel` retries elsewhere. The node that refused still receives the cancel as a cohort member (members judge `record.peers`, not a lookup), so the record is discharged on the retry that lands on any other cohort member.

The responsibility cache (60 s) is unchanged. It means a node can still answer "responsible" for up to a minute after it stops being so; `soloCohortDurability`'s `unrouted` class for "resolved to one peer that is not this node" is what reports that window honestly, so keep it and say in its comment that it is now defence in depth rather than the main guard.

Re-read the two NOTEs at the top of `get`. The soft-served-read NOTE said to gate acquisition on `isResponsibleForBlock` if soft serves became routine. After the redirect change below, a remote read for a block this node is not responsible for is redirected before it reaches `get`, and after the first ticket the node's own transactor does not route a local read here unless self is in the cohort. So soft serves are confined to the responsibility cache's staleness window. Do not add the gate; restate the NOTE's condition in those terms. The accepted-tradeoff NOTE about two lookups per cold read stays as written, its revisit condition unchanged.

## The redirect check applies the writer's rule

`RepoService.checkRedirect` computes the responsible set through `NetworkManagerService.getCluster`: FRET's raw cohort, sized to the network estimate, with no network-membership scoping and its own five-minute cache. The writer computes it through `Libp2pKeyPeerNetwork.findCluster`. On a network where several Optimystic networks share machines the two answers differ, and a correctly routed write could be redirected. Decision: `checkRedirect` derives the responsible set from the node's own key network (`node.keyNetwork.findCluster(routingKeyForBlock(blockKey))`, reachable through the libp2p node `setLibp2p` injects, typed by `OptimysticNodeAttachments`). Keep attaching the id list to the message as today. Memoize the id list per block key in a 1000-entry map with the same 60 s TTL `CoordinatorRepo.RESPONSIBILITY_TTL_MS` uses, so an inbound operation costs one cohort lookup per minute per block rather than two per request; a redirect verdict tolerates a minute of staleness exactly as the responsibility verdict does.

Failure posture mirrors the repo: if the lookup throws, a `get` is handled locally (return null), any other operation propagates the error so the client excludes this peer and re-picks. The `smallMesh` bypass (`cluster.length < responsibilityK`, never true at the default width of one) is unchanged.

That leaves `NetworkManagerService.getCluster` with no production caller, joining `getCoordinator`. Append an arm to `debt-network-manager-coordinator-selection-is-a-stale-duplicate` saying so; do not delete the class here.

## A node never runs a cluster transaction for a cohort it is not in

`docs/correctness.md` notes that a coordinator outside `record.peers` is not a reconcile target, and that keeping the coordinator inside the cohort is the routing convention's job. Under the new rule that is true by construction on the writer side and enforced by the responsibility check on the server side, but `ClusterCoordinator.executeClusterTransaction` should state the invariant itself: when a local member is wired (`localCluster` present) and the local peer id is not in the cohort just looked up, throw a clearly worded error before hashing the record. `CoordinatorRepo`'s solo short-circuit already keeps an unresolved or single-peer cohort away from this method, so the guard only ever fires on a resolved multi-member cohort that excludes this node, which after the responsibility check can happen only inside the cache's staleness window. Rewrite the `correctness.md` sentence to say the invariant is now held at this site.

# Edge cases & interactions

- Solo node, zero peers: cohort is self, check passes, short-circuit unchanged. The proximity spec's solo cases must stay green.
- `localPeerId` undefined (direct constructors, some test wiring): the check is skipped as today and the guard in the cluster coordinator does not fire (no local member). Keep both bypasses; say in a comment they exist for wiring without an identity, never for production.
- Lookup throws inside `verifyResponsibility` for one block of a multi-block pend: the whole pend is refused with the `undetermined` kind naming that block; the writer's cancel of the partial pend runs as today.
- A misrouted write reaching a remote `RepoService`: redirected with the cohort's addresses; `RepoClient` follows, records the coordinator hint, and the redirect loop guard (`max hops`, same-peer) is unchanged. Pin a redirect on a `pend` and a `commit`, not only on `get`, in `redirect.spec.ts`.
- The redirect check and the responsibility check disagree only inside their caches' staleness windows; both TTLs are the same 60 s, so state that in a comment rather than trying to share the cache across the service boundary.
- `cluster-coordinator.spec.ts` cases that wire a local member: check whether any mocks a cohort that excludes the local peer id. Such a case must either include it or expect the new refusal.
- `ClusterService.checkRedirect` (the member side) still judges `record.peers`; unchanged and correct, since a member is asked only because a coordinator declared it.
- Existing deployments hold phantom copies from the old rule. Nothing sweeps them and nothing in this ticket should; the project makes no compatibility promise yet (see the general rules), so record the fact in the handoff and nowhere else.
- Sereus: both its profiles register the storage protocols, so no sereus node becomes non-serving. Its `strand-membership-closed-strand-e2e` and `harness-party-control-cohort` scenarios should be run once against this branch, but the sereus checkout does not type-check against this repository until `blocked/sereus-harness-passes-bare-bytes-as-routing-key` lands there. Run them if it type-checks; otherwise record the deferral in the handoff, do not attempt to fix sereus from here.

# Tests

- Proximity spec: write refusal with `undetermined` when the lookup throws; read served when it throws; write refusal with `not-responsible` when the cohort excludes this node; the error names every offending block; the cache still short-circuits repeated checks.
- Redirect spec: `pend` and `commit` redirected when this node is outside the key network's cohort; handled locally when inside; `get` handled locally when the lookup throws; `pend` propagates the error when it throws.
- Cluster coordinator spec: the guard refuses a resolved multi-member cohort that excludes the local member; a cohort that includes it proceeds as today.
- Integration spec (six real nodes): re-run once; every pin from the first two tickets holds and `blocksRedirected` on writes is 0 because the writer already picks inside the cohort. Paste the summary.

# TODO

- Typed responsibility error; `verifyResponsibility` fails closed on a thrown lookup; `get` keeps serving; restate the soft-serve NOTE and the `soloCohortDurability` comment.
- `RepoService.checkRedirect` on the node's key network with the 60 s memo and the read-versus-write failure posture.
- Cohort-membership guard in `executeClusterTransaction`.
- Spec updates listed under Tests; run the integration spec once.
- Docs: `docs/internals.md` §Proximity Verification (fail-closed on writes, fail-open on reads) and the solo-proof paragraph; `docs/correctness.md` invariant sentence; `docs/transactions.md` "cohort of zero" paragraph; `packages/db-p2p/docs/cluster.md` §Access Control.
- Append the arm to `tickets/backlog/debt-network-manager-coordinator-selection-is-a-stale-duplicate.md`.
- Run the two sereus scenarios if `../sereus/packages/integration-tests` type-checks; record the outcome or the deferral.
- Build, lint, `yarn lint:docs`, db-p2p unit suite; hand off with gaps stated plainly.
