description: The cohort-topic "promote" network handler now rate-limits per sender and bounds how often it does expensive membership lookups, so a peer flooding it with junk messages can no longer force the node into a storm of wasted signature checks and network calls.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts (Layer 2: RefetchBound + per-coord rate-limited refetch in verifyMessage)
  - packages/db-p2p/src/cohort-topic/host.ts (Layer 1: PromoteGate, handleInboundNotice, createPromoteGate, PROMOTE_REFETCH_MIN_INTERVAL_MS; verifyAndApplyNotice now passes the bound; promote handler threads `from`; createCohortTopicHost wiring)
  - packages/db-core/test/cohort-topic/membership.spec.ts (Layer 2 unit tests)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (Layer 1 anti-abuse gate tests + refactored helpers)
difficulty: medium
----

# Review: gate the inbound promote handler (verify/refetch amplification)

## What was built

Two defensive layers were added so a peer streaming junk over the `promote` protocol can no longer
amplify into per-message signature verification + per-message membership network dials.

### Layer 1 — pre-verify gating in the promote handler (`db-p2p/host.ts`)

The promote handler body was extracted into an exported, node-free-testable
**`handleInboundNotice(frame, from, registry, verifier, gate, now, maxBytes?)`** returning a new
`InboundNoticeResult` (`NoticeOutcome | "undecodable" | "rate-limited" | "stale"`). It runs cheapest-first:

```
decode → per-(peer,topic) rate limit → findServing → effectiveAt high-water → verify+apply (bounded refetch)
```

- **Rate limit** — a node-level `RegisterRateLimiter` (reused from db-core, `register_rate_per_peer` =
  4/min/peer/topic, exponential back-off), keyed on `(peerIdToBytes(from), topicId)`. Over-rate frames
  drop **before** `findServing`/verify. New `PromoteGate` type + `createPromoteGate(rateLimiterConfig?)`
  factory; the gate is one node-level instance (the register-path limiter is per-coord inside each engine,
  so the node-level handler needs its own). Wired in `createCohortTopicHost` from `options.antiDos?.rateLimiter`.
- **`effectiveAt` high-water** — per-`(topicId, tier)` map of the last *applied* notice's `effectiveAt`.
  A notice at or below the water drops before `verifyMessage`. The water is advanced **only** on an
  `"applied"` outcome, so a forged notice (which never verifies) — even one carrying `effectiveAt = ∞` —
  cannot poison it.
- The `from` peer (already passed by `makeFrameHandler`) is now threaded into the handler.
- **Epoch check deliberately omitted** (the ticket flagged it as optional/brittle). The receiver-side
  `cohortEpoch` rotates on every membership change, so a legitimately in-flight notice can briefly carry
  the prior epoch right after a rotation; gating on it would be false-positive-prone. Documented in the
  `handleInboundNotice` JSDoc. The rate limiter + high-water are the load-bearing replay/abuse defenses.

### Layer 2 — bounded refetch in the verifier (`db-core/verifier.ts`)

`MembershipVerifier.verifyMessage` gained an optional trailing `opts?: RefetchBound`
(`{ minRefetchIntervalMs?, now? }`, new exported type). When **both** fields are supplied, the stale-cert
`source.fetch()` retry is **rate-limited per coord** — at most one refetch per coord per interval, tracked
in a new `lastFetchAt` map. Omitting `opts` (every pre-existing caller) keeps the unbounded
exactly-one-refetch behavior. `verifyAndApplyNotice` passes `{ minRefetchIntervalMs:
PROMOTE_REFETCH_MIN_INTERVAL_MS (60_000), now }` for both the promotion and demotion paths.

## IMPORTANT — deviation from the ticket's primary recommendation (please scrutinize)

The ticket recommended **full refetch suppression** (`{ allowRefetch: false }`) as the primary, and the
**per-coord rate-limited refetch** only as a fallback "if the demotion-to-parent / sibling-without-cached-cert
path turns out to need eventual refetch (verify against `live-tier.spec.ts`)".

I implemented full suppression first; **`live-tier.spec.ts` test 4 failed** ("a non-originating cohort node
verify-applied the promotion notice" → got `false`). That sibling has not cached its own coord-0 cert in
that test (only the primary called `onStabilized`), so suppression made its legitimate promotion read
`"untrusted"`. This is exactly the documented fallback trigger, so I shipped the **rate-limited-refetch
alternative**. With it, a cold-cache receiver pays one bounded fetch (then caches), and live-tier passes.

Consequence for the acceptance bar: the flood no longer drives **zero** fetches but a **bounded** rate
(≤ 1 per coord per 60 s interval), which is the ticket's stated acceptable alternative
("`<= bound` with the rate-limited-refetch alternative"). **Reviewer: confirm the bounded-but-nonzero
fetch rate is acceptable vs. the zero-fetch ideal**, and that 60 s is a sane interval (it mirrors the
anti-DoS rate window; the cert refresh cadence is 5 min).

## How to validate

- `yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-p2p build` — both clean.
- `yarn workspace @optimystic/db-core test` — **883 passing**.
- `yarn workspace @optimystic/db-p2p test` — **855 passing, 29 pending** (the 29 pending are the
  `*.integration.spec.ts` real-libp2p tests, skipped without `OPTIMYSTIC_INTEGRATION=1`).

### Key test cases (the floor — extend these)

db-p2p `promote-notice.spec.ts` → new describe `inbound promote-handler anti-abuse gate`:
- **Refetch bound**: 50 forged single-signer notices (distinct peers, generous rate ceiling) → asserts
  `fetches() <= 1` (pre-fix this was 50). Uses a counting `IMembershipSource`.
- **Rate-limit drop**: one peer, `ratePerWindow = 4`, 10 notices at a fixed `now` → exactly 4 reach the
  verifier (`untrusted`), 6 `rate-limited`; a counting verifier wrapper asserts `verifyMessage` ran 4×.
- **Stale/replay drop**: a real applied promotion at `effectiveAt = 5_000` sets the water; a replay at
  5_000 and an older one at 4_000 both return `"stale"` and never reach the verifier.
- **Fresh-after-water**: a later legit notice (`9_000 > 5_000`) still applies and advances the water (a
  replay at 9_000 then reads `"stale"`).
- `"undecodable"` and `"dropped"` (no serving engine) cases never reach the verifier.

db-core `membership.spec.ts`:
- A refetch bound rate-limits refetch to one per coord per interval (then allows one more past the window).
- A refetch bound still refetches once on a cold cache (eventual refetch preserved).

The pre-existing `verifyAndApplyNotice` / fan-out tests in `promote-notice.spec.ts` pass unchanged
(`verifierOver` was refactored into `encodedCertOver` + `verifierFromSource` with no behavior change).

## Known gaps / caveats (treat as a starting point, not a finish line)

1. **Unbounded gate maps.** Both `PromoteGate.highWater` and the rate limiter's internal map retain one
   small entry per `(topic, tier)` / `(peer, topic)` ever seen — no eviction of long-idle keys. Same
   characteristic the register-path limiter documents as "the host service's lifecycle concern". For a
   long-lived node serving many topics this grows slowly. Consider a backlog ticket for LRU/TTL eviction
   if it matters; not addressed here.
2. **Per-coord (not per-peer) refetch bound.** A single flood can consume the one allowed refetch in the
   interval, briefly delaying a *legit* stale-cache refetch for a different notice on the same coord
   (bounded by the 60 s interval). Inherent to the rate-limited-refetch approach; promote is gossip-style
   fan-out from multiple cohort members + periodic membership refresh, so a delayed notice re-arrives.
3. **High-water grain.** The key is `(topicId, tier)` where `tier = promotion.fromTier | demotion.tier`,
   i.e. the same grain `registry.findServing` resolves the serving engine at — so promotions *out of* and
   demotions *arriving at* the same served `(topic, tier)` share one monotonic `effectiveAt` water. This
   is intended (time-ordered events), but worth a sanity check against the real promotion/demotion tier
   semantics.
4. **Real-libp2p integration spec not executed** (heavy, gated behind `OPTIMYSTIC_INTEGRATION=1`). It was
   inspected: all its `verifyMessage` calls are the 5-arg form (no `opts`) → unbounded refetch, identical
   to before; the signature change is backward-compatible. The mock-mesh equivalent (`live-tier.spec.ts`
   test 4, the sibling verify-apply path) does run and passes. A reviewer with the integration env should
   still run it to be sure the real `/membership` fetch path behaves under the bound.
5. **`now` is `Date.now()` in production** (monotonic enough for a 60 s window); tests inject fixed `now`.

## Acceptance criteria — status

- [x] Forged-frame flooder is rate-limited per `(peer, topic)` **and** capped to a bounded membership-fetch
      rate per coord (db-p2p flood + rate-limit tests).
- [x] Stale/replayed notice (`effectiveAt <= last applied for (topic, tier)`) dropped **before** `verifyMessage`.
- [x] Legitimate notices still verify and apply; `promote-notice.spec.ts` green; fresh-after-water case added.
- [x] `verifyMessage` signature change is backward-compatible (optional trailing arg; existing callers
      untouched; db-core + db-p2p suites green; `live-tier.spec.ts` passes).
