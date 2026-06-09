description: Review the cohort-topic promote verify-and-apply implementation (gap 4) — db-core remote-apply path on PromotionLifecycle, host inbound decode→verify→apply over the `promote` protocol, and host outbound capture+broadcast of locally-signed notices.
prereq: cohort-topic-threshold-assembly
files:
  - packages/db-core/src/cohort-topic/promotion.ts (applyPromotionNotice / applyDemotionNotice + lastEffectiveAt high-water guard)
  - packages/db-core/src/cohort-topic/member-engine.ts (firePromotion: capture notice → onNotice; error/log handling)
  - packages/db-p2p/src/cohort-topic/host.ts (CoordEngine apply/observe hooks, registry.findServing, decodeInboundNotice / verifyAndApplyNotice / noticeBroadcastCoords, promote handler, broadcastNotice + onCertPublished wiring)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (broadcastOver — generic per-protocol fan-out)
  - packages/db-core/test/cohort-topic/promotion.spec.ts (remote-apply ordering/idempotency)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (verify+apply integration, broadcast fan-out)
  - docs/cohort-topic.md (§Promotion implementation note — broadcast + remote apply)
----

# Review: cohort-topic promote verify-and-apply (gap 4)

The `promote` protocol handler was a no-op (`async () => undefined`) and a locally-signed
`PromotionNoticeV1` was dropped on the floor (`void this.deps.promotion.onParticipantCountChange`).
With the real `k − x` threshold signature in place (prereq), this ticket closes the loop: a member
that originates a notice **broadcasts** it, and a member that receives one **verifies and applies** it.

## What changed

### db-core — remote apply path (`promotion.ts`)
- New `PromotionLifecycle.applyPromotionNotice(n, now)` / `applyDemotionNotice(n, now)`: adopt a notice
  this member did **not** originate, setting the same `PromotionState` the local `promote()`/`demote()`
  set, **without re-signing**. **Precondition (documented): the caller has already verified the
  threshold signature** — db-core is crypto-free and does not re-verify.
- Idempotency + ordering via a new monotonic `PromotionState.lastEffectiveAt` high-water mark that
  **survives demotion** (a demotion clears `promoted`/`promotedAt` but keeps `lastEffectiveAt`). Apply is
  a no-op unless `n.effectiveAt` is strictly newer. Local `promote()`/`demote()` also stamp it, so a
  member's own echoed broadcast applies as a no-op.
- `isPromoted` now reflects remotely-applied state → a member that learns of a promotion answers
  `Promoted(d+1)` to later registrations even though it didn't originate it.

### db-core — outbound capture (`member-engine.ts`)
- `accept()`'s `void promotion.onParticipantCountChange(...)` is replaced by `void firePromotion(...)`,
  which awaits the trigger, hands any signed notice to a new optional `onNotice(notice)` dep, and
  **catches** the threshold-sign rejection (quorum unreachable) — fixing a latent **unhandled-rejection**
  that became live once signing became real (the bare `void` leaked it). Optional `log` dep records it.
- Both new deps are optional → existing key-less/mock compositions (service.spec) still compile + pass.

### db-p2p — host inbound + outbound (`host.ts`, `cohort-gossip-transport.ts`)
- `CoordEngine` gains `servesTopic`, `isPromoted`, `applyPromotionNotice`, `applyDemotionNotice`;
  `CoordRegistry` gains `findServing(topicId, treeTier)` (scan; a served coord embeds `(tier, topic)` so
  at most one engine matches).
- Exported, unit-testable seams: `decodeInboundNotice` (try promotion then demotion — disjoint shapes),
  `verifyAndApplyNotice` (`"applied" | "untrusted" | "dropped"`), `noticeBroadcastCoords` (pure fan-out
  targets). `NoticeApplyTarget` is the minimal slice `verifyAndApplyNotice` needs.
- `promote` handler: decode → `registry.findServing` → `verifyAndApplyNotice(verifier)` → drop/log on
  non-applied; reply `undefined` (one-way, gossip-style).
- Outbound: engine `onNotice` → `broadcastNotice(notice, servedCoord)` → `gossipTransport.broadcastOver`
  the `promote` protocol to the served cohort, **plus the parent coord for a demotion**. `broadcastOver`
  is a generic refactor of the transport's existing `broadcast` (DRY).
- `onCertPublished` caches each freshly-published cohort cert into the node's verifier so inbound notices
  signed by **its own** cohort verify without a network refetch.

## How to validate / use

**Run:** `yarn test:db-core` (538 pass), `yarn test:db-p2p` (545 pass, 9 pre-existing pending), and the
type-check `cd packages/db-core && yarn build` + `cd packages/db-p2p && yarn build` — all green at handoff.

**Use cases exercised by tests:**
- *Verified promotion flips a remote member* — `promote-notice.spec.ts`: real cohort cert (publisher) +
  real threshold-signed notice (assembler) + real `MembershipVerifier` → `verifyAndApplyNotice` returns
  `"applied"`, remote lifecycle `isPromoted` flips true. Demotion variant clears a promoted member.
- *Forged / short-quorum rejected* — a single-signer notice at `minSigs=3` → `"untrusted"`, state
  unchanged (the exact interim-style sig that must now fail).
- *Non-member signers rejected* — a perfect quorum signature by a **different** cohort (signers ⊄ the
  cert) → `"untrusted"`.
- *No-engine drop never throws* — a demotion with no local serving engine (`undefined` target) →
  `"dropped"` (covers a demotion arriving at a parent that doesn't track the child).
- *Decode discrimination* — a non-notice frame → `undefined`.
- *Broadcast fan-out* — promotion → `[servedCoord]`; demotion → `[servedCoord, parentCohortCoord]`.
- *Remote-apply ordering/idempotency* (`promotion.spec.ts`): flip/clear; stale (≤ high-water) replay
  ignored; a replayed old promotion cannot un-demote; duplicate absorbed but a strictly-newer transition
  applies; a self-originated promotion absorbs its own echoed broadcast.

**Suggested reviewer probes (beyond the floor above):**
- Concurrency: `findServing` scans `engines.values()` (sync) — fine, but confirm no race vs lazy engine
  creation matters for inbound notices (it can only find already-instantiated engines, by design).
- `verifyAndApplyNotice` decodes `notice.signers` via `b64urlToBytes` inside a try/catch → `"untrusted"`
  on a malformed signer (validators check signers as a string array, not per-element base64url). Confirm
  this is the desired "treat as untrusted" rather than "drop".
- The `onCertPublished` closure references `verifier` declared a few lines later (deferred, TDZ-safe —
  only invoked on a later publish). Confirm you're comfortable with the forward reference vs reordering.

## Known gaps / honest limitations (treat tests as a floor)

1. **Periodic `maybeDemote` → broadcast is not driven.** Only the **promotion** path is actually
   triggered on the wire (engine `accept` → `onNotice`). `maybeDemote` has no caller in this milestone
   (the gossip-cadence/periodic-driver ticket owns it), so **demotion notices are never *produced* on the
   wire yet** — the demotion inbound-apply + the `[servedCoord, parent]` fan-out are exercised only by
   unit tests. This matches the ticket scope ("the periodic maybeDemote" / "exercised only in a unit
   test"), but a reviewer should know the demotion broadcast trigger is still dark.
2. **Parent-side demotion is effectively a no-op.** `childCohortCount` is still hardcoded `() => 0`
   (single-cohort milestone). A demotion delivered to the parent coord finds no engine for the child
   coord_d (`findServing` → undefined) and is dropped; there's no child-cohort tracking state to update.
   Only the within-cohort adoption (siblings clear `promoted`) is meaningful. Child-cohort tracking is a
   follow-on. The path is proven not to throw, nothing more.
3. **No real-stream host integration test.** The verify/apply/broadcast logic is tested through the
   exported seams with real crypto, a real verifier, and real lifecycles — but the host's libp2p wiring
   (handler dispatch on a live `promote` stream, `sendOneWay` fan-out) is not driven end-to-end with two
   fake nodes. The five-protocol handshake test still confirms the handler is registered. A two-node
   stream test would raise confidence in the wiring itself.
4. **`onCertPublished` cache depends on the (not-yet-wired) stabilization/periodic driver** to call
   `onStabilized`/`pumpMembership`. Until that lands, inbound verification of self-cohort notices falls
   back to the membership *source* (a network dial to a sibling) rather than a local cache hit —
   functionally correct, not yet optimized.
5. **`findServing` requires the engine to already serve the topic** (`directParticipants > 0` or
   cold-start). A notice that races ahead of the gossip records on a sibling is dropped and converges on
   a later round (bounded by the documented gossip-lag overshoot). No buffering of early notices.
6. **Epoch tolerance is emergent, not explicit.** `verifyMessage` doesn't compare `cohortEpoch` against
   the cert; a rotated epoch changes `cert.members`, so old-epoch signers naturally fail `signers ⊆
   cert.members`. The "one-rotation tolerance" is whatever the verifier's single refetch yields — no
   explicit epoch-window logic was added.
