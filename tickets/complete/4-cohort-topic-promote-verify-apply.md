description: COMPLETE — cohort-topic promote verify-and-apply (gap 4). db-core remote-apply path on PromotionLifecycle, host inbound decode→verify→apply over the `promote` protocol, and host outbound capture+broadcast of locally-signed notices. Reviewed: build + tests green, two future-scoped findings filed to backlog, two minor observations recorded.
files:
  - packages/db-core/src/cohort-topic/promotion.ts (applyPromotionNotice / applyDemotionNotice + lastEffectiveAt high-water guard)
  - packages/db-core/src/cohort-topic/member-engine.ts (firePromotion: capture notice → onNotice; error/log handling)
  - packages/db-p2p/src/cohort-topic/host.ts (CoordEngine apply/observe hooks, registry.findServing, decodeInboundNotice / verifyAndApplyNotice / noticeBroadcastCoords, promote handler, broadcastNotice + onCertPublished wiring)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (broadcastOver — generic per-protocol fan-out)
  - packages/db-core/test/cohort-topic/promotion.spec.ts (remote-apply ordering/idempotency)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (verify+apply integration, broadcast fan-out)
  - docs/cohort-topic.md (§Promotion implementation note — broadcast + remote apply)
----

# Complete: cohort-topic promote verify-and-apply (gap 4)

Closes the loop on the `promote` protocol: a member that originates a threshold-signed
`PromotionNoticeV1`/`DemotionNoticeV1` **broadcasts** it over the `promote` protocol, and a member that
receives one **verifies** it against the cohort `MembershipCertV1` and **applies** it to its local
`PromotionLifecycle` without re-signing. Replaces the prior no-op handler (`async () => undefined`) and
the dropped locally-signed notice (`void promotion.onParticipantCountChange(...)`).

See the implement-stage handoff (commit `66758a0`) for the full design narrative. This file records the
review.

## Review findings

### Scope of review
Read the implement diff (`66758a0`) with fresh eyes across db-core (`promotion.ts`, `member-engine.ts`)
and db-p2p (`host.ts`, `cohort-gossip-transport.ts`), the two new/changed spec files, and the docs
change, plus the supporting `verifier.ts`, `validate.ts` (notice validators), `payloads.ts`, and
`makeFrameHandler`. Scrutinized from correctness, SPP/DRY/modularity, type safety, error handling,
resource cleanup, idempotency/ordering, and adversarial-input angles.

### Build + tests — PASS
- `cd packages/db-core && yarn build` — clean. `cd packages/db-p2p && yarn build` — clean.
- `yarn test:db-core` — **538 passing**.
- `yarn test:db-p2p` — **545 passing, 9 pending** (the 9 pending are pre-existing, unrelated to this
  change). No new failures; no `.pre-existing-error.md` needed.

### What was checked and confirmed correct
- **Decode discrimination is sound.** `decodeInboundNotice` tries `validatePromotionNoticeV1` then
  `validateDemotionNoticeV1`. The two shapes are disjoint by *required* fields — a promotion requires
  `fromTier`/`toTier`, a demotion requires `tier`/`parentCohortCoord` — so a demotion frame throws out
  of the promotion validator (missing `fromTier`) and falls through correctly. Verified against the
  validators in `wire/validate.ts`.
- **"Never throw on the stream" holds.** `decodeInboundNotice` calls `decodeCohortMessage` *outside* a
  try/catch, but every handler is wrapped by `makeFrameHandler`, which catches and aborts the stream on
  any error — so a malformed/oversize frame aborts cleanly rather than crashing. Consistent with the
  other four handlers.
- **Idempotency + ordering.** The `lastEffectiveAt` high-water mark survives demotion and is stamped by
  both local `promote()`/`demote()` and the remote-apply path; `isNewerTransition` uses strict `>`, so
  a member's own echoed broadcast and stale replays are no-ops, and a stale promotion cannot un-demote.
  Covered by `promotion.spec.ts` (flip/clear, stale-ignored, duplicate-absorbed, self-echo).
- **Unhandled-rejection fix is real and correct.** `firePromotion` awaits the threshold-sign trigger
  and `catch`es the quorum-unreachable rejection that the bare `void promotion.onParticipantCountChange`
  would have leaked once signing became real. Both new deps (`onNotice`, `log`) are optional, so
  key-less/mock compositions still compile and pass (confirmed: db-core 538 green).
- **`onCertPublished` TDZ forward reference is safe.** The closure captures `verifier` (declared later)
  but engines — and therefore any cert publish — are created lazily via `registry.forCoord`, never
  synchronously before `verifier` is initialized. Confirmed by reading `createCoordRegistry`.
- **`broadcastOver` DRY refactor** is a clean generalization of the transport's `broadcast`; self-
  exclusion and best-effort per-peer swallow are preserved. `noticeBroadcastCoords` discriminates via
  `"parentCohortCoord" in notice` (robust structural check) and is unit-tested for both fan-outs.
- **Verification binds to the cohort cert** via `verifier.verifyMessage(signers, target.servedCoord,
  tier, payload, sig)` with the canonical `sig/payloads` image — never re-canonicalized. Forged
  single-signer, short-quorum, and non-member-signer notices all return `"untrusted"` with state
  unchanged (tested with real crypto in `promote-notice.spec.ts`).

### Findings filed to backlog (major, future-scoped) — NOT fixed in this pass
1. **`backlog/cohort-topic-promote-notice-coord-disambiguation.md`** — a notice carries `(topic, tier)`
   but not the served coord it was decided for, so the inbound handler resolves the target via
   `findServing(topic, tier)` (first match). When a node serves the same `(topic, tier)` under multiple
   cohorts/coords (multi-cohort topology at `d ≥ 1`), a notice can be verified against / applied to the
   wrong engine and silently dropped as untrusted. Latent in the current single-cohort milestone (every
   test drives one cohort, where `findServing` is exact); a gate for multi-cohort promotion. Filed with
   wire-field vs verify-all-candidates options and acceptance.
2. **`backlog/cohort-topic-promote-handler-verify-amplification.md`** — the live `promote` handler runs
   `verifyAndApplyNotice` on every frame any peer sends, with no per-peer rate limit / replay / freshness
   gate (unlike the register path). Each untrusted notice still drives `verifyMessage`'s single stale-cert
   refetch (a cohort dial), so forged frames amplify into network fetches. Newly reachable because the
   handler went from no-op to live in gap 4. Filed with reuse-register-guards / bounded-refetch options.
   Adjacent to `cohort-topic-host-antidos-coldstart` (gap 6), which gates the register path only.

### Minor observations (recorded, no action this pass)
- **Concurrent `firePromotion` double-sign window.** `accept()` fires the promotion trigger
  fire-and-forget. `onParticipantCountChange` only short-circuits on `state.promoted`, which is set
  *after* the async `thresholdSign` resolves — so two arrivals landing inside one signing round can both
  pass the trigger and both broadcast a notice (different `effectiveAt`, so both apply; the second
  advances the high-water — convergent, not incorrect). Cost is a doubled quorum-sign round in the race
  window, bounded (subsequent arrivals short-circuit once promoted). Pre-existing in shape (the trigger
  was always fire-and-forget); the gossip-cadence/periodic-driver ticket (`5-cohort-topic-gossip-cadence`)
  that owns the broader trigger wiring is the natural place to add an in-flight guard if desired.
- **`effectiveAt` is wall-clock.** The high-water ordering compares `effectiveAt` timestamps stamped by
  whichever member originated each notice; cross-member clock skew could, in principle, mis-order a
  promotion vs a later demotion. Bounded well below risk in practice — `T_promote_sticky` (60s) and
  `T_demote` (5min) keep transitions minutes apart, far exceeding realistic peer skew. No change made.

### Honest-limitations carried forward (from the implement handoff, re-confirmed during review)
These remain true and in-scope-elsewhere: (1) the periodic `maybeDemote → broadcast` trigger is not
wired (owned by `5-cohort-topic-gossip-cadence`), so demotion notices are exercised only by unit tests;
(2) parent-side demotion is a no-op while `childCohortCount` is hardcoded `() => 0` (single-cohort
milestone); (3) no two-node real-libp2p-stream host integration test (logic is tested through the
exported seams with real crypto); (4) `onCertPublished` caching depends on the not-yet-wired
stabilization/periodic driver to fire; (5) early notices that race gossip records are dropped and
converge on a later round; (6) epoch tolerance is emergent from the verifier's single refetch, not
explicit window logic. None block this milestone; findings 1–2 above are the new review-surfaced gaps.

## End
