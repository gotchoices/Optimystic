description: The cohort-topic "promote" network handler does expensive signature checks and a network lookup for every message any peer sends it, with no rate limiting, so a peer can flood it with junk messages and force the node into a storm of wasted work and network calls. Add the same anti-abuse guards the sibling "register" handler already has.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (promote handler L1429; verifyAndApplyNotice L1298; registerProtocolHandlers L1391; makeFrameHandler L1466 — passes `from`; createCohortTopicHost wiring L433+)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (verifyMessage L64 — always source.fetch() on a verify miss)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (createRegisterRateLimiter — reuse, keyed on (peer, topic))
  - packages/db-p2p/src/cohort-topic/membership-source.ts (current() is local map; fetch() is the network dial)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (existing verify/apply unit tests; no regression)
  - packages/db-core/src/cohort-topic/index.ts + packages/db-core/src/index.ts (db-core barrel exports, if verifier signature/types change)
difficulty: medium
----

# Cohort-topic: gate the inbound promote handler (verify/refetch amplification)

## Confirmed reproduction

The amplification is real and was reproduced at unit level against `verifyAndApplyNotice` +
`createMembershipVerifier`: with the cohort `MembershipCertV1` already cached (as the node caches its
own cohort cert via `onCertPublished`), **each** forged short-quorum `PromotionNoticeV1` still drives
exactly **one** `source.fetch()` — 50 forged frames → 50 network membership fetches. The cached cert
fails `messageVerifies` (forged signers), which falls through to the unconditional single refetch at
`verifier.ts:78`. There is no per-peer rate limit, no replay/freshness gate, and no refetch bound on
the `promote` handler.

The register path, by contrast, runs `RegisterRateLimiter` + `CorrelationReplayGuard` + `TopicBudget`
+ bootstrap-evidence (wired by `cohort-topic-host-antidos-coldstart`, now in `complete/`) inside the
db-core `CohortMemberEngine` before doing expensive work. Those guard *modules* exist and are
exported from db-core; this ticket reuses them rather than inventing new ones.

## Root cause

`packages/db-p2p/src/cohort-topic/host.ts` `registerProtocolHandlers`, the `promote` handler (L1429):

```ts
node.handle(protocols.promote, makeFrameHandler(async (frame) => {
  const inbound = decodeInboundNotice(frame, maxBytes);
  if (inbound === undefined) { log(...); return undefined; }
  const tier = inbound.kind === "promotion" ? inbound.notice.fromTier : inbound.notice.tier;
  const target = registry.findServing(b64urlToBytes(inbound.notice.topicId), tier);
  const outcome = await verifyAndApplyNotice(inbound, target, verifier, Date.now()); // <- expensive, ungated
  ...
}, maxBytes));
```

`makeFrameHandler` (L1466) already passes the dialing peer as the handler's second arg (`from`), but
the promote closure ignores it — so the per-peer key is available, just unused.

Inside `verifyAndApplyNotice` → `verifier.verifyMessage` (`verifier.ts:64`), a verify miss always runs
`await this.loadFrom(source.fetch(expectedCoord))` (L78). In `FretMembershipSource`, `current()` is a
pure local `Map` lookup (no network) and `fetch()` is the cohort dial — so the amplification is
specifically the unconditional `fetch()`, and suppressing it preserves the cheap local seed.

## Design — implement "both" (cheap pre-verify gating + bounded refetch)

The acceptance criteria require per-peer rate limiting **and** a bounded per-coord membership-fetch
rate, so do both layers.

### Layer 1 — pre-verify gating in the promote handler (host.ts)

Thread `from` into the promote handler and gate **before** `verifyAndApplyNotice`, cheapest checks
first. Construct the guards in `createCohortTopicHost` and pass them into `registerProtocolHandlers`.

Gate order (each step strictly cheaper than the next):

1. `decodeInboundNotice(frame)` — already first; cheap.
2. **Per-(peer, topic) rate limit.** Reuse `createRegisterRateLimiter(options.antiDos?.rateLimiter)`
   as a single node-level limiter owned by the handler set (the register-path limiter is *per-coord*
   inside each engine; the promote handler is node-level, so it needs its own instance keyed on
   `(peerIdToBytes(from), b64urlToBytes(notice.topicId))`). `check(...).ok === false` → drop + log,
   before any `findServing`/verify. Default 4/min/peer/topic with exponential backoff, same as
   register.
3. `registry.findServing(topicId, tier)` — map scan; cheap. `undefined` → existing "dropped" path.
4. **Freshness / replay gate** (drop before `verifyMessage`):
   - **High-water on `effectiveAt`.** Keep a per-`(topicId, tier)` high-water of the last *applied*
     `effectiveAt`. Drop a notice with `effectiveAt <= highWater`. Update the high-water **only** when
     `verifyAndApplyNotice` returns `"applied"` — never on an unverified frame, so a forged notice
     with `effectiveAt = Infinity` cannot poison the water and lock out legit notices.
   - **Stale `cohortEpoch` (lenient).** The receiver can compute the current epoch for the served
     cohort via `cohortAround(target.servedCoord).cohortEpoch`. A notice whose `cohortEpoch` does not
     match *may* be dropped here as an extra cheap filter — **but** epoch rotates on every membership
     change, so a legitimately in-flight notice can briefly carry the prior epoch right after a
     rotation. Recommendation: treat the epoch check as best-effort/log-only, or gate on it only when
     you also accept the immediately-prior epoch; do **not** let it be the sole load-bearing defense
     (the rate limiter + high-water are). Document whichever you pick in the handler comment.
5. `verifyAndApplyNotice(...)` with refetch suppressed (Layer 2).

Note: the notices carry `effectiveAt` + `cohortEpoch` but **no** `correlationId`/`timestamp`, so the
`CorrelationReplayGuard` module does not apply verbatim — the `effectiveAt` high-water is the
promote-path replay/freshness analogue. Do not try to force-fit `CorrelationReplayGuard` here.

### Layer 2 — bounded refetch in the verifier (db-core)

Add an optional trailing options arg to `MembershipVerifier.verifyMessage`:

```ts
verifyMessage(
  signers, expectedCoord, tier, payload, sig,
  opts?: { allowRefetch?: boolean },   // default: true (no change for existing callers/tests)
): Promise<VerifyResult>;
```

When `allowRefetch === false`, skip the `source.fetch()` retry (L78) and rely on the cheap local
`current()` seed + the cache only. `verifyAndApplyNotice` passes `{ allowRefetch: false }` for both
inbound-notice paths (L1318, L1326). Because the node caches its own cohort cert via `onCertPublished`,
a legitimate sibling-adopt notice (signed by the cohort around `servedCoord`, which is the receiver's
own cohort) verifies from cache with zero fetches; a forged notice yields `"untrusted"` with zero
fetches.

**Tradeoff (document in code):** suppressing the refetch trades a small correctness window — a
genuinely stale local cache (membership rotated but the new cert not yet re-cached) makes a *legit*
inbound notice read `"untrusted"` on the promote path until the next membership refresh re-seeds the
cache. This is acceptable per the source ticket. If you prefer to preserve eventual refetch, the
alternative is a **per-coord refetch rate-limiter** inside the verifier (a minimum interval between
`fetch()` calls per coord) instead of full suppression — bounded but non-zero. Pick full suppression
as the primary (simplest, correct in the common cached case); fall back to the rate-limited refetch
only if the demotion-to-parent / sibling-without-cached-cert path turns out to need eventual refetch
(verify against `live-tier.spec.ts` / the integration spec). Either way the per-coord fetch rate must
be bounded — that is the acceptance bar.

Existing `verifyMessage` callers (`host.ts` notice paths, `service.spec.ts` mock, `threshold-assembly`,
`live-tier`, integration specs) keep working unchanged because the new arg is optional and defaults to
the current behavior.

## Acceptance

- A peer streaming forged `promote` frames is rate-limited per `(peer, topic)` **and** cannot drive
  more than a bounded membership-fetch rate per coord. New db-p2p test floods forged notices and
  asserts the refetch/verify count is bounded (the repro harness below is the seed: assert
  `fetchCount === 0` with refetch suppressed, or `<= bound` with the rate-limited-refetch alternative;
  and assert over-rate frames are dropped without reaching `verifyMessage`).
- A stale/replayed notice (`effectiveAt <= last applied for that `(topic, tier)`) is dropped **before**
  `verifyMessage` runs.
- Legitimate notices still verify and apply — `promote-notice.spec.ts` passes unchanged, and a fresh
  legit notice after the high-water is set still applies.

## Reproduction harness (seed for the acceptance test)

A unit repro was validated during the fix stage (then removed to keep the tree clean). Recreate it as
the basis for the acceptance test — it builds a real threshold-signed cohort cert, a counting
`IMembershipSource` whose `fetch()` increments a counter, and floods forged single-signer
`PromotionNoticeV1`s through `verifyAndApplyNotice`. Pattern (mirrors `promote-notice.spec.ts` helpers
`makeMembers` / `assemblerFor` / `honestDialSign`):

```ts
let fetches = 0;
const source: IMembershipSource = {
  current: () => Promise.resolve(encodedCert),         // local seed (no network)
  fetch:   () => { fetches++; return Promise.resolve(encodedCert); }, // the amplified call
};
// flood N forged short-quorum notices through verifyAndApplyNotice -> each returns "untrusted"
// BEFORE fix: fetches === N.  AFTER fix (refetch suppressed): fetches === 0.
```

For the handler-level rate-limit assertion, drive the `promote` handler (or a small extracted
`handleInboundNotice` helper) with a fixed `from` peer and assert that beyond the rate ceiling frames
are dropped without invoking the verifier.

## TODO

- In `host.ts` `createCohortTopicHost`: build a promote-path `RegisterRateLimiter` (from
  `options.antiDos?.rateLimiter`) and pass it, plus the per-`(topicId, tier)` `effectiveAt` high-water
  map, into `registerProtocolHandlers`. Consider extracting the promote handler body into an exported
  `handleInboundNotice(...)` (like `verifyAndApplyNotice`) so it is unit-testable without a live node.
- In the `promote` handler: accept `from`, run the gate order above (rate-limit → findServing →
  effectiveAt high-water → optional lenient epoch check → verify), update the high-water only on
  `"applied"`, and keep the one-way no-ack contract + log lines.
- In `verifier.ts`: add `opts?: { allowRefetch?: boolean }` to `verifyMessage`, default `true`; skip
  the `source.fetch()` retry when `false`. Update the `MembershipVerifier` interface + JSDoc and any
  db-core barrel re-exports.
- In `verifyAndApplyNotice` (host.ts): pass `{ allowRefetch: false }` to both `verifyMessage` calls;
  document the stale-cache tradeoff in the JSDoc.
- Add the db-p2p flood test (refetch bound + per-peer rate-limit drop). Keep `promote-notice.spec.ts`
  green; add a "fresh legit notice after the high-water still applies" case.
- Run `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`, and the
  db-core + db-p2p test suites (stream output with `tee`). Verify `live-tier.spec.ts` and the
  real-libp2p integration spec are unaffected by the `verifyMessage` signature change.
