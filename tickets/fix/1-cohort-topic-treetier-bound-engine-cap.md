description: A malformed registration can crash the remote handler, and — worse — a single peer can force the node to create and cache an unlimited number of per-location engines (each with its own memory) before any anti-abuse check runs.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts        # ~line 192 — treeTier validated only as finite number
  - packages/db-p2p/src/cohort-topic/host.ts                  # ~900-901 — addressing.coord(); registry.forCoord() unbounded
difficulty: medium
----

# `treeTier` validated only as "finite number" → remote crash + unbounded attacker-keyed engine creation

## The problem

`validateRegisterV1` accepts `treeTier` as any finite number (`wire/validate.ts:192`
`reqFiniteNumber`), with no integer/range check — unlike the sibling `RegisterV1.tier` which is clamped
to 0..3. Two consequences:

1. **Remote crash.** A fractional, negative, or `> 255` `treeTier` makes `addressing.coord()` throw a
   `RangeError` inside the register dispatch (`host.ts:900-901`), surfacing as an unclassified exception
   out of the handler.
2. **Unbounded, attacker-keyed engine creation (the serious one).** For each valid integer `treeTier`
   (0..255) crossed with an arbitrary `topicId`, `registry.forCoord(...)` creates and caches a *new*
   CoordEngine — its own store, rate limiter, replay guard, and topic budget — **before any anti-DoS
   gate runs**. Engine creation itself is therefore unbounded and keyed on attacker-chosen input: one
   peer can spray distinct `(treeTier, topicId)` pairs and force the node to allocate engines without
   limit.

## Expected behavior

- Validate `treeTier` as an integer in `0..DEFAULT_D_MAX_CAP` at the wire layer, so an out-of-range
  value is rejected as a malformed frame rather than reaching `addressing.coord()`.
- Bound the per-coord engine registry in the host (hard cap + LRU eviction of idle engines), so engine
  creation cannot be driven unbounded by attacker-chosen coords. Evicting an engine must tear down its
  associated resources cleanly.

## Repro sketch

- Send a `RegisterV1` with `treeTier: 2.5` (or `-1`, or `300`) → observe the unclassified throw.
- Send many registers with distinct valid `(treeTier, topicId)` pairs from one peer → observe the engine
  registry grow without bound before any rate-limit/budget check.

Note: the wire-formats complete ticket (`8-cohort-topic-wire-formats`) deliberately left `treeTier`
unbounded, deferring range/semantic checks to the behavior tickets — this is that deferred work, plus the
host-side registry cap the wire layer cannot provide.
