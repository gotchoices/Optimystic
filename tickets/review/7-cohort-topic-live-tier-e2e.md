description: Review the cohort-topic live-tier end-to-end milestone — an in-process multi-node cohort (real Ed25519 keys, mock transport) that registers, threshold-signs, gossips, and promotes end-to-end, plus the host `capPromote` test seam and the doc flips.
files:
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (NEW — the e2e; the bulk of the review surface)
  - packages/db-p2p/src/cohort-topic/host.ts (added a `promotion?: PromotionConfig` option + header note)
  - docs/cohort-topic.md (§FRET integration → added a "Validation" subsection; deferrals listed)
  - docs/architecture.md (Doc Sync Status: cohort-topic Mock-tier e2e pending → done)
----

# Review: cohort-topic live-tier end-to-end milestone

## What landed

The parent plan's done-when: a real multi-node cohort registers, threshold-signs, gossips, and promotes
end-to-end, and the docs flip from "mock-tier e2e pending" to done. All the machinery was built by the
prereq tickets (`cohort-topic-threshold-assembly`, `-promote-verify-apply`, `-gossip-cadence`,
`-host-antidos-coldstart`); this ticket proves it **composes** and records the milestone.

### `live-tier.spec.ts` (the deliverable)

An `N = 5`, `wantK = 5`, `minSigs = 4` in-process cohort. Each node is a **real `generateKeyPair('Ed25519')`**
identity behind a `createCohortTopicHost(node, fret, { privateKey, … })`. The transport is a mock that
routes the five cohort-topic protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`)
and FRET's `routeAct`/`assembleCohort` directly between the in-process node engines — no real libp2p
sockets:

- **`MockStreamEnd` / `streamPair()`** — an in-memory half-duplex pipe: `send` enqueues onto the peer's
  inbox, `close` (close-write) signals EOF, and the async iterator drains this end's inbox until the
  peer closes. This is what p2p-fret's `readAllBounded` iterates, so a `requestResponse` / `sendOneWay`
  from one host drives the target host's real protocol handler and reads its real reply, EOF-prompt (no
  100 ms idle-timeout wait).
- **`MockNode`** — the libp2p stand-in: `handle`/`unhandle`, `getConnections → []` (forces the
  `dialProtocol` path), and `dialProtocol` resolves the target in a shared registry and hands its
  handler one stream end. A `down` set makes a node unreachable (the sub-quorum case). `receive()`
  injects a one-way frame as the inbound transport seam (willingness seeding).
- **`CohortMesh`** — the shared FRET: `assembleCohort(coord, wants)` = all members sorted by XOR
  distance of their ring position (`hashPeerId`) to `coord` (so every node computes the **identical**
  cohort + epoch); `routeAct` routes to the nearest node and invokes its activity handler; per-node
  `getNetworkSizeEstimate` fixes `d_max`.

The six `it` blocks map 1:1 to the milestone:

1. **Real cohort** — the tier-0 cohort = `assembleCohort(coord_0(topic))` = all N nodes, and every node
   derives one identical cohort epoch (the determinism threshold collection depends on).
2. **Register through the walk** — `nodes[0].service.register(...)` runs a real walk-toward-root over the
   mock router and resolves an `accepted` handle whose `primary` is a cohort member and whose
   `cohortMembers` is the N-node set.
3. **Real threshold signature** — `onStabilized` publishes a collected `k − x` `MembershipCertV1`; a
   *different* node's `verifier().verifyMessage(...)` fetches it over the `membership` protocol and
   accepts it (`verified`); a forged single-signer cert is `untrusted`.
4. **Promotion end-to-end** — past `cap_promote` (lowered to 4 via the new host option), the cohort
   threshold-signs a `PromotionNoticeV1`, the host broadcasts it over `promote`, a node that did **not**
   originate it verify-applies it (over `promote` + `membership`), a registration past the cap gets a
   `Promoted(1)` redirect, and a later walk recomputes `coord_1`, gets `no_state`, walks back to 0, and
   terminates with a `CohortBackoffError` within `maxSteps`.
5. **Gossip replication** — a record accepted on the routed primary replicates into a sibling store in
   one gossip round; an eviction converges.
6. **Negative (sub-quorum)** — with one node `down` and `minSigs = N`, assembly **throws** rather than
   fabricating a single-signer cert (no fallback).

### Supporting change

`host.ts`: added `CohortTopicHostOptions.promotion?: PromotionConfig`, threaded through
`CoordEngineContext.promotionConfig` into each engine's `createPromotionLifecycle` (replacing the
hard-coded `{ capPromote: undefined }`). This is the test seam that lets the e2e drive promotion with a
small participant count; production defaults (`cap_promote = 64`) are unchanged when the option is
omitted. The coord-derived inputs (`treeTier` / `childCohortCount` / `parentCoord`) are **not**
overridable. Also updated the host header JSDoc note (was "mock-tier e2e pending").

## How to validate

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/live-tier.spec.ts" --reporter spec   # 6 passing (~0.6s)
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min                       # 570 passing, 9 pending
./node_modules/.bin/tsc --noEmit                                                                                       # clean (use the workspace TS 5.9.3, not a global tsc)
```

(Note: a *global* `tsc` may reject the repo tsconfig's deprecated `downlevelIteration` — a pre-existing
config nit, unrelated to this diff. The workspace-pinned `tsc` is clean.)

## Where to look hard (honest gaps — treat the tests as a floor)

- **Willingness seeding is a test seam, not organic.** An idle coord engine builds **no** gossip frame
  (`buildCohortGossip` skips when there are no topics and no deltas), so the *first* registration's
  willingness quorum can never be met by organic gossip — `setupTopic` injects each sibling's signed
  willingness frame through the real `cohort-gossip` handler to bootstrap it (the same pattern the
  gossip-cadence unit tests use). This is faithful to how the substrate *would* be seeded but it does
  mean the e2e does **not** exercise willingness propagating purely organically. Worth a reviewer's
  judgement on whether that masks a real "cold cohort can't bootstrap its own willingness" gap in the
  production wiring (likely a separate concern — the periodic driver only gossips non-idle engines).
- **Assertion 1 is weak on "per-coord scoping" specifically.** With `wantK = N`, `assembleCohort(coord_0)`
  is trivially the whole network, so it can't show a *subset* differing from a node's ring neighbours.
  The strict per-coord scoping (cohort around `coord_0(topic)` ≠ ring neighbours) is only covered by the
  existing `service.spec.ts` unit test (a FRET fake returning a different set per coord). The live test
  instead asserts determinism (identical cohort+epoch on every node), which is the property the
  threshold collection actually needs. Reviewer may want a stronger live-scoping assertion with
  `wantK < N`.
- **Bulk promotion registrations bypass the walk.** For speed, the `cap_promote` participants are driven
  directly via `decidingEngine.engine.handleRegister(...)` (real signed `RegisterV1`s, real willingness),
  not through `service.register`'s full walk. Only assertion 2 and the post-promotion redirect exercise
  the end-to-end walk. If the reviewer wants every registration to ride the router, that's a (slower)
  change.
- **Promotion timing is poll-based.** `firePromotion` is fire-and-forget; the test `waitFor(...)`-polls
  `isPromoted` with an 8 s ceiling (actual settle ~tens of ms). Deterministic-but-not-flaky by
  construction, but it is wall-clock polling, not a driven tick — scrutinize if you dislike that.
- **Cert verification is cert-as-message.** Assertion 3 verifies the `MembershipCertV1` against itself
  (the established `threshold-assembly.spec.ts` pattern). The *notice* verify path is covered separately
  by assertion 4 (the sibling's `verifyAndApplyNotice`). No single test verifies an arbitrary
  threshold-signed *application* message, because none exists yet.
- **Negative case asserts the cert path, not the notice path.** Assertion 6 shows `onStabilized` throws
  under sub-quorum. The promotion-notice-not-produced path under sub-quorum is implied (same assembler)
  but not directly asserted.
- **`d_max` is pinned via `sizeEstimate = 256` → `d_max = 1`.** Chosen so the walk exercises a tier-1
  probe then a walk-back. If `dmax.ts`'s `floorLogF` math changes, the walk-trail assertions
  (`coord_1` probed) would need revisiting.
- **Mock `MockStreamEnd` faithfulness.** The half-close model is deliberately simpler than a real libp2p
  muxer (no backpressure, no partial frames, no mid-stream reset). It's sufficient for the
  one-frame-each-way cohort protocols but is **not** a substitute for the real-libp2p (socket) e2e tier,
  which stays `pending`.

## Still deferred (parked in backlog — intentionally out of scope)

- Multi-tier promoted-redirect **follow-on** instantiation (`cohort-topic-followon-derivation`) and the
  parent-side child-cohort **link recording** (`cohort-topic-parent-child-link`). This milestone serves a
  single tier-0 cohort, so `followOn` stays `false` and `childCohortCount` is `0`.
- A dedicated read-only **lookup-probe** RPC (today `lookup` shares the registration walk).
- An immediate **withdraw tombstone** (today `withdraw` stops renewing; soft state TTL-expires).
- The **real-libp2p (socket) e2e** tier.
