description: Close the deliberately-interim "mock-tier → live-tier" gaps in the cohort-topic FRET host so a real multi-node cohort can register, threshold-sign, gossip, and promote end-to-end. The substrate logic (db-core) and the cleanly-mappable adapters (db-p2p) landed and are mock-tier validated; this ticket designs the remaining cohort-distributed pieces that one node cannot fake.
files:
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (interim single-signer sha256 → real k−x assembly)
  - packages/db-p2p/src/cohort-topic/host.ts (per-coord engine map, participant signing, promote verify-apply, anti-DoS wiring, gossip cadence, cold-start parent registration)
  - packages/db-core/src/cohort-topic/member-engine.ts (anti-DoS guard injection points; per-coord context)
  - packages/db-core/src/cohort-topic/service.ts (participant signer seam)
  - packages/db-core/src/cohort-topic/membership/* , gossip/* (verify-and-apply + publish cadence consumers)
  - docs/cohort-topic.md §FRET integration, docs/architecture.md Doc Sync Status (flip mock-tier e2e → done when met)
----

# Cohort-topic: live-tier FRET binding (close the mock-tier gaps)

The cohort-topic substrate shipped with a deliberately-interim db-p2p host: it composes the full
db-core substrate over the FRET/libp2p adapters, registers all four protocols, and is validated at
**mock-tier** (`packages/db-p2p/test/cohort-topic/service.spec.ts`). The review of
`cohort-topic-core-module-fret-integration` confirmed the **seams are right** and the gaps are sound
and well-isolated — they are not shortcuts in the wired surface but genuinely cohort-distributed
operations that a single node cannot stand in for. This ticket plans wiring them so a real multi-node
cohort works end-to-end (the `architecture.md` Doc Sync "mock-tier e2e pending → done" milestone).

## The gaps (all verified isolated to the named seams during review)

1. **Real `k − x` threshold-signature assembly** (`threshold-crypto.ts`, `ICohortThresholdCrypto`).
   The interim `assemble` returns `{ thresholdSig: sha256(payload), signers: [self] }` — a single
   signer that cannot satisfy `CohortSigner.verifyThreshold`'s `≥ minSigs distinct members` rule at
   the production `minSigs = 14`. The real binding is a multi-round cohort operation collecting
   signatures from a quorum of the FRET-assembled cohort over FRET's two-sided cohort-signature
   machinery (without modifying FRET). This is the spine of the milestone — promotion-notice and
   membership-cert verification cannot pass on a live cohort until it lands. The `ICohortThresholdCrypto`
   seam is the right injection point (verified); the open question is the round protocol + which
   FRET primitive carries the partial sigs.

2. **Participant peer-key signing** (`host.ts` `participantSigner`, `service.ts` `ParticipantSigner`).
   `signRegister` / `signRenew` currently return `""`. Real binding signs the `RegisterV1` / `RenewV1`
   body with the node's libp2p peer key so a cohort member can trust the `participantCoord` and a
   `reattach` attestation cannot be forged. Sibling of gap 1.

3. **Per-coord cohort scoping** (`host.ts`). The host composes ONE node-level engine whose `cohort()`
   is the FRET assembly around the node's *own* ring position, with `treeTier` hardwired to 0,
   `childCohortCount` 0, and `followOn` always false on the direct/activity path. A node really belongs
   to many cohorts (one per served coord). Design a per-coord engine map (or a coord-parameterized
   engine) so registrations landing at different coords are served by the right cohort context. Verify
   walk termination on a promoted single-cohort no longer risks the `maxSteps` oscillation the mock
   test sidesteps.

4. **`promote` verify-and-apply** (`host.ts` promote handler — currently decodes nothing and replies
   `undefined`). Once gap 1 lands, the handler must verify the threshold-signed notice and apply the
   promotion/demotion to local state. Tied to gap 1.

5. **Gossip publishing cadence** (`host.ts` `RenewalGossip.touch`/`evicted` are no-ops; no timer
   publishes `CohortGossipV1`). The bus merge/broadcast logic is wired and db-core-unit-tested; only
   the host-side per-touch replication + periodic willingness/load/summary publish is absent. Decide
   the cadence and drive it (likely a timer + the renewal touch hook).

6. **Anti-DoS wiring** (`member-engine.ts` rate limiter / replay guard / topic budget / bootstrap
   evidence are all optional-injected and `undefined` in the host). The engine handles their absence;
   decide whether the host wires them here or whether a node-level policy object owns them. Note: gap
   relevant to the correlation-id fix made during review — the replay guard keys on `correlationId`,
   which is now a fresh CSPRNG value per probe (was a clock-derived value that could collide).

7. **Cold-start parent registration** (`host.ts` `parentRegistrar.registerWithParent` is a no-op).
   A freshly-instantiated forwarder must register with its tier-`(d−1)` parent cohort over the router.

## Out of scope (separate, smaller follow-ons — file if/when prioritized)

- A dedicated **read-only `lookup` probe RPC** so `lookup()` stops sharing the registration walk and
  leaving TTL-expiring soft state.
- An explicit **withdraw tombstone** (`ttl = 0` / dedicated wire message) so `withdraw()` proactively
  frees cohort state instead of waiting for TTL expiry. (Local renewal-stop now works after the review
  fix; this is the *remote* half.)

## Done-when
- A real (mock-libp2p or in-process multi-node) test stands up a ≥`minSigs` cohort, registers a
  participant through the walk, assembles a real threshold signature, and verifies a promotion notice
  and a membership cert end-to-end.
- `architecture.md` Doc Sync Status flips cohort-topic substrate mock-tier e2e → done.
