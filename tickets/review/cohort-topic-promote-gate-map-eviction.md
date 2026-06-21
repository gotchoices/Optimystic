description: A long-running node's defense against junk "promote" traffic used to keep a record for every peer and topic forever; now those records are capped and idle ones are swept on the timer the node already runs, so memory stays bounded.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (PromoteGate, createPromoteGate, PROMOTE_HIGHWATER_MAX_KEYS, driveTick sweep, CohortTopicHost.promoteGate)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (gate bounded-memory tests)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (host-timer sweep integration test)
  - packages/db-core/src/utility/lru-map.ts (LruMap — consumed, unchanged)
  - packages/db-core/src/cohort-topic/promotion.ts (PromotionState.lastEffectiveAt — engine idempotency authority, unchanged)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (RegisterRateLimiter sweep/size/maxKeys — prereq API, unchanged)
----

# Review: bound the node-level `promote`-gate maps (LRU `highWater` + tick-driven limiter sweep)

## What this ticket did

The node-level `promote`-handler anti-abuse gate (`PromoteGate` in `host.ts`) held two retain-forever maps.
This change bounds both:

1. **`PromoteGate.highWater` → `LruMap<string, number>`.** Swapped the bare `Map<string, number>` for an
   `LruMap` from `@optimystic/db-core` (already exported) capped at the new exported const
   `PROMOTE_HIGHWATER_MAX_KEYS = 8192`. `handleInboundNotice`'s `.get(waterKey)` / `.set(waterKey, …)` usage
   is unchanged (LruMap is `Map`-signature-compatible for those two ops). `createPromoteGate`'s signature is
   unchanged (`createPromoteGate(rateLimiterConfig?)`).

2. **Tick-driven limiter sweep.** Added `promoteGate.rateLimiter.sweep(now)` to the host's existing
   `driveTick` gossip-cadence driver, after the per-engine loop, inside the existing `try` (so the
   `ticking` re-entrancy guard and `stopped` short-circuit still apply). The prereq
   (`cohort-topic-rate-limiter-eviction`) already gave `RegisterRateLimiter` the inline `maxKeys` LRU hard
   cap (enforced in `check()`) plus the `sweep(now)`/`size` API this consumes. The cap is the worst-case
   bound the moment the prereq landed; this sweep is the proactive steady-state reclaim of idle keys.

3. **`CohortTopicHost.promoteGate` exposed.** Added a `readonly promoteGate: PromoteGate` field to the host
   interface (and returned it). **This is the one addition beyond the ticket's literal TODO** — it was
   needed so the `driveTick → sweep` wiring is observable in a host-level integration test (the gate was
   previously a closure-local with no test seam). It is documented as test/diagnostic introspection,
   consistent with the existing `budgetHasTopic` / `gossipTransport` exposures. **Reviewer: please sanity-check
   this public-API addition is acceptable** (it is additive and readonly, so low-risk).

## Why eviction is safe (the load-bearing correctness argument)

Evicting a `highWater` entry can never let a stale/replayed notice be (re-)applied. The gate's high-water is
a **strictly-weaker early-drop optimization** that saves a `verifyMessage` on an obvious replay; it is *not*
the idempotency authority. The engine's `PromotionLifecycle` is independently idempotent and
`effectiveAt`-ordered via `PromotionState.lastEffectiveAt` (`promotion.ts:223-247`): `applyPromotionNotice` /
`applyDemotionNotice` adopt a notice only if `effectiveAt > lastEffectiveAt`, else they no-op. So an
evicted-then-replayed older notice: passes the now-absent gate-water check → gets verified (one bounded
`verifyMessage`, itself rate-capped by `PROMOTE_REFETCH_MIN_INTERVAL_MS`) → and **no-ops at the engine**.
Water absence only *opens* the gate, never closes it. No TTL sweep is needed for `highWater` (the LRU cap +
the non-attacker-growable write path bound it; it is written only on a verified `"applied"` outcome).

The limiter (`PromoteGate.rateLimiter`) *is* attacker-growable — the rate check runs before `findServing`, so
a forged notice for an unserved, attacker-chosen `topicId` still allocates a `(peer, topic)` limiter entry —
which is exactly why its `maxKeys` cap + sweep are the headline defense.

## Validation performed

`yarn workspace @optimystic/db-core build` ✓, `yarn workspace @optimystic/db-p2p build` ✓ (both clean).
Full `yarn workspace @optimystic/db-p2p test`: **991 passing, 30 pending, 0 failing** (~6 min). No
pre-existing failures surfaced; `.pre-existing-error.md` not written.

### New tests — `promote-notice.spec.ts` (`describe('cohort-topic: promote-gate bounded memory')`)

- **distinct-topicId flood → limiter capped.** One peer, 50 distinct attacker-chosen `topicId`s through
  `handleInboundNotice` with `createPromoteGate({ maxKeys: 8 })` → `gate.rateLimiter.size` stays `<= 8`
  (asserted `=== 8`, the cap reached). This is the core acceptance criterion.
- **`highWater` LRU cap.** Set `PROMOTE_HIGHWATER_MAX_KEYS + 10` entries directly via `gate.highWater.set`
  → `size === PROMOTE_HIGHWATER_MAX_KEYS`; the oldest 10 evicted, newest survive.
- **stale-replay-after-eviction no-op (headline safety test).** Against a real `PromotionLifecycle`-backed
  `NoticeApplyTarget`: apply a promotion at `effectiveAt = 10_000`, overflow the LruMap cap to evict that
  water, then replay an *older* demotion (`effectiveAt = 8_000`). Asserts the notice re-verified
  (`result === 'applied'`, i.e. the eviction re-opened the gate — **not** dropped as `'stale'`) **and**
  `life.isPromoted(TOPIC)` is still `true` (the engine idempotently ignored the stale demotion — no
  regression). This is the test that proves eviction is safe.
- **forged flood leaves `highWater` empty.** 40 forged (untrusted) notices → `gate.highWater.size === 0`
  (only a verified `"applied"` outcome writes the water).

### New test — `host-antidos-coldstart.spec.ts`

- **gossip tick sweeps idle node-gate limiter keys.** A host with `gossipIntervalMs: 5` +
  `antiDos.rateLimiter.idleTtlMs: 10`; allocate one node-gate key via `host.promoteGate.rateLimiter.check`,
  assert `size === 1`, `delay(80)`, assert `size === 0`. The node-gate limiter is swept *only* by
  `driveTick` (per-coord limiters are distinct instances), so this fails if the sweep call is missing or
  scoped outside the tick.

## Known gaps / things for the reviewer to probe (tests are a floor, not a ceiling)

- **`promoteGate` API exposure** — see point 3 above. Confirm acceptable, or suggest a narrower seam.
- **`highWater` cap has no config knob.** It is hard-coded at `PROMOTE_HIGHWATER_MAX_KEYS = 8192`
  (`createPromoteGate` still only takes the rate-limiter config, per the design). If a tunable cap is wanted,
  that is a follow-up — flagged, not done.
- **LRU-cap test sets entries directly** rather than driving 8192 real verified applies (each apply needs a
  real `≥ minSigs` threshold signature — prohibitively slow to do 8192×). The stale-replay test likewise
  forces eviction by *overflowing the cap with filler entries*. Both faithfully exercise the LruMap eviction
  path and the gate's `.set`/`.get`; a reviewer wanting an end-to-end "8192 genuine applies evict the
  coldest" assertion would need a different (slow) harness — judged not worth the runtime.
- **Host-timer integration test is timing-based** (`gossipIntervalMs: 5`, `idleTtlMs: 10`, `delay(80)` →
  ~16 ticks past a 10ms TTL). The margin is wide, but it is wall-clock-dependent like the existing
  cold-start `delay(30)` tests; a heavily-loaded CI box is the theoretical flake risk.
- **No direct assertion that `driveTick`'s sweep runs with zero engines.** The integration test happens to
  exercise it (the fake host serves no coord at tick time, so `registry.all()` is empty and the sweep still
  fires), but that is incidental, not asserted as such.
- **Interaction with `idleTtlMs < windowMs`.** The integration test sets `idleTtlMs: 10` while `windowMs`
  defaults to 60_000. Per the prereq's rate-limiter doc this is the "reclaims sooner, may forgive strikes
  early" tradeoff (not the penalty-free invariant). Harmless here (the swept key is idle), but worth a glance
  if the reviewer wants the node-gate to keep `idleTtlMs >= windowMs` in production (it does by default).
