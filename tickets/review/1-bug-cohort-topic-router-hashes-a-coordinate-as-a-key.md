description: On a network wider than one cohort, a cohort-topic registration was delivered to different machines than the ones that serve the topic, because the router handed the ring routing step a coordinate that the routing step then hashed again. The router is now handed the bytes the coordinate is the hash of, so the one hash lands on the coordinate; review the fix, the new type that makes the old mistake a compile error, and the test fakes that now hash the way the real routing does.
architecture: docs/cohort-topic.md#routeandmaybeact-usage
files: packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/addressing.ts, packages/db-core/src/cohort-topic/walk.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/topic-router.spec.ts, packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts, packages/db-p2p/test/cohort-topic/service.spec.ts, packages/db-core/test/cohort-topic/walk.spec.ts, packages/db-core/test/cohort-topic/service.spec.ts, packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts, docs/cohort-topic.md, docs/internals.md
repro: verified
----

# The cohort-topic router hashed a coordinate as if it were a key — fixed

## What was wrong

A cohort-topic cohort lives at ring coordinate `coord_d` (a SHA-256 digest from `HashTierAddressing`). The serving side assembles the cohort around `coord_d` itself. The routing side (`FretTopicRouter.routeAndAct`) put `coord_d` into `RouteAndMaybeActV1.key`, and FRET's `routeAct` hashes the key it is handed (at the origin and at every hop), so frames were acted on near `H(coord_d)`. The fix stage measured it on a 64-peer ring with 16-peer cohorts: the peer FRET acted at was outside the served cohort for 109 of 150 coordinates, and the two cohorts shared no member for 84 of 150.

## What changed

- **`TopicRouteKey`** (`packages/db-core/src/cohort-topic/ports.ts`): a branded `Uint8Array`, the only type `ITopicRouter.routeAndAct` accepts. A `RingCoord` no longer type-checks there. Exported through the cohort-topic barrel (it is in `ports.ts`, which the barrel re-exports whole).
- **`TierAddressing.routeKey(d, peerId, topicId, rootKey?)`** (`addressing.ts`): the only place the brand is minted. Returns `0x00 ‖ topicId` (tier 0), `rootKey` (tier 0, root-placed), or `d ‖ prefix(H(P), d·log₂F) ‖ topicId` (tier ≥ 1). `coord0`, `rootCoord`, `coordD` and `coord` are now `H(<that preimage>)` through three private builders, so a coordinate and its key cannot drift. Validation unchanged in substance (empty root key, `d` in 1..255 → `RangeError`); the two messages were reworded to not name `coordD`/`rootCoord`, since `routeKey` throws them too (no test matched the old text).
- **Walk** (`RouterWalkEngine.routeToTier`, `walk.ts`): routes on `addressing.routeKey(...)`. The root-placed fallback (router without `routeToRoot`) now lands at `H(rootKey)` with no special case; its `NOTE:` was rewritten to say `routeToRoot` exists only for a ring shared with another network.
- **Cold-start child link** (`registerForwarderWithParent` → new `parentRouteKey` in `host.ts`): routes on `ctx.addressing.routeKey(childTier − 1, link.participantCoord, link.topicId, link.rootKey)`, and throws if `ctx.hash.H(key)` ≠ `link.parentCoord`. The throw leaves the forwarder `awaiting_parent` (cold-start's fire-and-forget logs it as a WARN). `coldstart.ts` is untouched — it still carries `parentCoord`.
- **`FretTopicRouter`**: only the parameter type changed, plus docs (class doc, `routeToRoot` doc, `rootGroupMembers` option doc). The backlog-slug paragraph is gone; the shared-ring reason stays.
- **Faithful fakes**: `CohortMesh.routeAct` (mesh harness) now does `position = await hashKey(b64urlToBytes(msg.key))` (p2p-fret's real `hashKey`) for `nearest` and `assembleCohort`. Renamed `routeKeys` → `routedCoords` and `RouteTraceEntry.key` → `coord`; both now hold the position, so every reader (`live-tier.spec.ts`, `mesh-tail-rotation.spec.ts`, `walkTraceFrom` used by `cohort-topic-scale-antiflood.spec.ts`) keeps comparing against coordinates. `makeFakeFret` in `host-antidos-coldstart.spec.ts` hashes the key the same way before `cohortFor`, and the child-link test now asserts that the *hash* of the routed key is `parentCoord` (and is not the served coord).
- **Mock routers**: db-core `walk.spec.ts` routers record `coord: ringHash.H(key)` (so every existing coordinate assertion keeps its meaning); the root-placed test hashes `steps[0].key` before comparing. The other mocks (`service.spec.ts` in both packages, `bootstrap-evidence-envelope.spec.ts`) only had their parameter type changed.
- **Docs**: `docs/cohort-topic.md` § RouteAndMaybeAct usage (the three key shapes, why, the type, the faithful fakes), § Cohort assembly (assembled around `coord_d`, the same position `H(routing key)` routes to), § Root placement at a routing key (the double-hash paragraph replaced with the shared-ring reason), § Tier addressing implementation note, and the walk pseudo-code/implementation note. `docs/internals.md` § Service composition. `yarn lint:docs` clean.

## Tests

Added one test, `packages/db-p2p/test/cohort-topic/topic-router.spec.ts` "the hash FRET takes of every routed key is the coordinate the host serves, with and without a root key": the real `FretTopicRouter` under the real walk (`createWalkEngine`, `d_max` 2, a fake FRET that answers every step with a bare anchor so the walk goes 2 → 1 → 0 → root bootstrap re-issue), with no `rootGroupMembers` so the root-placed root step goes through `routeAndAct`. For every routed frame it asserts p2p-fret's `hashKey(msg.key)` equals `addressing.coord(treeTier, self, topicId, rootKey)`. **Verified it fails** when `routeToTier` is temporarily switched back to handing over `coord(...)` (cast to the brand): "default addressing: tier 2 lands on coord_2" fails. Restored and rebuilt afterward.

No other test added. The child-link path is pinned by the existing host-antidos test, whose assertion now reads the hash of the routed key.

## Validation run

- `yarn build` — clean (db-p2p's build type-checks its specs).
- `yarn workspace @optimystic/db-core test` — 1855 passing.
- `yarn workspace @optimystic/db-p2p test` — 3199 passing, 65 pending.
- `yarn workspace @optimystic/db-p2p test:integration` — 46 passing, 2 pending (real-FRET cohort-topic and reactivity specs).
- `quereus-plugin-optimystic`'s `network-change-notification.integration.spec.ts` (network watch over a real cohort-topic node) — passing. The rest of that package's integration suite was not run; it does not touch cohort-topic.
- `eslint` on the touched files — clean.

## Things for the reviewer to weigh

- **The child-link guard is reachable by input, not only by a programming fault.** The ticket called a mismatch a programming fault. It can also happen like this: a tier-1 engine has picked up a root key from an earlier frame, and then a frame that names no root key instantiates its forwarder. The dispatch path computes `parentCoord` from the frame (`coord0(topicId)`), while the key is built from the engine's root key (`H(rootKey)`). The guard then refuses the link, and the forwarder stays `awaiting_parent` with a WARN in the log. Before this change that case routed the link to `coord0(topicId)` while the link frame itself named the root key, which was already inconsistent. Only a host *without* root-group support takes the `routeAndAct` branch, and such a host refuses root-keyed register frames up front, so the case looks hard to reach in production. I did not add a test for it. Decide whether a refusal is the right answer, or whether the link should follow one of the two derivations.
- **Ring width.** `RingHash` truncates when `ringBits < 256`, while FRET's `hashKey` is always the full SHA-256, so `H(routeKey)` equals FRET's position only at the default width. That was already the documented contract (`coord-byte-compat.spec.ts`). The fix depends on it more directly now, but no code path uses a narrower ring.
- **`routeKey` at tier 0 with a root key returns the caller's own `rootKey` buffer**, cast to the brand rather than copied. Nothing mutates it on the routing path (the router base64url-encodes it). Mentioned in case a reviewer wants a defensive copy.
- **Harness field rename**: `routeKeys` → `routedCoords` and `RouteTraceEntry.key` → `.coord`. Every reader in the repo was updated (grep found five). An out-of-tree consumer of `@optimystic/db-p2p/testing`, if any exists, would break; backward compatibility is not a goal yet (AGENTS.md).
