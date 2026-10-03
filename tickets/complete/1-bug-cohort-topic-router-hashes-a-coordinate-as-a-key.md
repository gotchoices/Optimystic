description: On a network wider than one cohort, a cohort-topic registration was delivered to different machines than the ones that serve the topic, because the router handed the ring routing step a coordinate that the routing step then hashed again. The router is now handed the bytes the coordinate is the hash of, a new type makes handing it a coordinate a compile error, and the test fakes hash the key the way the real routing does.
architecture: docs/cohort-topic.md#routeandmaybeact-usage
files: packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/addressing.ts, packages/db-core/src/cohort-topic/walk.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/topic-router.spec.ts, packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts, packages/db-core/test/cohort-topic/walk.spec.ts, docs/cohort-topic.md, docs/internals.md
repro: verified
----

# The cohort-topic router hashed a coordinate as if it were a key — fixed

## What was wrong

A cohort-topic cohort lives at ring coordinate `coord_d` (a SHA-256 digest from `HashTierAddressing`), and the serving side assembles it around `coord_d`. `FretTopicRouter.routeAndAct` put `coord_d` into `RouteAndMaybeActV1.key`, and FRET's `routeAct` hashes the key it is handed (at the origin and at every hop), so frames were acted on near `H(coord_d)`. On a 64-peer ring with 16-peer cohorts the acting peer was outside the served cohort for 109 of 150 coordinates.

## What landed (`ticket(implement): bug-cohort-topic-router-hashes-a-coordinate-as-a-key`)

- `TopicRouteKey` (`packages/db-core/src/cohort-topic/ports.ts`): a branded `Uint8Array`, the only type `ITopicRouter.routeAndAct` accepts.
- `TierAddressing.routeKey` (`addressing.ts`): the only place the brand is minted — `0x00 ‖ topicId`, `rootKey`, or `d ‖ prefix(H(P), d·log₂F) ‖ topicId`. Every coordinate is computed as `H(routeKey)` through shared private builders, so the two cannot drift.
- The walk (`routeToTier`) and the cold-start child link (`parentRouteKey` in `host.ts`, which refuses a key that does not hash to `link.parentCoord`) route on the key.
- The FRET fakes (`CohortMesh` in the mesh harness, `makeFakeFret` in the host anti-DoS spec, the db-core walk mock routers) hash the key the way FRET does. Harness fields renamed `routeKeys` → `routedCoords`, `RouteTraceEntry.key` → `.coord`.
- Docs: `docs/cohort-topic.md` §RouteAndMaybeAct usage, §Cohort assembly, §Root placement at a routing key, the tier-addressing and walk implementation notes; `docs/internals.md` §Service composition.

## Review findings

Read the implement diff in full before the handoff, then each touched file around its change.

**Found and fixed in this pass**

- **Router correlation id (regression, fixed).** `FretTopicRouter.routeAndAct` built `correlation_id` as `base64url(key) + ":" + ms`. With the key now the preimage rather than a 32-byte coordinate, a root-placed tier-0 key can be any root key the wire admits (`MAX_ROOT_KEY_BYTES` = 256), and FRET's forwarding-hop validator (`parseRouteAndMaybeAct` in p2p-fret's `rpc/validate.ts`) refuses a correlation id over 256 characters — so a root key over 181 bytes would have been silently dropped at the first forwarding hop, through the `routeAndAct` fallback (host without root-group support) or a child link. The key-derived id was also wrong before this change: FRET answers a repeated `correlation_id` from its dedup cache, so two participants routing the same tier key in the same millisecond (from any origins) could be handed the first one's cached reply. The id is now `base64url(16 random bytes) + ":" + ms` (`@libp2p/crypto` `randomBytes`, already used in db-p2p). Nothing reads the id on the serving side (the host's activity handler ignores it). Added one test in `packages/db-p2p/test/cohort-topic/topic-router.spec.ts` that routes two frames on a 256-byte root key and asserts both pass FRET's own `parseRouteAndMaybeAct` and carry distinct ids; verified it fails with the old id and passes with the new one.
- **Child-link guard decision (implementer asked).** Kept the refusal. The link frame `registerForwarderWithParent` builds names the engine's root key, and the parent picks its engine from the frame, so the root-key-derived route key is the consistent target and `parentCoord` (from the instantiating frame) is the odd one out; refusing is safer than routing to either when they disagree. The path needs a host without root-group support whose tier-1 engine adopted a root key, which such a host's dispatch refuses up front, so it is contrived. Parked as a `NOTE:` on `parentRouteKey` in `host.ts` naming the remedy (derive `parentCoord` from the engine's current root key) if it ever appears in logs.

**Checked, no change**

- Correctness / call sites: `routeAndAct` has exactly two callers (`RouterWalkEngine.routeToTier`, `registerForwarderWithParent`), both now on route keys; `FretTopicRouter` is the only `fret.routeAct` caller. Every other coordinate consumer (`assembleCohort` in host, matchmaking `query-transport.ts`, membership source, trust anchors) takes an already-hashed position, which is correct. The host's served-coord recomputation (`addressing.coord(...)` in `dispatchRegister`) matches `H(routeKey)` by construction.
- Type safety: the brand is minted only in `addressing.ts`; mocks implementing `ITopicRouter` type-check with the new signature; no `as TopicRouteKey` casts outside addressing.
- Ring width (tripwire, implementer flagged): `H(routeKey)` equals FRET's position only at the default 256-bit `RingHash`; every construction in db-p2p uses the default and `coord-byte-compat.spec.ts` pins the contract. Already stated in the `addressing.ts` module doc; no new note.
- `routeKey` returning the caller's `rootKey` buffer uncopied: the router only base64url-encodes it. No change.
- Harness rename: all five readers in the repo updated; backward compatibility is not a goal (AGENTS.md).
- Tests: the implementer's new walk-under-router test reproduces the defect at the lowest layer with the real router and walk (they verified it fails on the old code) — kept. The mock-router edits only re-express existing assertions in coordinate terms. No test cut.
- Docs: every touched doc reads correctly; grepped docs and package docs for leftover `key = coord`, `H(H(`, and the old backlog slug — none. The correlation id is not described in any doc.
- Performance / resource cleanup: one extra hash per child link (the guard) and one `randomBytes(16)` per routed frame; negligible against a network round trip. No new resources.
- Source hygiene: comments added say why (FRET hashes the key; dedup and length limits), not what.

**Validation**

- `yarn workspace @optimystic/db-p2p build` — clean (type-checks specs).
- `yarn test -- --grep "cohort-topic|reactivity|matchmaking"` in db-p2p — 552 passing, 21 pending (after the router change; the new test passes, 4 passing in the topic-router spec).
- `OPTIMYSTIC_INTEGRATION=1 yarn test:integration -- --grep "cohort|reactivity|matchmaking"` in db-p2p — 13 passing, 2 pending (real FRET routing with the new correlation id).
- `eslint` on the changed files — clean.
- Not re-run in this pass: the full db-core and db-p2p suites (the implementer ran both green; this pass changed only the router's correlation id, a `NOTE:` comment, and one spec).
