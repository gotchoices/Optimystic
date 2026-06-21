description: A node's defense against junk "promote" network traffic keeps a record for every peer and topic it ever sees and never forgets them, so a long-running node slowly leaks memory and an attacker can speed that up by sending notices for many made-up topics; cap those records and sweep idle ones on the timer the node already runs.
prereq: cohort-topic-rate-limiter-eviction
files:
  - packages/db-p2p/src/cohort-topic/host.ts (PromoteGate, createPromoteGate, handleInboundNotice, driveTick ~L818)
  - packages/db-core/src/utility/lru-map.ts (LruMap — exported from @optimystic/db-core)
  - packages/db-core/src/cohort-topic/promotion.ts (PromotionState.lastEffectiveAt — the engine-side idempotency source of truth)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (host anti-DoS test home)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (flood-at-scale test home)
difficulty: medium
----

# Bound the node-level `promote`-gate maps (LRU `highWater` + tick-driven limiter sweep)

## Background

The node-level `promote`-handler anti-abuse gate (`host.ts`) holds two retain-forever maps:

- `PromoteGate.rateLimiter` — its own `RegisterRateLimiter`, one `(peer, topic)` entry per inbound notice
  ever checked. The rate check runs **before** `findServing` (deliberately — `findServing` is an O(engines)
  scan, so rate-limiting first shields it), so a forged notice for a topic this node does **not** serve
  *still* allocates a limiter entry. `topicId` is attacker-chosen, so one peer spraying distinct random
  `topicId`s grows the map without bound — and there is no `TopicBudget` in front of it on the promote path.
- `PromoteGate.highWater` — `Map<string, number>`, one `(topicId, tier)` entry per *applied* notice's
  `effectiveAt`. Unlike the limiter this is **not** attacker-growable (it is written only on an `"applied"`
  outcome, which requires a verified `≥ minSigs` cohort threshold signature; reads of forged `topicId`s via
  `.get` create nothing), so it grows only with legitimate promotion/demotion activity — but it still never
  evicts, so it leaks slowly on a long-lived node.

The prereq ticket `cohort-topic-rate-limiter-eviction` already gave `RegisterRateLimiter` its bounded-memory
API (`maxKeys` LRU cap enforced inline in `check()`, plus a driver-called `sweep(now)` and a `size` getter).
This ticket consumes that API in the host: the limiter's hard cap already bounds the promote-gate limiter the
moment the prereq lands; here we (a) wire the limiter's `sweep` into the host's existing gossip tick for
proactive idle reclaim, and (b) bound `highWater` with an `LruMap`.

## Design

### `highWater` → `LruMap<string, number>`

Swap the bare `Map` for `LruMap` (`@optimystic/db-core`, already exported) with a modest cap:

```ts
export const PROMOTE_HIGHWATER_MAX_KEYS = 8192;

export interface PromoteGate {
  readonly rateLimiter: RegisterRateLimiter;
  readonly highWater: LruMap<string, number>; // was Map<string, number>
}

export function createPromoteGate(rateLimiterConfig?: RegisterRateLimiterConfig): PromoteGate {
  return {
    rateLimiter: createRegisterRateLimiter(rateLimiterConfig),
    highWater: new LruMap<string, number>(PROMOTE_HIGHWATER_MAX_KEYS),
  };
}
```

`handleInboundNotice` already uses only `.get(waterKey)` (read; refreshes recency) and `.set(waterKey, …)`
(write on `"applied"`), both of which `LruMap` supports with `Map`-compatible signatures — so the handler body
is unchanged apart from the field type. `LruMap.get` returns `undefined` for an absent key exactly like `Map`,
and `highWater` values are always numbers (never `undefined`), so `LruMap`'s `value !== undefined` refresh guard
behaves correctly. A modest cap is plenty: only verified applies grow the map, so it never evicts under
legitimate load; the cap is the belt-and-suspenders bound on the retain-forever shape.

### Why evicting a `highWater` entry is safe (acceptance bullet 3)

Confirmed against `promotion.ts`: the engine's `PromotionLifecycle` is **independently idempotent and
`effectiveAt`-ordered** via `PromotionState.lastEffectiveAt`. `applyPromotionNotice` / `applyDemotionNotice`
adopt a notice only if `isNewerTransition` holds (`effectiveAt > lastEffectiveAt`); otherwise they no-op
(`promotion.ts:223-247`). The gate's `highWater` is a **strictly-weaker early-drop optimization** that saves a
`verifyMessage` on an obvious replay — it is *not* the idempotency authority. So an evicted-then-replayed older
notice: passes the now-absent gate-water check → gets verified (one bounded `verifyMessage`, itself rate-capped
by `PROMOTE_REFETCH_MIN_INTERVAL_MS`) → and **no-ops at the engine** because its `effectiveAt <= lastEffectiveAt`.
Eviction therefore never lets a stale/replayed notice be (re-)applied; it only trades a tiny verify for memory.
No TTL sweep is needed for `highWater` — the LRU cap plus the non-attacker-growable write path bound it.

### Tick-driven limiter sweep

The host already owns a single `setInterval` gossip-cadence driver (`driveTick`, `host.ts` ~L818) that captures
`const now = Date.now()` and loops every engine. `promoteGate` is in `driveTick`'s closure scope. After the
per-engine loop (inside the existing `try`, so the re-entrancy guard / `stopped` short-circuit still apply), add:

```ts
promoteGate.rateLimiter.sweep(now);
```

This reclaims idle node-level limiter keys on the same cadence the per-coord engines already sweep on (the
prereq wired those into `member-engine` `sweepStale`). The limiter's inline `maxKeys` cap is the hard worst-case
bound; this sweep is the proactive steady-state reclaim. No new timer, no new option — `maxKeys` / `idleTtlMs`
are tunable through the already-plumbed `antiDos.rateLimiter` config that `createPromoteGate` receives.

## Edge cases & interactions

- **Distinct-`topicId` flood at the promote handler.** One peer streaming notices with distinct attacker-chosen
  `topicId`s must hold `promoteGate.rateLimiter.size` at `maxKeys`, not grow it unbounded — the core acceptance
  criterion. (These notices are also dropped at `findServing` for "no serving engine", but the point is the
  limiter entry no longer leaks.)
- **Idle node-gate key reclaimed by the tick.** After a notice from `(peer, topic)`, once `idleTtlMs` elapses
  with no further notice, a subsequent `driveTick` sweep drops the key; a later notice from the same source
  re-allocates fresh (penalty-free, per the prereq's invariant).
- **`highWater` not attacker-growable.** A flood of *forged* (never-applied) notices must leave `highWater.size`
  unchanged — only `.get` (no insert) runs for them; `.set` is reached solely on `"applied"`.
- **Stale replay after `highWater` eviction still no-ops at the engine.** The headline safety test: seed a water
  for `(topic, tier)`, force its eviction (overflow the `LruMap` cap or use a small cap), replay an *older*
  `effectiveAt` notice through `handleInboundNotice` against a real `PromotionLifecycle`-backed target, and
  assert the engine's promoted state does **not** regress (apply no-ops via `lastEffectiveAt`) — outcome is the
  engine's idempotent no-op, never a re-apply.
- **`LruMap.get` recency on every inbound notice.** Each notice for a *resident* `(topic, tier)` refreshes its
  water recency; cold `(topic, tier)`s age out under the cap. Confirm an in-flight legitimate promotion whose
  water was just evicted is not wrongly blocked (it re-verifies and applies normally — water absence only *opens*
  the gate, never closes it).
- **Re-entrancy / lifecycle.** The sweep runs inside `driveTick`'s existing `ticking` guard and after the
  `stopped` short-circuit, single-threaded; no race with concurrent ticks or with `stop()`.
- **Config plumbing.** `antiDos.rateLimiter.maxKeys` / `.idleTtlMs` reach this limiter via `createPromoteGate`
  exactly as they reach the per-coord limiters — a test tunes a small `maxKeys` / `idleTtlMs` to exercise
  eviction without flooding 100k keys.

## TODO

- Import `LruMap` from `@optimystic/db-core`; change `PromoteGate.highWater` to `LruMap<string, number>`; add
  `PROMOTE_HIGHWATER_MAX_KEYS` and update `createPromoteGate`. Confirm `handleInboundNotice`'s `.get`/`.set`
  usage compiles unchanged against `LruMap`.
- Add `promoteGate.rateLimiter.sweep(now)` to `driveTick` after the per-engine loop (inside the `try`).
- Tests (extend `host-antidos-coldstart.spec.ts` or a new `promote-gate-bounded-memory.spec.ts`, using the
  exported `handleInboundNotice` / `createPromoteGate` so no live node is required):
  - flood `handleInboundNotice` with many distinct forged `topicId`s (small `maxKeys` via `createPromoteGate`
    config) → `promoteGate.rateLimiter.size <= maxKeys`.
  - `highWater` LRU cap: drive (or directly `.set`) more than `maxKeys` applied waters → `highWater.size` caps;
    least-recently-used `(topic, tier)` evicted.
  - **stale-replay-after-eviction no-op:** with a `NoticeApplyTarget` backed by a real `PromotionLifecycle`,
    apply a promotion, evict its water, replay an older `effectiveAt` → engine state unchanged (idempotent no-op).
  - forged-notice flood leaves `highWater.size` unchanged (only applied notices write it).
  - idle node-gate key: start a host with tiny `gossipIntervalMs` + small `idleTtlMs`, deliver one notice, let
    a couple of ticks fire, assert `promoteGate.rateLimiter.size` returns to 0 (host-level integration, if a
    host harness is convenient; otherwise call `driveTick`'s sweep path via the limiter directly).
- `yarn workspace @optimystic/db-p2p test` (stream with `2>&1 | tee`), `yarn workspace @optimystic/db-p2p build`.
