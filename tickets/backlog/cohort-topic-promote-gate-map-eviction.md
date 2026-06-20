description: A node's defenses against junk "promote" network traffic keep a small record for every peer and topic they ever see and never forget them, so a node that runs for a long time slowly leaks memory — and an attacker can speed that up by sending notices for many made-up topics.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (PromoteGate.highWater, createPromoteGate, handleInboundNotice)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (SlidingWindowRateLimiter.states — same retain-forever property)
difficulty: medium
----

# Bound the promote-handler anti-abuse gate's memory (LRU/TTL eviction)

## Background

The `promote`-handler anti-abuse gate added in `cohort-topic-promote-handler-verify-amplification`
keeps two unbounded maps on a long-lived node:

- `PromoteGate.highWater` — one entry per `(topicId, tier)` ever applied.
- the gate's node-level `RegisterRateLimiter.states` — one entry per `(peer, topicId)` ever *checked*.

Neither evicts long-idle keys. This mirrors a property the register-path `RegisterRateLimiter` already
documents as "the host service's lifecycle concern, not this counter's" — but the promote gate makes it
sharper in one way:

**The rate-limit check runs *before* `findServing`** (deliberately — `findServing` is an O(engines)
linear scan, so rate-limiting first shields it; reordering would trade memory for per-frame CPU and is
*not* the fix). Because the check precedes the serving-engine resolution, a forged notice for a topic
this node does **not** serve still allocates a rate-limiter entry. `topicId` is attacker-chosen and free
to vary, so a single peer spraying notices with distinct random `topicId`s grows the map without bound —
and, unlike the register path, there is no `TopicBudget` cap in front of it on the promote path.

The growth is slow (one small entry per distinct key; each rate-limiter entry is trimmed to
`O(ratePerWindow)` timestamps), so this is a slow leak / low-rate memory-amplification vector, not an
immediate crash. It was explicitly deferred at implement time and flagged again in review.

## What's wanted

A bounded-memory strategy for the node-level gate maps (and, ideally, the shared register-path limiter,
since it has the same retain-forever shape):

- Evict keys whose sliding window has been empty for some idle period (TTL), and/or
- Cap total tracked keys with LRU eviction, and/or
- Periodically sweep idle keys on the existing gossip-cadence tick (the host already owns a timer).

Evicting an idle key must be **safe**: a re-appearing peer/topic simply re-allocates and starts fresh
(it has been quiet for a full window anyway, so its strike count would already have decayed). Evicting a
`highWater` entry is safe only if the engine's own per-topic `effectiveAt` high-water remains the source
of truth for idempotency (it is — the gate water is a strictly-weaker early-drop optimization), so an
evicted-then-replayed older notice would still be a no-op at the engine. Confirm that invariant holds
before evicting high-water entries.

## Acceptance

- The gate maps (and/or the shared limiter) have a bounded worst-case footprint under a flood of
  distinct `(peer, topic)` keys.
- A legitimate peer/topic that goes idle and later returns is not penalized by eviction.
- Eviction never lets a stale/replayed notice be (re-)applied (engine high-water still gates apply).
- Tests cover: idle-key eviction, cap/LRU eviction under many distinct keys, and the "evicted key
  re-appears and behaves like a fresh key" path.
