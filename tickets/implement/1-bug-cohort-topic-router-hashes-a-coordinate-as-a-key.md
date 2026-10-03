description: On a network wider than one cohort, a cohort-topic registration is delivered to different machines than the ones that serve the topic, because the router hands the ring routing step a coordinate that the routing step then hashes a second time. Fix it by handing the routing step the bytes the coordinate was hashed from, so the one hash lands on the coordinate.
architecture: docs/cohort-topic.md#routeandmaybeact-usage
files: packages/db-core/src/cohort-topic/addressing.ts, packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/walk.ts, packages/db-core/src/cohort-topic/index.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts, packages/db-p2p/test/cohort-topic/topic-router.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts, packages/db-core/test/cohort-topic/walk.spec.ts, packages/db-core/test/cohort-topic/service.spec.ts, packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts, packages/db-p2p/test/cohort-topic/service.spec.ts, docs/cohort-topic.md, docs/internals.md
repro: verified
----

# The cohort-topic router hashes a coordinate as if it were a key

## Cause (confirmed)

A cohort-topic cohort lives at a ring coordinate `coord_d`, a SHA-256 digest computed by `HashTierAddressing` in `packages/db-core/src/cohort-topic/addressing.ts`. The serving side treats that digest as the FRET ring position: `cohortAround` in `packages/db-p2p/src/cohort-topic/host.ts`, `directAnchor` in `packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts` and `createReactivitySelfMembershipGate` in `packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts` all call FRET's `assembleCohort(coord, …)`, which takes an already-hashed position. Those are right.

The routing side is wrong. `FretTopicRouter.routeAndAct` in `packages/db-p2p/src/cohort-topic/topic-router.ts` puts the coordinate into `RouteAndMaybeActV1.key`, and FRET's `routeAct` (`p2p-fret/src/service/fret-service.ts`, `FretService.routeAct`, and `nearAnchorOnly` beside it) starts with `coord = await hashKey(keyBytes ?? u8FromString(msg.key, 'base64url'))` — and every forwarding hop re-derives the position the same way from the wire key. So a frame meant for `coord_d` is acted on near `SHA-256(coord_d)`. `hashKey` is plain SHA-256 (`p2p-fret/src/ring/hash.ts`).

There are exactly two production `routeAndAct` callers:

- `RouterWalkEngine.routeToTier` in `packages/db-core/src/cohort-topic/walk.ts` — every walk probe and register, plus the root-placed fallback when the router has no `routeToRoot` (which therefore lands at `H(H(rootKey))`, not at the storage group at `H(rootKey)`).
- `registerForwarderWithParent` in `packages/db-p2p/src/cohort-topic/host.ts` — a cold-start forwarder's child-link to its parent, routed at `link.parentCoord`.

No other db-p2p code calls FRET's `routeAct` (grep `routeAct` under `packages/db-p2p/src`).

## Reproduction (run during the fix stage, scratch spec since deleted)

A seeded 64-peer FRET ring (`ringOf(64)` from `packages/db-p2p/test/util/seeded-ring.ts`), `wantK` 16, 50 topics × tiers 0, 1, 2 = 150 coordinates. A fake FRET captured the `key` the real `FretTopicRouter.routeAndAct` sent: it was the raw coordinate every time. Comparing FRET's real `assembleCohort` around `hashKey(key)` (where `routeAct` acts) with the cohort around `coord` (what the host serves):

- the peer nearest FRET's position was **not** in the served cohort for 109 of 150 coordinates;
- the two 16-peer cohorts shared **no** member for 84 of 150.

Every existing suite misses it for two reasons: every ring is no wider than one cohort, and both test fakes of FRET treat `msg.key` as the position without hashing it — `CohortMesh.routeAct` in `packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts` (`this.nearest(key)`, `this.assembleCohort(key, …)`) and `makeFakeFret` in `packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts` (`cohortFor(b64urlToBytes(msg.key))`).

## Decided fix: the router is handed the preimage, and FRET's one hash makes it the coordinate

Keep the documented rule — the db-core coordinate **is** the FRET position (the `RingHash` contract; `packages/db-p2p/test/cohort-topic/coord-byte-compat.spec.ts` pins `RingHash().H(x) == hashKey(x)`) — and change what the router is handed: the bytes `coord_d` was hashed from.

| tier | routing key (preimage) | coordinate = H(routing key) |
| --- | --- | --- |
| 0, not root-placed | `0x00 ‖ topicId` | `coord0(topicId)` |
| 0, root-placed | `rootKey` | `rootCoord(rootKey)` |
| d ≥ 1 | `d ‖ prefix(H(P), d·log₂F) ‖ topicId` | `coordD(d, P, topicId)` |

The rejected alternative — hashing on the serving side, `assembleCohort(hashKey(coord))` everywhere — breaks the `RingHash` contract, leaves the root of a root-placed topic permanently unreachable at the storage position through ring routing, and `hashKey` is asynchronous where `cohortAround` is synchronous.

### Make the wrong argument a type error (representation, not just a call-site fix)

`RingCoord` is a bare `Uint8Array` alias (`packages/db-core/src/cohort-topic/ports.ts`), which is how a coordinate slipped into a key-shaped slot. Add a branded type for the router's key in `ports.ts`, modeled on `RoutingKey` in `packages/db-core/src/network/routing-key.ts`:

```ts
declare const topicRouteKeyBrand: unique symbol;
/** The bytes a cohort-topic frame is routed on: FRET hashes them exactly once into the cohort's ring coordinate. */
export type TopicRouteKey = Uint8Array & { readonly [topicRouteKeyBrand]: true };
```

- `ITopicRouter.routeAndAct(key: TopicRouteKey, …)`. A `RingCoord` no longer type-checks there.
- `TierAddressing` gains `routeKey(d, peerId, topicId, rootKey?): TopicRouteKey` — the preimage for each row of the table above — and is the only place that mints the brand. `coord0`, `rootCoord`, `coordD` and `coord` become `H(<that preimage>)`, so the coordinate and its key cannot drift apart. Keep the existing validation (`RangeError` on an empty root key, `d` in 1..255) on the key builder.
- Export the type from db-core's cohort-topic barrel beside `RingCoord`.

A separate brand rather than reusing `RoutingKey`: `RoutingKey`'s contract is "obtainable only from `routingKeyForBlock`", and the cohort-topic preimages are not block keys. A reactivity root key happens to be one (`routingKeyForBlock(tail)`), and stays a plain `Uint8Array` `rootKey` input to `routeKey`.

### Callers

- `RouterWalkEngine.routeToTier`: `router.routeAndAct(addressing.routeKey(d, self, topicId, rootKey), …)`. The root-placed fallback now lands at `H(rootKey)` with no special case; rewrite the `NOTE:` above `routeToTier` (it describes the bug) to say the fallback reaches the root coordinate by ring routing, and that `routeToRoot` exists only because the ring's nearest peers and the key network's storage group can differ on a ring shared with another network (the reason the `ITopicRouter.routeToRoot` doc already gives).
- `registerForwarderWithParent` in `host.ts`: route at the parent's key, built from the link's own fields — `addressing.routeKey(childTier − 1, link.participantCoord, link.topicId, link.rootKey)` — rather than threading a second value through db-core's cold-start manager (`registerWithParent(topicId, parentCoord, …)` in `packages/db-core/src/cohort-topic/coldstart.ts` keeps carrying `parentCoord`, which the child-link frame and promotion still use as a coordinate). The `CoordEngineContext` needs the addressing (check whether `ctx.addressing` is already reachable there; `parentCoord` at the `registerWithParent` binding in `host.ts` is computed from `ctx.addressing.coord(...)`). Cheap guard worth having: the key's hash must equal `link.parentCoord`; if it does not, throw — it means the two derivations disagree, which is a programming fault, not a transient.
- `FretTopicRouter.routeAndAct` itself is unchanged apart from its parameter type; update its class doc (`key = coord_d(self, topicId)` → the routing key whose hash is `coord_d`), and remove the backlog-slug paragraph in the `routeToRoot` doc that cites this bug as the reason `routeToRoot` is not built on `routeAndAct` (keep the shared-ring reason). `correlation_id` is built from `bytesToB64url(key)`; fine either way.

### Make the fakes faithful

Both FRET fakes must hash the wire key exactly as FRET does, or they will keep hiding this class of bug:

- `CohortMesh.routeAct` (mesh harness): derive `position = sha256(b64urlToBytes(msg.key))` and use it for `nearest` and `assembleCohort`. Record the **position** (b64url) in `routeKeys` / `routeTrace.key` — their doc says "coords every `routeAct` was keyed at", and the assertions that read them (`live-tier.spec.ts` "the walk recomputed coord_1 and probed it" / "re-probed coord_0"; `mesh-tail-rotation.spec.ts` "routed no register frame to the tier-1 cohort"; `walkTraceFrom` in `cohort-topic-scale-antiflood.spec.ts` via a coord→tier map) compare against coordinates and then keep their meaning. Rename the fields if "Keys" now misleads (e.g. `routedCoords`); grep for every reader.
- `makeFakeFret` in `host-antidos-coldstart.spec.ts`: `cohortFor(sha256(b64urlToBytes(msg.key)))`; any assertion there that a child-link "routed to parentCoord" compares `msg.key` to the coordinate and must compare its hash (or the expected `routeKey`) instead.

db-core mock routers that ignore the key only change the parameter type; the ones that dispatch on it (`walk.spec.ts`'s routers and the `answer('coord', key, …)` at the root-placed test) must key their answers by the routing key or by its hash — pick whichever keeps each test's intent readable.

## Test that pins it (one behaviour)

In `packages/db-p2p/test/cohort-topic/topic-router.spec.ts`: the real `FretTopicRouter` over a fake FRET that captures `msg.key`, plus `createTierAddressing(RingHash-equivalent)`. For a tier-0 topic, a root-placed tier 0 (with no `rootGroupMembers`, so the fallback goes through `routeAndAct`), and tiers 1 and 2, routed through the walk's own path (`createWalkEngine` with that router, or `routeAndAct(addressing.routeKey(...))` directly if driving the walk is heavy): assert `hashKey(capturedKey)` (FRET's real `hashKey`) equals `addressing.coord(...)` for the same inputs. That one equality is the invariant — "the position FRET acts at is the coordinate the host serves" — and fails today for every row. No wide-ring arithmetic is needed once positions are equal; the measurement above is the evidence, not a test.

The child-link path is covered by the faithful `makeFakeFret` in `host-antidos-coldstart.spec.ts`: its existing faithful-path child-link test (the one using `invokeActivity`) only reaches the parent engine if the routed key hashes to the parent's served coordinate under a cohort function keyed by position.

## Documentation

- `docs/cohort-topic.md` § RouteAndMaybeAct usage: `key` = the tier's routing key — `0x00 ‖ topicId`, `rootKey`, or `d ‖ prefix(H(P), d·log₂F) ‖ topicId` — which FRET hashes once into `coord_d`; say why (FRET's `routeAct` hashes the key it is handed, at every hop). Also the walk pseudo-code near "C = coord_d(self, topicId)" / "RouteAndMaybeAct(key = C, …)".
- `docs/cohort-topic.md` § Cohort assembly: the cohort is assembled around `coord_d` itself, the same position `H(routing key)` routes to.
- `docs/cohort-topic.md` § Root placement at a routing key: if it says ring routing cannot reach the root group because of the double hash, correct it — the remaining reason for `routeToRoot` is ring-vs-storage-rule disagreement on a shared ring.
- `docs/internals.md` § Service composition: "registers at the landed cohort via the router (`key = coord_d(self, topicId)`, …)" → the routing key whose hash is `coord_d`.
- Run `yarn lint:docs` after editing; cite symbols, not lines.

## TODO

- Add `TopicRouteKey` to `packages/db-core/src/cohort-topic/ports.ts`, change `ITopicRouter.routeAndAct`'s key type, export it.
- Add `TierAddressing.routeKey` in `addressing.ts`; re-express `coord0` / `rootCoord` / `coordD` / `coord` as `H(routeKey…)`; update the module doc.
- Switch `RouterWalkEngine.routeToTier` to `routeKey`; rewrite its `NOTE:`.
- Switch `registerForwarderWithParent` (host.ts) to route at the parent's `routeKey`, with the hash-equals-`parentCoord` guard.
- Update `FretTopicRouter` docs (class doc, `routeToRoot` doc, `rootGroupMembers` option doc that mentions the fallback not reaching the group).
- Make `CohortMesh.routeAct` and `makeFakeFret` hash the wire key; fix the trace readers (`live-tier.spec.ts`, `mesh-tail-rotation.spec.ts`, `cohort-topic-scale-antiflood.spec.ts`) and any host-antidos assertion on `routeActCalls[*].key`.
- Update db-core and db-p2p mock routers for the new parameter type (`walk.spec.ts`, `service.spec.ts` in both packages, `bootstrap-evidence-envelope.spec.ts`).
- Add the one equality test to `topic-router.spec.ts`.
- Update `docs/cohort-topic.md` (three sections + walk pseudo-code) and `docs/internals.md`; run `yarn lint:docs`.
- Build (`yarn build` — db-p2p tests refuse a stale db-core build), then `yarn test` in db-core and db-p2p, and `yarn test:integration` in db-p2p (real-FRET cohort-topic and reactivity specs run there).
