description: The live-tier milestone test and doc flip — stand up a ≥minSigs in-process multi-node cohort, register a participant through the walk, assemble a real threshold signature, and verify a promotion notice and a membership cert end-to-end. Then flip architecture.md Doc Sync Status (cohort-topic mock-tier e2e → done).
prereq: cohort-topic-threshold-assembly, cohort-topic-promote-verify-apply, cohort-topic-gossip-cadence, cohort-topic-host-antidos-coldstart
files:
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (NEW — the e2e)
  - packages/db-p2p/src/testing/mesh-harness.ts (REFERENCE — real-components / mock-transport pattern)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (existing mock-tier tests stay)
  - docs/cohort-topic.md (§FRET integration — flip the mock-tier scope notes)
  - docs/architecture.md (Doc Sync Status — cohort-topic substrate mock-tier e2e → done)
----

# Cohort-topic: live-tier end-to-end milestone

The done-when of the parent plan: a real multi-node cohort registers, threshold-signs, gossips, and
promotes end-to-end, and the docs flip from "mock-tier e2e pending" to done. All the machinery lands
in the prereq tickets; this ticket proves it composes and records the milestone.

## Design

### Harness

Follow `mesh-harness.ts`: real components, mock transport, **real Ed25519 keys** (one
`generateKeyPair('Ed25519')` per node, `peerIdFromPrivateKey`). Stand up `N ≥ minSigs` nodes (use a
small `minSigs` for the test — e.g. `wantK = N`, `minSigs = N − 1` with `N = 5` or so — to keep the
test fast while still exercising the multi-signer quorum rule; the production `minSigs = 14` path is
identical, just larger). Each node gets a `createCohortTopicHost(node, fret, { privateKey, ... })`.

The transport is mock but must route the **five** cohort-topic protocols (`register`, `cohort-gossip`,
`promote`, `membership`, `sign`) and FRET's `routeAct`/`assembleCohort` directly between in-process
node engines:

- `assembleCohort(coord, wants)` returns the same deterministic member set on every node (sort all N
  peer ids by XOR distance to `coord`, take `wants`) — so all nodes agree on the tier-0 cohort for
  the test topic.
- `routeAct(RouteAndMaybeActV1)` routes to the node nearest `key` and invokes its activity handler
  (the `RegisterV1` decision), returning the `commitCertificate` reply — mirroring the real FRET
  contract the host depends on.
- `dialMember` / `sendOneWay` / `requestResponse` deliver directly to the target node's registered
  protocol handler.

A minimal in-process FRET mock (the existing `service.spec.ts` fake + `spread-on-churn.spec.ts`
MockFret are starting points) plus a peer-routing table is sufficient; no real libp2p sockets.

### Assertions (the milestone)

1. **Real cohort:** the cohort serving the test topic at tier 0 is `assembleCohort(coord_0(topicId))`
   = all N nodes (not any node's ring neighbours) — proves per-coord scoping.
2. **Register through the walk:** a participant `service.register({ topicId, tier, bootstrap:true })`
   resolves an `accepted` `RegistrationHandle` with a `primary` ∈ the cohort and `cohortMembers` = the
   N-node set.
3. **Real threshold signature:** the cohort publishes a `MembershipCertV1` whose `thresholdSig`
   verifies — `signers.length ≥ minSigs`, all distinct, all ∈ `members`, every per-member Ed25519
   chunk valid. A participant's `verifier().verifyMessage(...)` over the cert / a threshold-signed
   message returns `"verified"`. Assert that a **forged single-signer** cert/notice (the interim
   shape) is rejected (`"untrusted"`).
4. **Promotion end-to-end:** register `> cap_promote` participants (lower `cap_promote` in the test
   config to keep it fast), the tier-0 cohort threshold-signs a `PromotionNoticeV1`, broadcasts it
   over `promote`, a node that did not originate it `verifyMessage`-verifies and `applyPromotionNotice`
   adopts it, and a subsequent registration gets `Promoted(1)`. The participant walk recomputes
   `coord_1`, gets `no_state` (no tier-1 cohort), walks back to 0, and terminates within `maxSteps`
   (the single-cohort termination the scoping ticket fixed).
5. **Gossip replication:** a registration accepted on the routed primary replicates (via a gossip
   round) into a sibling node's store; an evicted record converges.

### Docs

- `docs/cohort-topic.md` §FRET integration: replace the "Scope (mock-tier e2e pending)" notes and the
  per-gap "interim" callouts (threshold crypto single-signer, per-coord scoping, participant signer,
  promote verify-apply, gossip cadence, anti-DoS undefined, cold-start no-op) with the landed
  behaviour. Keep the doc honest about anything still deferred (multi-tier promoted-redirect follow-on
  instantiation, lookup-probe RPC, withdraw tombstone — all parked in backlog).
- `docs/architecture.md` Doc Sync Status: flip **cohort-topic substrate mock-tier e2e pending → done**
  (cite `live-tier.spec.ts`).

## Edge cases & interactions

- **Test runtime:** keep `N` small and `cap_promote` low so the e2e runs well inside the idle-timeout
  window; stream test output with `tee`. The production `minSigs = 14` is the same code path.
- **Determinism of mock assembleCohort:** every node must compute the identical cohort for a coord or
  the threshold collection fragments; pin the sort (XOR distance, tie-break by peer-id bytes).
- **Quorum reachability:** all N nodes must answer the `sign` RPC for `assemble` to reach `minSigs`;
  a test that drops one node below quorum should show the notice/cert is **not** produced (no
  single-signer fallback) — assert this negative case too.
- **Async signer timing:** registration signing and threshold assembly are async; the test must
  `await` register/renew and pump the gossip driver tick deterministically (inject a manual clock /
  call the tick directly rather than relying on wall-clock `setInterval` in the test).
- **Clock injection:** use the injectable `clock` on the service and a manual driver pump so the test
  is not timing-flaky (the periodic-driver ticket should expose a directly-callable tick for tests).
- **Pre-existing failures:** if `yarn test:db-p2p` surfaces a failure outside the cohort-topic diff,
  follow the pre-existing-error protocol (write `tickets/.pre-existing-error.md`) and finish the
  ticket.

## TODO

- Build `live-tier.spec.ts`: N real-keyed nodes, mock transport routing the five cohort protocols +
  FRET `routeAct`/`assembleCohort`, deterministic per-coord cohort.
- Assert the five milestone behaviours (real cohort, walk register, real threshold sig + forged-sig
  rejection, promotion verify-apply + walk termination, gossip replication) and the sub-quorum
  negative case.
- Expose a test-callable driver tick + manual clock (coordinate with the gossip-cadence ticket).
- Flip `docs/cohort-topic.md` §FRET integration interim notes and `docs/architecture.md` Doc Sync
  Status; keep deferred items (backlog) honestly listed.
- Run `yarn test:db-p2p` (stream with `tee`) and the type-check before handoff.
