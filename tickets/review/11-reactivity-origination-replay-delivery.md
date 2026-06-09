description: Review the reactivity hot-path implementation — wire codecs, tail-anchored topic, notification origination (commit-cert reuse), W=256 replay ring + sliding dedupe, forwarder receive path, and subscriber verify/deliver with gap→backfill seam.
files: packages/db-core/src/reactivity/*, packages/db-p2p/src/reactivity/*, packages/db-core/test/reactivity/*, packages/db-p2p/test/reactivity/managers.spec.ts, docs/reactivity.md
----

# Review: reactivity core — subscription, origination, replay buffer, dedupe, delivery

Adversarial review of the reactivity **hot path** built on the cohort-topic substrate. The work is
logic-complete and tested at unit tier; the network transport for notification fan-out is intentionally
a seam (see **Known gaps**). Treat the tests as a floor, not a finish line.

## What landed

### db-core `packages/db-core/src/reactivity/` (pure logic)
- **`config.ts`** — single defaults table `DEFAULT_REACTIVITY_CONFIG` (`W=256`, `dedupe_window=64`,
  `delta_max` Core 4096 / Edge 0, TTLs Core 90 s / Edge 60 s, plus reserved `W_checkpoint`/`queue_max`/
  rotation defaults). `W`/`dedupe_window` marked simulator-validated-pending. `resolveW({cps,minCoverageSeconds,maxW})`
  is the adaptive hook (static default unless a `cps` is supplied). `deltaMaxForProfile` / `subscriberTtlForProfile`.
- **`topic-anchor.ts`** — the shared pure helper `reactivityTopicId(tailId) = H(tailId ‖ "reactivity")`
  (consumed here and reused per-emission by the rotation ticket) + `createReactivityTopicAnchor`.
- **`wire.ts`** — `SubscribeAppPayloadV1` (opaque `RegisterV1.appPayload`) and `NotificationV1`
  (length-framed) codecs + structural validation; base64url bytes, unix-ms timestamps, round-trip stable.
- **`notification.ts`** — `buildNotificationV1(event, cert, ctx)` reusing `cert.thresholdSig` bit-for-bit;
  honors `deltaMaxBytes == 0` (omit `delta`); `sigDigest` / `dedupeKey` helpers.
- **`dedupe.ts`** — sliding `(revision, sigDigest)` window with the highest-revision / recovery-retransmit
  rules + intra-cohort gossip serialize/merge.
- **`replay-buffer.ts`** — `W`-entry ring keyed by revision (out-of-order retransmits land correctly),
  `range`/`get`, gossip serialize/merge (freshest `receivedAt` wins a per-revision tie).
- **`push-state.ts`** — full `PushState` struct + `PushStateGossipV1` codec; `parentCheckpoint` /
  `perSubscriberQueue` reserved for the sibling tickets; `mergeGossip` converges replay + dedupe + scalars.
- **`verify.ts`** — `createNotificationVerifier` adapter over the cohort-topic `MembershipVerifier`
  (derives `coord_0(_, H(tailId‖"reactivity"))`, verifies threshold sig over the commit `digest`).
- **`forwarder.ts`** — `createReactivityForwarder`: verify → dedupe → append → forward decision;
  unverifiable notifications dropped *before* touching dedupe/buffer.
- **`subscriber.ts`** — `createReactivitySubscriber`: verify (one fetch-and-retry via the verifier),
  contiguity, gap → `requestBackfill(from,to)` seam, `(collectionId,revision)` dedupe, surface; fresh
  subscribe adopts the first verified notification as baseline.
- **`subscription.ts`** — `ActiveSubscription` struct + `subscribeAppPayloadBytes` builder.

### db-p2p `packages/db-p2p/src/reactivity/` (substrate wiring)
- **`subscription-manager.ts`** — `ReactivitySubscriptionManager`: register at **T3** with the
  tail-anchored topic + subscribe payload, renew/withdraw via `CohortTopicService`, `onNotification`
  delegates to the db-core delivery path. TTL precedence explicit > profile > Core default.
- **`origination-manager.ts`** — `ReactivityOriginationManager`: installs `onLocalCommit`, builds the
  notification, supplies `encodeSigner = s ⇒ bytesToB64url(peerIdToBytes(s))` (inverse of the
  subscriber verifier's `b64urlToBytes` default — closes the signer-encoding loop end to end), emits via
  an injected transport.

## Validation performed
- `yarn build` + `yarn test` green for **db-core** (662 passing) and **db-p2p** (603 passing, 9 pending).
- New reactivity unit tests: 72 (db-core) + 9 (db-p2p). Covering every Done-when scenario:
  - a notification verifies and delivers contiguously (`subscriber.spec.ts`);
  - a duplicate `(revision, sigDigest)` is dropped (`forwarder.spec.ts`, `dedupe-replay.spec.ts`);
  - a revision gap triggers a backfill request via the seam (`subscriber.spec.ts`);
  - any cohort member (not just primary) serves a replay from the buffer after gossip (`forwarder.spec.ts`,
    `push-state.spec.ts`);
  - a stale `MembershipCertV1` triggers exactly one fetch-and-retry then verifies — exercised against the
    **real** `createMembershipVerifier` with a pass-crypto stub + stale/fresh source (`subscriber.spec.ts`).

## Use cases / what to probe in review
- **Origination fidelity**: `buildNotificationV1` must never mutate `thresholdSig`/`signers` content.
  Confirm the delta-budget edges (exactly-at-budget included, over-budget omitted, budget 0 omitted).
- **Dedupe semantics under partition merge**: a same-revision retransmit with a *distinct* sig is admitted;
  an exact repeat is dropped; the window evicts keys older than `dedupe_window` (re-admittable — the
  subscriber-side `(collectionId,revision)` dedupe is the backstop). Check the eviction bound math
  (`[highest - windowSize + 1, highest]`).
- **Replay ring**: revision-keyed (not slot-keyed) — verify out-of-order appends and the lowest-revision
  overflow eviction; verify `merge` convergence is idempotent + commutative within the window.
- **Subscriber contiguity**: fresh-subscribe baseline adoption vs. `lastKnownRev > 0` gap detection; the
  gapped notification is *not* surfaced until the gap closes via backfill re-feed; foreign-collection drop.
- **Encoding loop**: origination `encodeSigner` (peer-id string → base64url member bytes) must be the exact
  inverse the subscriber verifier consumes; `managers.spec.ts` pins this, but confirm against a real
  `MembershipCertV1.members` form (`bytesToB64url(peerIdToBytes(peerIdString))`).

## Known gaps (honest handoff — reviewer should weigh these)
1. **`digest` ↔ signed-commit-hash alignment.** Origination sets `NotificationV1.digest = b64url(actionId)`.
   The commit cert's threshold sig is over the *commit hash*; for a subscriber's **cryptographic**
   threshold-verify over `digest` to succeed against real Ed25519, `digest` must equal those signed bytes.
   `CommitCert` does not currently expose the signed payload, so the verify tests use a fake verifier / a
   pass-crypto stub. **This is the most important integration seam** — recommend a fix/plan ticket to either
   add the signed-payload bytes to `CommitCert` or document `actionId == commit hash` invariantly. Flagged in
   `docs/reactivity.md` §Notification origination and `notification.ts`.
2. **No live notification transport.** The forwarder/subscriber *logic* is complete, but no libp2p
   application protocol is registered to deliver `NotificationV1` frames to a subscriber's primary or to
   child cohorts — `ReactivityOriginationManager.emit` and the forwarder's "forward" decision are seams. A
   reactivity protocol handler (mirroring the cohort-topic protocols) is unbuilt. Likely belongs with the
   e2e ticket (`13-reactivity-e2e-mock-tier`) or a dedicated transport ticket.
3. **`PushState` gossip not plumbed onto the cohort gossip bus.** `serializeGossip`/`mergeGossip` are
   complete + tested, but nothing yet drives them over the host's `CohortGossipBus` cadence — so the
   "any member serves a replay" property is proven in-process, not over the wire.
4. **Origination `resolveContext` / tail tracking unwired.** The manager takes a `resolveContext(event)`
   seam for `(tailId, deltaMaxBytes)`; no production source tracks the collection's current tail id /
   per-collection delta config yet (rotation ticket territory).
5. **Subscriber does not buffer future notifications** across a gap — it relies on the backfill re-feeding
   the range in order. Correct per the doc (hint-only), but worth confirming the sibling backfill ticket
   feeds entries back through `onNotification` ascending.

## Done when (review)
- Findings triaged: minor → fixed inline; major (esp. gap #1, #2) → new fix/plan ticket(s).
- `complete/` output written with a `## Review findings` section.
