description: The anti-replay memory has no size limit and records every incoming frame before the rate limiter runs, so an attacker sending junk with fresh random ids grows that memory at full attack speed even though the frames are being rate-limited away.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts # ~line 86 — seen map has no maxKeys cap
  - packages/db-core/src/cohort-topic/member-engine.ts        # ~386-393 — runGuards records correlationId before rateLimiter.check
difficulty: medium
----

# Replay guard is uncapped and runs before rate limiting

## The problem

Two compounding issues in the per-coord anti-DoS path:

1. **No size cap.** The `CorrelationReplayGuard`'s `seen` map (`replay-guard.ts:86`) has no `maxKeys`
   bound — unlike the register rate limiter, which was capped by complete ticket
   `1-cohort-topic-rate-limiter-eviction`. The guard only prunes by age, so under sustained attack it
   grows at line rate.
2. **Wrong order.** In `runGuards` (`member-engine.ts:386-393`), the correlation id is recorded in the
   guard **before** `rateLimiter.check` runs. So every spam frame with a fresh CSPRNG correlation id
   inserts a `seen` entry even when it is then rate-limited away — the rate limiter never gets a chance to
   stop the memory growth.

Together, an attacker spraying fresh-correlation-id frames drives replay-guard memory up at full attack
speed regardless of the rate limit. (Note: `cohort-topic-rate-limiter-eviction` and
`cohort-topic-promote-gate-map-eviction` capped the *rate limiter* and the *promote gate*; neither
touched the per-coord replay guard.)

## Expected behavior

Bound the replay guard's memory and stop pre-rate-limit growth:

- Give the guard a hard LRU cap (mirroring the rate limiter's `maxKeys`), evicting the coldest entries,
  and/or
- Reorder `runGuards` so `rateLimiter.check` runs and admits the frame **before** the correlation id is
  recorded — a rate-limited-away frame should leave no `seen` entry.

Preserve the existing correctness property: a genuine replay of an already-seen id must still be caught
(reordering must not open a replay window for accepted frames).

## Repro sketch

- Spray N frames from one peer, each with a fresh random correlation id, at a rate above the limit.
- Observe the replay guard's `seen` size grow ~N despite the rate limiter rejecting most frames.
- With the fix, `seen` stays bounded (cap and/or record-after-admit).
