description: On a network wider than one cohort, a cohort-topic registration is delivered to a different set of machines than the ones that believe they serve the topic, because the routing step hashes the topic's ring coordinate a second time while the serving side does not.
architecture: docs/cohort-topic.md#routeandmaybeact-usage
files: packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts, packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts, packages/db-core/src/cohort-topic/addressing.ts, packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/walk.ts, docs/cohort-topic.md
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: Every test ring today is no wider than one cohort, where both hashings pick the same machines, so a maintainer may defer this until a deployment wider than `wantK` (16) exists; the fix changes what the router port is handed, which touches every mock router.
----

# The cohort-topic router hashes a coordinate as if it were a key

## What is wrong

A cohort-topic cohort lives at a **ring coordinate**: db-core computes `coord_d` as a SHA-256 digest (`HashTierAddressing` in `packages/db-core/src/cohort-topic/addressing.ts`), and `RingHash` in `packages/db-core/src/cohort-topic/ring-hash.ts` states the contract that this digest is byte-identical to the position FRET derives — FRET's `hashKey` is SHA-256 of the key bytes. So on the serving side db-p2p treats `coord_d` as the FRET position: `cohortAround` in `packages/db-p2p/src/cohort-topic/host.ts` calls `fret.assembleCohort(coord, wantK)` with the coordinate as-is, and so do the trust anchor (`directAnchor` in `packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts`) and the reactivity origination gate (`createReactivitySelfMembershipGate` in `packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts`). FRET's `assembleCohort` takes an already-hashed coordinate, so those calls are right.

The routing side does something else. `FretTopicRouter.routeAndAct` in `packages/db-p2p/src/cohort-topic/topic-router.ts` puts the same coordinate into a `RouteAndMaybeActV1` as its `key`, and FRET's `routeAct` (`p2p-fret`'s `fret-service.ts`) hashes whatever key it is given before walking the ring: `coord = hashKey(keyBytes)`. A register frame for `coord_d` is therefore delivered to the machines nearest `SHA-256(coord_d)`, while the machines that will serve `coord_d`, sign its membership certificate, and check whether they belong to its cohort are the ones nearest `coord_d` itself. The host's activity handler then recomputes the coordinate from the frame and dispatches to an engine keyed by `coord_d`, on a machine FRET chose for a different position.

The two sets coincide only while the ring holds no more machines than one cohort (`wantK`, default 16), because then every machine is in every cohort. That is every ring the test suites build: the mock meshes drive the host's activity handler directly, and the fake FRET in `packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts` answers `routeAct` by assembling around the unhashed key, so none of them can see the second hash.

## Consequences on a wider ring

- A participant's registration lands on a machine that is not in the cohort it will be told it joined (the reply's `cohortMembers` come from `cohortAround(coord_d)`), so renewals and direct dials go to machines that never held the record, and promotion and demotion notices are signed by a cohort the registering machine is not part of.
- Reactivity's origination gate asks whether this node is in `assembleCohort(coord_0)`; subscribers register through the router at `SHA-256(coord_0)`. On a ring wider than a cohort, the machines that announce a change and the machines holding the subscriber records are disjoint, so nothing is delivered. The third ticket of the root-placement series (`reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`) moves the root to the storage group through `routeToRoot` and the key network, which sidesteps this for the root only; every tier `d ≥ 1` of every topic, and every matchmaking topic, keeps the mismatch.
- The walk's root fallback for a router without `routeToRoot` (`routeToTier` in `packages/db-core/src/cohort-topic/walk.ts`) hands `H(rootKey)` to `routeAndAct`, which through this binding lands at `H(H(rootKey))` rather than the storage group at `H(rootKey)`.

## Expected behavior

One rule for what a cohort-topic coordinate is on FRET's ring, applied on both sides. The documented intent (the `RingHash` contract, and `docs/cohort-topic.md` § Cohort assembly: "the cohort at any given `coord_d` is whichever set of `k` peers FRET names") is that the db-core coordinate **is** the FRET position. Under that rule the router is the side that is wrong, and the fix is to hand FRET a key whose single hash is the coordinate: the **preimage** that `coord_d` was hashed from (`d ‖ prefix(H(P), d·log₂F) ‖ topicId`, or `0x00 ‖ topicId` at the root), which db-core's addressing already builds and could expose beside the digest. For a root-placed topic the preimage is the root key itself, so the walk's fallback would then reach the storage group with no special case, by the same key-hashed-once rule block storage uses (`routingKeyForBlock`, hashed once by `findCluster`).

The alternative — hash on the serving side instead, so every `assembleCohort(coord)` call becomes `assembleCohort(hashKey(coord))` — keeps the router as it is but breaks the `RingHash` contract, makes a root-placed root unreachable at the storage position through ring routing for good, and FRET's `hashKey` is asynchronous where `cohortAround` is synchronous. Not recommended.

Whichever rule is chosen, `docs/cohort-topic.md` § RouteAndMaybeAct usage should say which bytes go into `key`, and § Cohort assembly should say what position the cohort is assembled around, in the same terms.

## What would confirm it

A test like `packages/db-p2p/test/routing-key-convention-divergence.spec.ts` for the cohort-topic layer: a ring wider than `wantK`, one register through the real `FretTopicRouter` over a real FRET service, asserting the machine whose activity handler ran is a member of `cohortAround(coord_d)` on that machine. Today it is not, by the arithmetic above; no run of it exists.
