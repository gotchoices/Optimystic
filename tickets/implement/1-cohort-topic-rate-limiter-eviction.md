description: The shared per-peer rate-limiter remembers every peer/topic pair it ever sees and never forgets them, so a long-running node slowly leaks memory; give it a size cap plus an idle-cleanup pass so old entries get dropped.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (SlidingWindowRateLimiter.states — the unbounded map)
  - packages/db-core/src/cohort-topic/antidos/index.ts (re-exports)
  - packages/db-core/src/cohort-topic/member-engine.ts (deps.rateLimiter / deps.probeRateLimiter; sweepStale is the per-gossip-round hook, ~L242)
  - packages/db-core/test/cohort-topic/antidos.spec.ts (existing limiter tests to extend)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts (engine-level sweep test)
difficulty: medium
----

# Bound the per-peer register rate limiter's memory (LRU cap + idle sweep)

## Background

`SlidingWindowRateLimiter` (`rate-limiter.ts`) keeps `private readonly states = new Map<string, WindowState>()`
— one entry per `(peer, topic)` key ever **checked** — and never evicts. Its own header already calls this out:
each entry's *accept history* is trimmed to `O(ratePerWindow)`, but "the map itself retains one such small
entry per `(peer, topic)` ever seen — global eviction of long-idle keys is the host service's lifecycle concern,
not this counter's."

This limiter is the shared piece behind **both** retain-forever maps the parent ticket targets:

- the node-level `promote`-handler gate's own `RegisterRateLimiter` (db-p2p `host.ts`), and
- each `CohortMemberEngine`'s per-coord register-path `rateLimiter` / `probeRateLimiter` (`member-engine.ts`).

Giving the limiter class itself a bounded-memory strategy fixes the leak everywhere it is used in one change.
This ticket is the db-core foundation; the db-p2p wiring (the node-level gate map + the host's sweep driver)
is the follow-on `cohort-topic-promote-gate-map-eviction`, which depends on the `sweep`/`size` API added here.

## Why eviction is safe (the load-bearing invariant)

Evicting an idle key is **penalty-free**. The existing window logic already forgives a source that has been
quiet for a full window: when its accepts all age out, `live === 0` resets `strikes = 0` (`rate-limiter.ts:100-103`).
So a key that has been idle for a full window already holds nothing but a reset counter — dropping it and
re-allocating a fresh `{ accepts:[now], strikes:0 }` on the source's return is **observationally identical** to
keeping it. Eviction is just an earlier reclaim of state the limiter would have reset anyway.

The one thing eviction must **not** drop is a key for a source that is *currently mid-attack* (over-rate, with
accumulated `strikes` driving exponential back-off). Dropping that key would reset the attacker to `strikes = 0`
and discard the back-off escalation. The defense: **recency is refreshed on every `check`, including rejects**,
so an actively-hammering `(peer, topic)` stays at the most-recently-used end and is never the eviction victim,
while a genuinely idle legit key ages to the cold end. This is the central design constraint — get it wrong and
the LRU cap becomes an attacker's strike-reset button.

## Design

Two complementary, individually-sufficient bounds on `states`:

- **Hard LRU cap (`maxKeys`)** — enforced inline in `check()`, no external driver needed. Guarantees a
  worst-case footprint under a flood of distinct `(peer, topic)` keys (the attack: one peer spraying random
  attacker-chosen `topicId`s). When a *new* key would exceed `maxKeys`, evict the least-recently-checked
  (oldest by `Map` insertion order) until within cap. This alone satisfies "bounded worst-case footprint."
- **Idle-TTL sweep (`idleTtlMs`)** — a `sweep(now)` method that drops keys not checked within `idleTtlMs`.
  Reclaims steady-state footprint proportional to *active* keys (the slow-leak fix for the non-flood case).
  It is **driver-called** on the existing gossip cadence — the host tick for the node-level gate, and each
  engine's per-round `sweepStale` for the per-coord limiters (wired here for the engine; wired in the host by
  the follow-on ticket).

LRU ordering rides `Map` insertion order (the same trick `utility/lru-map.ts` uses): every `check` does a
`delete`+`set` of the key's state so the touched key moves to the most-recently-used end. A per-state `lastSeen`
timestamp (set to `now` on every check) is the idle-TTL key for `sweep`.

### Interface / type changes

```ts
// new exported defaults (alongside DEFAULT_REGISTER_RATE_PER_PEER / DEFAULT_RATE_WINDOW_MS)
export const DEFAULT_RATE_LIMITER_MAX_KEYS = 100_000;        // hard cap on tracked (peer,topic) keys
export const DEFAULT_RATE_LIMITER_IDLE_TTL_MS = DEFAULT_RATE_WINDOW_MS; // 60_000 — one quiet window = evictable

export interface RegisterRateLimiterConfig {
  ratePerWindow?: number;
  windowMs?: number;
  backoff?: BackoffConfig;
  /** Hard cap on tracked (peer,topic) keys; least-recently-checked evicted beyond this. Default DEFAULT_RATE_LIMITER_MAX_KEYS. */
  maxKeys?: number;
  /** A key not checked within this many ms is evictable by sweep(). Default DEFAULT_RATE_LIMITER_IDLE_TTL_MS. */
  idleTtlMs?: number;
}

export interface RegisterRateLimiter {
  check(peerId: Uint8Array, topicId: Uint8Array, now: number): RateCheckResult;
  /** Evict keys idle (not checked) for >= idleTtlMs. Returns the number evicted. Driver-called on the gossip cadence. */
  sweep(now: number): number;
  /** Tracked key count (test/diagnostic introspection). */
  readonly size: number;
}

interface WindowState {
  accepts: number[];
  strikes: number;
  lastSeen: number; // `now` of the most recent check — LRU recency + idle-TTL key
}
```

`check()` flow (preserve the existing window/strike semantics verbatim — only add recency + cap):

- key absent → if `states.size >= maxKeys`, evict oldest (`states.keys().next().value`) until `< maxKeys`,
  then `set(key, { accepts:[now], strikes:0, lastSeen:now })`, return `{ ok:true }`.
- key present → `delete`+`set` the *same* state object to move it to the MRU end, set `lastSeen = now`, then
  run the existing aged-out-trim / `strikes` / accept-or-reject logic unchanged. (Reject path also refreshed
  recency — that already happened via the `delete`+`set` above.)

`sweep(now)`: iterate `states`, `delete` every key with `now - lastSeen >= idleTtlMs`, return the count.
(Deleting during `Map` iteration is safe.) Bounded by `maxKeys`, so the scan cost is capped.

Validate `maxKeys` (positive integer) and `idleTtlMs` (> 0) in the constructor, matching the existing
`ratePerWindow` / `windowMs` `RangeError` style.

### Engine wiring (per-coord limiters)

In `member-engine.ts`, the per-round `sweepStale(now)` (~L242, already called once per gossip round) gains:

```ts
this.deps.rateLimiter?.sweep(now);
this.deps.probeRateLimiter?.sweep(now);
```

so the per-coord register-path and probe-path limiters reclaim idle keys on the existing cadence. (The LRU
cap already bounds them even without this; the sweep adds proactive steady-state reclaim.)

### No new config surface

The new fields ride the existing `RegisterRateLimiterConfig`, which is already plumbed through
`CohortTopicAntiDosOptions.rateLimiter` to both the per-coord and (in the follow-on) the node-level limiter.
No new host option is needed — a caller/test tunes `maxKeys` / `idleTtlMs` through the same seam.

## Edge cases & interactions

- **Distinct-key flood is capped, not the active key.** A peer spraying `N >> maxKeys` distinct `topicId`s
  creates fresh MRU keys; the cap holds `size` at `maxKeys` by evicting the cold end. A *concurrently*
  sustained same-`(peer, topic)` attack stays MRU (refreshed on every reject) and must **not** be evicted —
  its `strikes` / back-off escalation must survive the flood. Test this interleaving explicitly.
- **Evicted/idle key re-appears = fresh key.** Re-allocates `{ strikes:0 }` and gets the full `ratePerWindow`
  allowance again — identical to the existing "forgives after a full window" behavior, just reclaimed earlier.
  Must not be penalized.
- **`sweep` must not evict a still-active key.** Only keys with `now - lastSeen >= idleTtlMs` go. A key checked
  within the TTL (even one that was *rejected* recently — a current attacker) is retained.
- **Recency refresh on reject is mandatory.** If `check`'s reject path skipped the `delete`+`set`, an attacker
  could be evicted mid-attack and reset. Assert the refresh covers both accept and reject.
- **Empty-accepts vs idle.** A key whose accepts have all aged out but was checked < `idleTtlMs` ago is kept
  (it may be a current low-rate attacker); only `lastSeen` age, not accept-emptiness, triggers `sweep`.
- **Default `idleTtlMs === windowMs`.** A key idle exactly one window is the documented-safe reset point — but
  confirm the inequality boundary (`>=`) does not evict a key still inside its window.
- **Validation boundaries.** `maxKeys = 0` / non-integer and `idleTtlMs <= 0` throw `RangeError` at construction.
- **Interface blast radius.** Only `createRegisterRateLimiter` produces this type; no hand-written stubs in the
  test tree implement `RegisterRateLimiter`. Adding `sweep`/`size` as required members is safe. The follow-on
  db-p2p ticket consumes them.

## TODO

- Add `lastSeen` to `WindowState`; set it on every `check`.
- Add `maxKeys` / `idleTtlMs` config + `DEFAULT_RATE_LIMITER_MAX_KEYS` / `DEFAULT_RATE_LIMITER_IDLE_TTL_MS`
  exports; validate both in the constructor.
- In `check()`: refresh LRU recency (`delete`+`set`) on every call; enforce the `maxKeys` cap inline on new-key
  insertion (evict oldest until under cap). Preserve the existing window/strike logic byte-for-byte otherwise.
- Add `sweep(now): number` and a `size` getter; widen the `RegisterRateLimiter` interface.
- Wire `rateLimiter?.sweep(now)` + `probeRateLimiter?.sweep(now)` into `member-engine.ts` `sweepStale`.
- Tests (`antidos.spec.ts`):
  - exposes the new `DEFAULT_RATE_LIMITER_MAX_KEYS` / `DEFAULT_RATE_LIMITER_IDLE_TTL_MS` defaults.
  - LRU cap: `maxKeys: 3`, check 4 distinct keys → `size === 3`, the least-recently-checked evicted.
  - `sweep`: two keys, advance `now` past `idleTtlMs` for one (refresh the other by checking it) → `sweep`
    drops only the idle one and returns `1`; refreshed key survives.
  - evicted/idle key re-appears → admitted fresh for the full `ratePerWindow` (strikes reset).
  - **sustained attacker survives a distinct-key flood:** hammer `(A, T1)` over-rate to build `strikes`,
    interleave enough distinct `(A, Tn)` checks to exceed `maxKeys`, re-check `(A, T1)` → still over-rate with
    *escalating* back-off (not reset to `backoffRetryMs(0)`).
  - construction `RangeError` for `maxKeys = 0` / non-integer and `idleTtlMs <= 0`.
- Tests (`member-engine.spec.ts`): inject a real `rateLimiter`, drive a register so it allocates a key, advance
  `now` past `idleTtlMs`, call the engine's per-round sweep (`sweepStale`), assert the limiter's `size` drops to 0.
- `yarn workspace @optimystic/db-core test` (stream with `2>&1 | tee`), `yarn workspace @optimystic/db-core build`.
