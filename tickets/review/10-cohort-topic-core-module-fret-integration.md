description: Review the CohortTopicService/CohortMemberEngine composition (db-core) and the FRET host + adapters (db-p2p) that register the four /optimystic/cohort-topic/1.0.0/* protocols. Build + tests are green; several pieces are deliberately interim ("mock-tier e2e pending") — verify the gaps are sound and the seams are right.
files:
  - packages/db-core/src/cohort-topic/service.ts (participant API: register/renew/lookup/withdraw, CohortHint, RegistrationHandle)
  - packages/db-core/src/cohort-topic/member-engine.ts (cohort-side register/renew decision pipeline)
  - packages/db-core/src/cohort-topic/index.ts (now exports service + member-engine)
  - packages/db-p2p/src/cohort-topic/host.ts (composition root; registers 4 protocols + FRET activity handler)
  - packages/db-p2p/src/cohort-topic/protocols.ts (4 protocol IDs + makeCohortTopicProtocols)
  - packages/db-p2p/src/cohort-topic/topic-router.ts (FretTopicRouter → routeAct + dialProtocol)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (FretCohortGossipTransport + CohortPeerResolver)
  - packages/db-p2p/src/cohort-topic/membership-source.ts, membership-publish-sink.ts
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (INTERIM single-signer — the main gap)
  - packages/db-p2p/src/cohort-topic/size-estimator.ts (real FRET binding)
  - packages/db-p2p/src/cohort-topic/peer-codec.ts, stream-util.ts
  - packages/db-p2p/test/cohort-topic/coord-byte-compat.spec.ts (RingHash().H == FRET hashKey)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (mock-mesh flow + protocol handshake)
  - docs/architecture.md, docs/internals.md, docs/cohort-topic.md
----

# Review: CohortTopicService + full FRET integration

This is the capstone that assembles the cohort-topic substrate's prereq modules into the public
participant API (`CohortTopicService`), the cohort-side decision engine (`CohortMemberEngine`), and a
db-p2p FRET host that registers the four `/optimystic/cohort-topic/1.0.0/*` protocols and binds the
db-core ports to FRET + libp2p. The doc-sync milestone (`docs/architecture.md` Doc Sync Status →
*cohort-topic substrate implemented, mock-tier e2e pending*) is landed.

## What was built

**db-core (pure logic, no FRET import):**
- `service.ts` — `CohortTopicService` (`register` / `renew` / `lookup` / `withdraw`, `cohortGossip()`,
  `verifier()`, `onLocalCommit?`), plus `CohortHint`, `RegistrationHandle`, `RegisterRequest`,
  `CohortBackoffError`, `ParticipantSigner`. Composes the `WalkEngine`, `d_max` computer, tier
  addressing, and the participant-side `RenewalParticipant` over injected ports.
- `member-engine.ts` — `CohortMemberEngine`: the inbound-`RegisterV1`/`RenewV1` decision pipeline the
  FRET activity callback runs. Anti-DoS guards → hot/cold dispatch (willingness, promoted-bounce,
  cold-start) → admission (slot assign, store put, traffic count, promotion trigger, traffic signal).

**db-p2p (FRET + libp2p binding):**
- `protocols.ts` — the four protocol IDs + `makeCohortTopicProtocols(networkName)`.
- `host.ts` — `createCohortTopicHost(node, fret, opts)`: registers the four protocol handlers, sets
  FRET's activity handler (decode `RegisterV1` frame → engine → `commitCertificate`), and composes the
  full db-core substrate over the FRET-backed adapters.
- Adapters: `FretSizeEstimator` (real `getNetworkSizeEstimate` binding), `FretTopicRouter` (real
  `routeAct` + `dialProtocol`), `FretCohortGossipTransport` + `FretMembershipSource` /
  `FretMembershipPublishSink` (libp2p protocol broadcast/serve), `FretCohortThresholdCrypto`
  (**interim** — see gaps), plus `peer-codec.ts` / `stream-util.ts` helpers.

## Validation done (test floor — treat as a floor, not a ceiling)

- `coord-byte-compat.spec.ts` — asserts db-core `RingHash().H(x)` == FRET `hashKey(x)` byte-for-byte at
  256-bit ring width (the deferred-from-`cohort-topic-package-layering` assertion). **Passes.**
- `service.spec.ts` — mock-transport single-member cohort: `register → accepted`, `renew` keeps the
  primary, `lookup` resolves the hint, and `promote` redirects new registrations once direct
  participants cross `cap_promote`. Plus a host-handshake test asserting all four protocol IDs are
  registered via `node.handle`. **All pass.**
- `yarn build` green for db-core and db-p2p. `yarn test` green: db-core 533 passing; db-p2p 513
  passing / 9 pending / 0 failing.

## Known gaps — these are deliberate and need review judgement (not silent shortcuts)

1. **Threshold crypto is interim** (`threshold-crypto.ts`). `assemble` returns a single-signer
   `sha256(payload)` digest, not a real `k − x` FRET cohort threshold signature. Consequence: at the
   production `minSigs = 14`, `CohortSigner.verifyThreshold`'s `≥ minSigs distinct members` rule cannot
   be satisfied by one signer — so promotion-notice / membership-cert *verification* won't pass on a
   live multi-node cohort. This is the core of "mock-tier e2e pending." The real binding is a
   multi-round cohort operation over FRET's two-sided cohort-signature machinery. **Recommend a
   follow-on fix ticket** for the real assembly; verify the seam (`ICohortThresholdCrypto`) is the
   right place for it.
2. **Per-coord cohort scoping.** The host composes ONE node-level engine whose `cohort()` is the FRET
   assembly around the node's own ring position, with `treeTier` hardwired to 0, `childCohortCount`
   0, and `followOn` always false on the direct/activity path. A node really belongs to many cohorts
   (one per served coord); a per-coord engine map is deferred. Verify this doesn't mislead callers and
   that a follow-on is warranted.
3. **Participant signatures + cold-start parent registration are stubs in the host** (`signRegister`/
   `signRenew` return `""`; `parentRegistrar.registerWithParent` is a no-op). Peer-key signing is the
   threshold-gap's sibling.
4. **Per-touch gossip replication not driven.** The host's `RenewalGossip.touch`/`evicted` are no-ops
   and no timer publishes `CohortGossipV1` (willingness bits / load buckets / summaries). The bus
   merge/broadcast logic itself is wired and unit-tested in db-core; only the host-side *publishing
   cadence* is absent.
5. **`lookup()` shares the registration walk** — it resolves via the accepted reply and leaves
   short-lived soft-state that TTL-expires (no dedicated read-only probe RPC). **`withdraw()`** ceases
   renewal (natural TTL expiry); there is no explicit tombstone/`ttl=0` wire message (`RenewV1` has no
   ttl field). Both are documented follow-ons — confirm the API contract wording is acceptable.
6. **`promote` protocol handler decodes but does not verify-and-apply** notices (tied to gap 1).

## Suggested review focus / use cases

- **Coord wire compatibility:** confirm the byte-compat test's inputs are representative and that the
  `base64url` encoding `FretTopicRouter` uses for the `RouteAndMaybeAct.key` matches FRET's
  `coordToBase64url` (it is not exported by the published `p2p-fret`, so db-core's `bytesToB64url` is
  used — both are RFC4648 base64url no-pad, but worth a second look).
- **Peer-id representation:** `peer-codec.ts` encodes cohort-member ids as UTF-8 of the peer-id string
  (so they round-trip to a dialable `PeerId`), while the participant's addressing `P` is the FRET ring
  coord (`hashPeerId`). Check this split is coherent and that slot assignment over UTF-8 member bytes
  is acceptable.
- **Walk termination on a promoted single-cohort:** with `followPromoted = true`, a walk that keeps
  hitting the same promoted cohort would oscillate to the `maxSteps` cap → `retry_later`. The mock
  test exercises the engine's `promoted` reply directly rather than the full walk for this reason —
  verify the real multi-coord topology avoids the oscillation.
- **Anti-DoS gates** in `member-engine.ts` are all optional-injected and currently NOT wired by the
  host (rate limiter / replay guard / topic budget / bootstrap evidence are `undefined` there). The
  engine handles their absence; confirm the host should wire them and whether that belongs here or in
  a follow-on.

## Done-when (met)
- `yarn build` green for db-core and db-p2p. ✅
- `yarn test` green for db-core and db-p2p including the service spec. ✅
- `docs/architecture.md` Doc Sync Status shows cohort-topic substrate implemented (mock-tier e2e
  pending); `docs/internals.md` has the cohort-topic subsystem section; `docs/cohort-topic.md`
  §FRET integration confirmed. ✅
