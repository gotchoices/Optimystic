description: A long-running node's defense against junk "promote" traffic used to keep a record for every peer and topic forever; now those records are capped and idle ones are swept on the timer the node already runs, so memory stays bounded.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (PromoteGate, createPromoteGate, PROMOTE_HIGHWATER_MAX_KEYS, driveTick sweep, CohortTopicHost.promoteGate)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (gate bounded-memory tests)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (host-timer sweep integration test)
  - packages/db-core/src/utility/lru-map.ts (LruMap — consumed, unchanged)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (RegisterRateLimiter sweep/size/maxKeys — prereq API, unchanged)
  - docs/cohort-topic.md (§Anti-DoS promote-handler gate paragraph — updated to reflect bounded maps)
----

# Complete: bound the node-level `promote`-gate maps (LRU `highWater` + tick-driven limiter sweep)

## What landed

The node-level `promote`-handler anti-abuse gate (`PromoteGate` in `host.ts`) held two retain-forever maps;
both are now bounded:

1. **`PromoteGate.highWater` → `LruMap<string, number>`** capped at the new exported
   `PROMOTE_HIGHWATER_MAX_KEYS = 8192`. `handleInboundNotice`'s `.get`/`.set` usage is unchanged
   (`LruMap` is signature-compatible for both; confirmed no other consumer uses `Map`-only methods).
2. **Tick-driven limiter sweep** — `promoteGate.rateLimiter.sweep(now)` added to the host's existing
   `driveTick` gossip-cadence driver, after the per-engine loop, inside the `ticking`/`stopped` guard.
   The prereq (`cohort-topic-rate-limiter-eviction`) supplied the inline `maxKeys` LRU hard cap (the
   worst-case bound) plus the `sweep(now)`/`size` API this consumes.
3. **`CohortTopicHost.promoteGate`** exposed (`readonly`, additive) as a test/diagnostic seam, consistent
   with the existing `gossipTransport` / `budgetHasTopic` introspection exposures.

The correctness pillar: evicting a `highWater` entry can never let a stale/replayed notice (re-)apply —
high-water is a strictly-weaker early-drop optimization, not the idempotency authority. The engine's
`PromotionLifecycle` is independently idempotent and `effectiveAt`-ordered (`PromotionState.lastEffectiveAt`),
so an evicted-then-replayed older notice re-verifies once (rate-capped) and then no-ops at the engine.
Water absence only *opens* the gate, never closes it.

## Review findings

Reviewed adversarially against the implement diff (`5e7be31`) from every angle (SPP, DRY, modularity,
scalability, resource cleanup, error handling, type safety, eviction-safety, test coverage, docs).

### Checked — and clean

- **Eviction safety (the load-bearing argument).** Confirmed in code: eviction removes a `highWater`
  entry → `water === undefined` → notice is **not** dropped → proceeds to verify, where the engine's
  `lastEffectiveAt` ordering no-ops any `effectiveAt <= lastEffectiveAt`. Eviction can therefore never
  cause a wrong `stale` drop (it only ever *opens* the gate) nor a wrong apply (verify + engine
  idempotency are downstream of the gate). The headline test `an evicted high-water lets a stale replay
  re-verify but the engine idempotently no-ops it` exercises exactly this and passes.
- **Attacker-growability asymmetry.** The limiter rate-check runs *before* `findServing`
  (`host.ts:1968` vs `:1973`), so a forged notice for an unserved attacker-chosen `topicId` allocates a
  `(peer, topic)` limiter entry — hence the `maxKeys` cap + sweep are the headline defense. `highWater`
  is written only on a verified `applied` outcome (`host.ts:1988-1990`), so it is **not** attacker-growable;
  the test `a flood of forged notices leaves highWater empty` confirms the write path.
- **`LruMap` compatibility.** `grep` over `src` confirms `highWater` is consumed only via `.get`/`.set`,
  both present on `LruMap`. No iteration / `forEach` / `entries` consumer that the swap would break.
- **Sweep placement / re-entrancy.** `sweep` sits inside the `try`, after the per-engine loop, under the
  `ticking` re-entrancy guard with a `stopped` short-circuit at tick entry; per-engine errors are caught
  in the inner `try`, so an engine throwing never skips the sweep. A `stop()` racing mid-tick is harmless
  (sweep only mutates an in-memory map that is then GC'd). No race.
- **Config wiring.** `createPromoteGate(options.antiDos?.rateLimiter)` (`host.ts:663`) flows the
  `antiDos.rateLimiter` block (incl. `idleTtlMs`, `maxKeys`) into the gate; verified by the integration test.
- **Type safety / build.** `yarn workspace @optimystic/db-core build` ✓ and
  `yarn workspace @optimystic/db-p2p build` ✓ — both clean.
- **Tests.** Full cohort-topic suite (`test/cohort-topic/**/*.spec.ts`): **181 passing, 5 pending,
  0 failing** (~11s), including the 5 new tests. Lint is a project-wide no-op
  (`"lint": "echo 'Lint not configured'"`); `tsc` is the real static gate and is clean. (Did not re-run
  the full ~6-min db-p2p suite; the change is additive and confined to `host.ts` + the cohort-topic
  specs, and the implementer reported 991 passing on it.)

### Found and fixed inline (minor)

- **Stale design doc.** `docs/cohort-topic.md` (§Anti-DoS, promote-handler gate paragraph, ~line 929)
  still described the two gate maps as an unbounded "slow leak for a long-lived node" with "bounded
  eviction is deferred — `cohort-topic-promote-gate-map-eviction`". That deferral is exactly what this
  ticket resolved, so the prose was now false. Rewrote it to state both maps are bounded (limiter =
  attacker-growable → `maxKeys` cap + idle-TTL sweep; high-water = `LruMap` cap, write-gated on verified
  applies), and folded in the eviction-safety argument (re-verify-then-no-op via `lastEffectiveAt`). No
  other doc passage made a now-false memory claim (the §Promotion-lifecycle high-water mentions at lines
  ~623/634 describe ordering, not memory, and remain accurate).

### Major findings → new tickets

**None.** No correctness, resource-leak, or API defect rose to needing a follow-up ticket.

### Considered and deliberately not filed

- **No config knob for the `highWater` cap** (hard-coded `8192`; `createPromoteGate` still takes only the
  rate-limiter config). Flagged by the implementer. Not filed: eviction is *proven* safe (worst case is one
  extra rate-capped re-verify that then no-ops), so there is no correctness driver, and the map is not
  attacker-growable so `8192` is generous for legitimate served-topic counts. A tunable is a speculative
  enhancement, not a defect — left for a real need to motivate it rather than getting ahead.
- **LRU-cap & stale-replay tests force eviction via filler-overflow** rather than 8192 genuine
  `≥ minSigs`-signed applies (prohibitively slow). Judged acceptable: both faithfully drive the `LruMap`
  eviction path and the gate's `.get`/`.set`; an end-to-end "8192 real applies evict the coldest" harness
  would add minutes of runtime for no additional path coverage.
- **Host-timer integration test is wall-clock-based** (`gossipIntervalMs: 5`, `idleTtlMs: 10`,
  `delay(80)` ≈ 16 ticks past a 10ms TTL). The margin is wide and matches the existing cold-start
  `delay(30)` tests' style; theoretical flake only on a severely overloaded CI box. Not worth a fake-clock
  rework here.
- **No explicit "sweep runs with zero engines" assertion.** The integration test incidentally covers it
  (the fake host serves no coord at tick time, so `registry.all()` is empty and the sweep still fires).
  Minor test-precision gap, not a behavior gap — the sweep sits unconditionally after the engine loop.

## Validation performed (review pass)

- `yarn workspace @optimystic/db-core build` ✓, `yarn workspace @optimystic/db-p2p build` ✓.
- `test/cohort-topic/**/*.spec.ts`: **181 passing, 5 pending, 0 failing**. No pre-existing failures
  surfaced; `.pre-existing-error.md` not written.

## End
