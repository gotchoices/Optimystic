description: The cohort-topic "promote" network handler now rate-limits per sender and bounds how often it does expensive membership lookups, so a peer flooding it with junk messages can no longer force the node into a storm of wasted signature checks and network calls.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts (Layer 2: RefetchBound + per-coord rate-limited refetch in verifyMessage)
  - packages/db-p2p/src/cohort-topic/host.ts (Layer 1: PromoteGate, handleInboundNotice, createPromoteGate, PROMOTE_REFETCH_MIN_INTERVAL_MS)
  - packages/db-core/test/cohort-topic/membership.spec.ts (Layer 2 unit tests)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (Layer 1 anti-abuse gate tests)
  - docs/cohort-topic.md (§Promotion and demotion lifecycle + §Anti-DoS updated for the new gate)
difficulty: medium
----

# Gate the inbound promote handler (verify/refetch amplification) — COMPLETE

Two defensive layers make a peer streaming junk over the `promote` protocol unable to amplify into
per-message signature verification + per-message membership dials:

- **Layer 1 (`db-p2p/host.ts`)** — `handleInboundNotice` runs cheapest-first:
  `decode → per-(peer,topic) rate limit → findServing → effectiveAt high-water → verify+apply`. A
  node-level `RegisterRateLimiter` (4/min/peer/topic, exp. back-off) and a per-`(topic, tier)`
  `effectiveAt` high-water (advanced only on `"applied"`) shed abuse before any crypto/network work.
- **Layer 2 (`db-core/verifier.ts`)** — `verifyMessage` gained an optional `RefetchBound`; when supplied
  (only by `verifyAndApplyNotice`, at 60 s) the stale-cert `source.fetch()` retry is rate-limited to one
  per coord per interval. Eventual refetch preserved. All pre-existing callers (5-arg) are unchanged.

The implementer's documented deviation (rate-limited refetch instead of full suppression) was reviewed
and **accepted**: full suppression broke a legitimate cold-cache sibling-adopt path (`live-tier.spec.ts`
test 4), which the ticket itself named as the fallback trigger. Bounded-but-nonzero fetch is the ticket's
stated acceptable alternative, and 60 s is sane (mirrors the anti-DoS rate window; cert refresh is 5 min).

## Review findings

Reviewed the implement diff (`67cc7e8`) with fresh eyes before reading the handoff, scrutinized for
correctness/SPP/DRY/modularity/scalability/perf/cleanup/error-handling/type-safety, re-derived the
defensive invariants, ran builds + both test suites, and audited the touched + should-have-touched files.

**Checked and found sound (no change needed):**

- **High-water cannot drop a legit notice the engine would apply.** The gate's per-`(topic, tier)` water
  is *strictly weaker* than the engine's per-topic `effectiveAt` high-water (the gate's water for a tier
  ≤ the engine's water across all tiers), so the gate only early-drops a subset of what the engine would
  already no-op. This resolves the handoff's caveat #3 (promotion `fromTier` / demotion `tier` sharing a
  water key): time-ordered events on one engine, and the engine remains the source of truth for apply.
- **High-water poison resistance.** Advanced only on `"applied"`; a forged notice never verifies, so
  even `effectiveAt = ∞` cannot raise the water. Confirmed in code and by the replay/fresh-after-water
  tests. `verifyAndApplyNotice` returns `"applied"` only after a `"verified"` result, never on a
  no-op-at-engine path that would diverge the two waters in a harmful direction (gate ≤ engine holds).
- **Rate-limit ordering.** `rate-limit → findServing` is correct cheapest-first: `findServing` is an
  O(engines) linear scan (`host.ts:892`), so rate-limiting first genuinely shields it. Reordering would
  trade memory for per-frame CPU — not a win. Left as-is.
- **Refetch bound.** `refetchAllowed` records the attempt time only when it returns `true` (the dial is
  about to happen); a successful refetch caches the cert so subsequent verifies hit cache with no dial.
  Both-fields-required gate keeps every existing caller unbounded. Backward-compatible signature.
- **Backward compatibility.** All other `verifyMessage` callers (participant service, integration spec)
  pass the 5-arg form → unbounded exactly-one-refetch, identical to pre-change behavior.
- **Tests.** The implementer's floor (flood→bounded refetch, rate-limit drop, stale/replay drop,
  fresh-after-water, undecodable, no-serving-engine; db-core bounded-refetch rate-limit + cold-cache) is
  solid and covers happy path, edge, error, and replay-interaction paths. No gap warranting new tests.

**Found and fixed inline (minor):**

- **Docs were out of date.** `docs/cohort-topic.md` §Promotion-and-demotion-lifecycle described the
  inbound `promote` handler as a bare decode→resolve→verify→apply with no mention of the new gate, and
  §Anti-DoS described only the four register-path defenses. Updated both: the handler description now
  documents the cheapest-first gate (rate limit / high-water / bounded refetch) and the dropped-outcome
  set, and §Anti-DoS gained a "Promote-handler gate" note tying the reused primitives to this protocol
  and flagging the deferred map-eviction concern.

**Found and filed as new ticket (major / future concern):**

- **Unbounded gate maps → slow leak + low-rate memory amplification.** `PromoteGate.highWater` and the
  node-level rate limiter's `states` map retain one entry per `(topic, tier)` / `(peer, topic)` ever
  seen, with no eviction. Sharper than the register path because the rate-limit check precedes
  `findServing`, so forged notices for *unserved* topics (attacker-chosen, free-to-vary `topicId`) still
  allocate entries with no `TopicBudget` in front. Slow leak, not a crash; explicitly deferred at
  implement time. Filed `tickets/backlog/cohort-topic-promote-gate-map-eviction.md` (LRU/TTL eviction,
  with the safety invariant that the engine high-water remains the apply source of truth).

**Empty categories (explicitly):**

- *No correctness/security bugs found* — the two-layer design is sound; the deviation is justified and
  the poison-resistance + gate≤engine invariants hold under scrutiny.
- *No type-safety, resource-cleanup, or error-handling defects* — handler logs and never throws on the
  stream (one-way contract preserved); `b64urlToBytes`/decode failures are caught and mapped to
  `"untrusted"`/`"undecodable"`.
- *No new ticket for the per-coord (not per-peer) refetch bound (handoff caveat #2)* — inherent to the
  rate-limited-refetch approach and self-healing via gossip re-arrival within the 60 s window; acceptable.

## Validation

- `yarn workspace @optimystic/db-core build` / `@optimystic/db-p2p build` — both clean (tsc silent).
- `yarn workspace @optimystic/db-core test` — **883 passing**.
- `yarn workspace @optimystic/db-p2p test` — **855 passing, 29 pending** (the 29 pending are the
  `*.integration.spec.ts` real-libp2p tests, gated behind `OPTIMYSTIC_INTEGRATION=1`).
- Lint: not configured for these packages (root `lint` script is a no-op echo).

## Deferred / out-of-band

- Real-libp2p integration spec (`OPTIMYSTIC_INTEGRATION=1`) not executed here (heavy; gated). Its
  `verifyMessage` calls are all 5-arg (unbounded refetch, unchanged); the mock-mesh equivalent
  (`live-tier.spec.ts` test 4) runs and passes. A reviewer with the integration env should run it.
- Gate-map eviction: `cohort-topic-promote-gate-map-eviction` (backlog).
