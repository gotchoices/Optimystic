description: The shared per-peer rate-limiter no longer remembers every peer/topic pair forever — it now has a size cap that evicts the coldest entries and an idle-cleanup pass, so a long-running node stops leaking memory there.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (the LRU cap + sweep + size, the meat of the change)
  - packages/db-core/src/cohort-topic/member-engine.ts (sweepStale now drives rateLimiter/probeRateLimiter sweep, ~L242)
  - packages/db-core/test/cohort-topic/antidos.spec.ts (7 → new limiter tests added to the "per-peer register rate limiter" block)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts (new "sweepStale reclaims idle rate-limiter keys" block)
  - packages/db-p2p/src/cohort-topic/host.ts (consumer only — produces limiters via createRegisterRateLimiter; not wired to sweep yet, see Gaps)
difficulty: medium
----

# Review: bound the per-peer register rate limiter's memory (LRU cap + idle sweep)

## What was built

`SlidingWindowRateLimiter` (`rate-limiter.ts`) previously kept an unbounded `Map<string, WindowState>`
— one entry per `(peer, topic)` ever checked, never evicted. It now has two complementary bounds:

- **Hard LRU cap (`maxKeys`, default `100_000`)** — enforced inline in `check()`. When a *new* key would
  exceed `maxKeys`, the least-recently-checked keys (oldest by `Map` insertion order) are evicted until
  within cap. Every `check` — accept **or** reject — does a `delete`+`set` of the key's state to move it to
  the most-recently-used end (the same trick `utility/lru-map.ts` uses).
- **Idle-TTL sweep (`idleTtlMs`, default `DEFAULT_RATE_WINDOW_MS` = 60_000)** — a new `sweep(now): number`
  method drops every key with `now - lastSeen >= idleTtlMs` and returns the count. Driver-called.

A new `lastSeen` field on `WindowState` (set to `now` on every check) is both the LRU recency marker and the
idle-TTL key. A new `size` getter exposes the tracked-key count for tests/diagnostics. The
`RegisterRateLimiter` interface gained `sweep` and `size` as required members; the existing
window/strike/back-off semantics in `check()` are otherwise unchanged.

Engine wiring: `member-engine.ts` `sweepStale(now)` (the existing per-gossip-round hook) now calls
`this.deps.rateLimiter?.sweep(now)` and `this.deps.probeRateLimiter?.sweep(now)` before the renewal sweep, so
the per-coord register-path and probe-path limiters reclaim idle keys on the existing cadence.

New exports (re-exported through `antidos/index.ts`): `DEFAULT_RATE_LIMITER_MAX_KEYS`,
`DEFAULT_RATE_LIMITER_IDLE_TTL_MS`, and the `maxKeys` / `idleTtlMs` fields on `RegisterRateLimiterConfig`.
No new host-config surface — callers tune through the existing `RegisterRateLimiterConfig` seam.

## The load-bearing invariant (verify this first)

Eviction must be **penalty-free for idle keys but never reset an active attacker**. The window logic already
forgives a source quiet for a full window (accepts age out → `strikes = 0`), so dropping an idle key and
re-allocating a fresh `{ accepts:[now], strikes:0 }` on its return is observationally identical to keeping it.
The one thing eviction must NOT drop is a key for a source *currently mid-attack* (over-rate, accumulated
`strikes` driving exponential back-off) — dropping it would reset the attacker to `strikes = 0`.

The defense is the **recency refresh on every check, including rejects**: the `delete`+`set` in `check()` runs
before the accept/reject branch, so an actively-hammering `(peer, topic)` stays MRU and is never the eviction
victim. **This is the single most important thing to confirm in review** — if the reject path ever stopped
refreshing recency, the LRU cap would become an attacker's strike-reset button.

## Validation status

- `yarn workspace @optimystic/db-core build` → exit 0.
- `yarn workspace @optimystic/db-p2p build` → exit 0 (confirms the widened interface doesn't break the
  cross-package consumer in `host.ts`, which only ever produces limiters via `createRegisterRateLimiter`).
- `yarn workspace @optimystic/db-core test` → **985 passing**, exit 0. (Includes all 7 new tests below.)

## Tests added (treat as a floor)

`antidos.spec.ts`, "per-peer register rate limiter":
- exposes `DEFAULT_RATE_LIMITER_MAX_KEYS` (100_000) / `DEFAULT_RATE_LIMITER_IDLE_TTL_MS` (== window).
- **LRU cap**: `maxKeys: 3, ratePerWindow: 1` → 4 distinct keys → `size === 3`; survivor still saturated
  (rejected), evicted key returns fresh (admitted).
- **sweep boundary**: `idleTtlMs: 1_000`; keys idle exactly 1000 (`>=`) are swept, a key refreshed at age 999
  is kept; a later sweep drops the survivor too. Confirms the `>=` boundary.
- **evicted/idle key returns fresh**: over-rate `(A,T1)` evicted by a `maxKeys: 1` flood → re-appears with the
  full `ratePerWindow` allowance and reset strikes.
- **sustained attacker survives a distinct-key flood**: build strikes on `(A,T1)`, interleave 20 distinct
  flood keys past `maxKeys: 4` while re-hammering `(A,T1)` → it stays tracked, still over-rate, with back-off
  *above* the first-strike floor (not reset). This is the invariant test.
- **construction `RangeError`** for `maxKeys` 0 / 2.5 / -1 and `idleTtlMs` 0 / -1.

`member-engine.spec.ts`, new block: injects real `rateLimiter` + `probeRateLimiter`, drives a register and a
probe (both land `no_state` on a cold cohort, but `runGuards`/`handleProbe` allocated the limiter keys first),
asserts `size === 1` each, then `sweepStale(now + idleTtlMs)` drops both to 0.

## Known gaps / honest caveats (where to push)

- **The leak is only fixed for the per-coord limiters in db-core.** The node-level `promote`-handler gate
  (`PromoteGate` in db-p2p `host.ts`) now *has* the `sweep`/`size`/`maxKeys` API on its `rateLimiter`, but
  **nothing in db-p2p drives `sweep` yet**, and its sibling `highWater` map is still unbounded. That is the
  explicit follow-on `cohort-topic-promote-gate-map-eviction` (already queued in `implement/` as sequence 2,
  with this ticket as its prereq). Don't treat the end-to-end host leak as closed by this ticket alone.
- **`sweep` is a full linear scan** of `states` each call (bounded by `maxKeys`, so worst case ~100k entries
  per gossip round on a flooded coord). This is the design's accepted cost (no heap/incremental expiry). If a
  reviewer is worried about per-round cost on the node-level gate under a 100k-key flood, that's a real
  consideration for the follow-on's tick driver — but the per-coord limiters here hold far fewer active keys.
- **LRU eviction-ordering is asserted indirectly.** The interface has no key enumeration / `has()`, so the cap
  test infers "which key was evicted" from admit-vs-reject behavior (using `ratePerWindow: 1` to make a single
  check saturate a key). It's sound but not a direct inspection — a reviewer wanting a stronger assertion would
  need to add introspection to the interface, which I deliberately avoided (keeps the public surface minimal).
- **Default `maxKeys = 100_000` is a footprint policy, not a tuned number.** Under a sustained distinct-key
  flood the cap holds `size` at 100k small entries — bounded, but still ~100k objects. The value mirrors the
  ticket's stated default; no simulator run backs it. Worth a sanity check on whether that ceiling is right for
  the node-level gate (where one peer can spray attacker-chosen `topicId`s with no `TopicBudget` in front).
- **Sweep ordering in `sweepStale`** runs the limiter sweeps *before* the renewal/budget drain. The two are
  independent state, so order is functionally irrelevant — flagged only so a reviewer doesn't read a dependency
  into it.
