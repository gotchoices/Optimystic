description: The shared per-peer rate-limiter no longer remembers every peer/topic pair forever — it now has a size cap that evicts the coldest entries and an idle-cleanup pass, so a long-running node stops leaking memory there.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (LRU cap + sweep + size; review tightened the invariant docs)
  - packages/db-core/src/cohort-topic/member-engine.ts (sweepStale drives rateLimiter/probeRateLimiter sweep, ~L242)
  - packages/db-core/test/cohort-topic/antidos.spec.ts (limiter cap/sweep/invariant tests)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts ("sweepStale reclaims idle rate-limiter keys")
  - packages/db-p2p/src/cohort-topic/host.ts (per-coord limiters swept via engine.sweepStale; node-level PromoteGate still unswept — follow-on)
  - docs/cohort-topic.md (anti-DoS implementation note now mentions the memory bound)
difficulty: medium
----

# Complete: bound the per-peer register rate limiter's memory (LRU cap + idle sweep)

## What shipped

`SlidingWindowRateLimiter` (`rate-limiter.ts`) gained two complementary bounds on its previously
unbounded `Map<string, WindowState>`:

- **Hard LRU cap (`maxKeys`, default `100_000`)** — enforced inline in `check()`. A new key that would
  exceed the cap evicts the least-recently-checked keys (oldest by `Map` insertion order) until within
  cap. Every `check` (accept **or** reject) does a `delete`+`set` to move the key to the MRU end, so an
  actively-hammering source is never the eviction victim and its back-off escalation is never reset.
- **Idle-TTL sweep (`idleTtlMs`, default `== windowMs` = 60_000)** — a new `sweep(now): number` drops
  keys idle `>= idleTtlMs` and returns the count. `member-engine.ts` `sweepStale(now)` calls it for both
  `rateLimiter` and `probeRateLimiter` on the existing per-gossip-round cadence; the db-p2p host drives
  `engine.sweepStale(now)` each round, so the per-coord register/probe limiters reclaim idle keys
  end-to-end.

New surface: `lastSeen` on `WindowState`, a `size` getter, `sweep`/`size` as required `RegisterRateLimiter`
members, `DEFAULT_RATE_LIMITER_MAX_KEYS` / `DEFAULT_RATE_LIMITER_IDLE_TTL_MS`, and `maxKeys`/`idleTtlMs`
config fields (re-exported via `antidos/index.ts`). No new host-config surface — callers tune through the
existing `RegisterRateLimiterConfig` seam.

## Review findings

Reviewed the implement diff (`2c7a824`) with fresh eyes against the touched and should-have-touched files,
then ran the full db-core build + suite.

**Load-bearing invariant (the one the ticket flagged to verify first) — CONFIRMED.** The recency refresh
(`delete`+`set` plus `lastSeen = now`) in `check()` runs *before* the accept/reject branch, so a reject
refreshes recency exactly like an accept. An active attacker stays at the MRU end and is never the LRU
eviction victim — the cap cannot become a strike-reset button. The new-key eviction loop
(`while (size >= maxKeys)`) correctly bounds final size at `maxKeys`, and the `size`/`sweep` boundary
(`>=`) is exercised by tests. The "sustained attacker survives a distinct-key flood" test is a genuine
invariant test and passes.

- **Correctness / logic:** No bugs found. New-key cap math is correct (final `size <= maxKeys`).
  `sweep` deletes during `Map` for-of iteration, which is well-defined in JS. `maxKeys` validation
  requires a positive integer; `idleTtlMs` requires `> 0` (non-integer ms intentionally allowed).
- **Invariant doc accuracy (MINOR — fixed inline):** The class docstring claimed dropping an idle key is
  "observationally identical to keeping it." That holds for the LRU cap and for the **default**
  `idleTtlMs == windowMs`, but the config permits `idleTtlMs < windowMs` (the tests use `1_000`), where
  `sweep` can drop a key whose accepts have not fully aged out — forgiving its accumulated `strikes`
  sooner than the window alone would. This is an accepted footprint/strike-accounting tradeoff, not an
  identity, and production uses the safe default. Tightened the class docstring and the `idleTtlMs` config
  doc to state the constraint (`keep >= windowMs` to preserve the penalty-free invariant). Behavior
  unchanged — adding a hard validation would have wrongly broken the legitimate fast-TTL test usage, so
  this is deliberately documentation-only.
- **Docs (MINOR — fixed inline):** `docs/cohort-topic.md` anti-DoS implementation note described the
  `RegisterRateLimiter` as a plain sliding-window with no mention of the new memory bound. Added a clause
  noting the LRU cap + idle-TTL sweep so the canonical spec reflects the new reality. No other doc the
  change touches was stale.
- **Interface widening blast radius:** Checked all `RegisterRateLimiter` implementers/consumers. The only
  production implementer is `SlidingWindowRateLimiter`. The one test mock (`makeProbeEngine`,
  `member-engine.spec.ts:306`) supplies `{ check }` only but is cast `as never`, so the now-required
  `sweep`/`size` members don't break compilation. db-p2p `host.ts` only ever produces limiters via
  `createRegisterRateLimiter`, so the widened interface is satisfied; the implementer's db-p2p build
  (exit 0) confirms this.
- **Tests (starting point → assessed):** Happy path, LRU eviction, sweep boundary, fresh-key reset,
  the sustained-attacker invariant, and construction `RangeError`s are all covered, plus the engine-level
  `sweepStale` integration for both register and probe limiters. Coverage is adequate; no gaps worth a new
  test were found. LRU eviction ordering is asserted indirectly (no key enumeration on the interface) —
  sound, and the implementer correctly declined to widen the public surface just for a stronger assertion.
- **Performance / resource cleanup:** `sweep` is an O(n) scan bounded by `maxKeys` — the design's accepted
  cost. No leaks remain in the per-coord path; the map is GC'd with the engine.

**Validation:** `yarn workspace @optimystic/db-core build` → exit 0. `yarn workspace @optimystic/db-core test`
→ **985 passing**, exit 0 (after the doc edits, which don't change behavior). No lint is configured for this
package (root `lint` is a no-op echo). No pre-existing failures observed.

## Known follow-on (not regressions, out of scope here)

- **Node-level `PromoteGate` leak still open.** The db-p2p `promote`-handler gate (`host.ts`) now has the
  `sweep`/`size`/`maxKeys` API on its `rateLimiter`, but nothing in db-p2p drives `sweep` for it and its
  sibling `highWater` map is still unbounded. Tracked by `cohort-topic-promote-gate-map-eviction`
  (`tickets/implement/2-...`, with this ticket as prereq). The end-to-end host leak is **not** closed by
  this ticket alone.
- **Default `maxKeys = 100_000` is a footprint policy, not a tuned/simulated number.** Worth a sanity check
  for the node-level gate (where one peer can spray attacker-chosen `topicId`s with no `TopicBudget` in
  front); flagged for the follow-on's tick driver.

## End
