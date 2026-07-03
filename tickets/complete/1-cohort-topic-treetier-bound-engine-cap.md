description: Reviewed and confirmed two anti-abuse fixes on the cohort registration path — rejecting an out-of-range tier number on the wire, and hard-capping how many per-location cohort engines one peer can force the node to create.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts        # treeTier() bound at RegisterV1
  - packages/db-core/src/cohort-topic/coldstart.ts            # ColdStartManager.hasForwarders()
  - packages/db-p2p/src/cohort-topic/host.ts                  # registry cap + typed error + refusal handling + NOTEs
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts  # subscriberCount getter (diagnostic)
  - packages/db-core/test/cohort-topic/wire.spec.ts           # RegisterV1 treeTier bound tests
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # registry-cap tests
  - docs/cohort-topic.md                                      # cold-sibling + anti-DoS bounded-memory notes
----

# Bound `RegisterV1.treeTier` + hard-cap the per-coord engine registry — complete

## Summary of the landed work

Two anti-abuse defects on the cohort register path, both fixed in the implement stage and confirmed here:

1. **Wire (`validate.ts`).** `validateRegisterV1` accepted any finite `treeTier` (e.g. `2.5`, `-1`, `300`),
   which then reached `addressing.coord()` where `coordD` throws a raw `RangeError` — an unclassified crash
   rather than a clean malformed-frame rejection. New `treeTier(value, what)` helper requires an integer in
   `0..DEFAULT_D_MAX_CAP` (60, imported from `../dmax.js`) and throws `CohortWireError`.

2. **Host (`host.ts`).** The `servedCoord → CoordEngine` registry was an uncapped `Map`, and `forCoord` runs
   on the register hot path **before** the per-coord anti-DoS gates. The served coord is a hash over
   attacker-chosen `(treeTier, participantCoord, topicId)`, so one peer spraying distinct coords forced
   unbounded engine allocation (each engine owns a store, gossip bus, rate limiter, replay guard, topic
   budget, promotion lifecycle, signer). `createCoordRegistry` is now hard-capped
   (`DEFAULT_COORD_ENGINES_MAX = 2048`, tunable via `coordEnginesMax`). Over-cap creation evicts the
   least-recently-used **idle** engine (no records and no cold-start forwarder) and `close()`s it; if every
   slot holds a live cohort it throws `CoordEngineRegistryFullError`, which the three creation sites
   (`dispatchRegister`, `dispatchChildLink` via `resolveParent`, `maybeInstantiateColdSibling`) catch and map
   to a clean refusal (`unwilling_cohort` with back-off / `rejected` / silent drop).

## Review findings

**Build + tests (must pass — they do).**
- `yarn workspace @optimystic/db-core build` → clean; `... test` → **1062 passing**.
- `yarn workspace @optimystic/db-p2p build` → clean (type-checks `test/` too); `... test` →
  **1102 passing, 36 pending, 0 failing**. Matches the implement handoff exactly.

**Correctness (checked, no defects found).**
- *Wire bound value.* `DEFAULT_D_MAX_CAP` (60) is the correct upper bound: `treeTier` is the walk start tier
  `d`, and `d_max ≤ d_max_cap`, so `d > 60` cannot be a real walk position. Boundary `0` and `60` accepted,
  `2.5 / -1 / 300` rejected — tests cover all five.
- *Typed-error catch coverage.* Verified all three creation sites catch `CoordEngineRegistryFullError` and
  never let it escape onto a stream/handler. `forCoord` stays total for the ~45 existing below-cap callers
  (they never throw), so no test/harness call site needed a null-check — the design decision to throw rather
  than return `CoordEngine | undefined` is sound.
- *Eviction tears down cleanly.* `evictOneIdle` `close()`s the victim, dropping its gossip subscription; the
  cap test asserts `subscriberCount === base + cap` (not `base + 5×cap`), proving no leaked subscriptions.
- *Idle-only eviction / verifier trust-lock.* An idle engine (`hasState() === false`) never published a
  membership cert, so eviction never strands a verifier trust-lock. The `onCertPublished` and `evictOneIdle`
  NOTEs correctly document that widening the policy to evict a cert-publishing engine would require a
  `verifier.forget(coord)` call. Correct as-is.

**Concurrency window — probed, found NOT reachable (no fix needed).** I checked whether a concurrent spray
could evict a just-created legit engine during the `await` inside `handleRegister` (which would write a
record into a closed, deregistered store — a silent lost registration). It cannot: in `member-engine.ts`
`handleRegister` runs synchronously from `forCoord`'s return through `coldStart.instantiate` (line 194) and
`store.put` (line 335); the first `await` (`promotion.onParticipantCountChange`, line 357) is *after* the
engine becomes non-idle. On a single-threaded event loop the engine transitions idle→live atomically within
one microtask of its creation, and `forCoord` `touch()`es it to most-recently-used at creation, so it is
also the last eviction candidate. The implementer flagged concurrency as a gap; it is in fact safe on the
register path.

**Tripwires recorded (knowledge, not tickets).**
- *LRU recency-pinning via unverified gossip.* Added a `NOTE:` at the `findByCoord` existence probe in
  `maybeInstantiateColdSibling` (`host.ts`): `findByCoord` bumps LRU recency, and it runs *before* the
  `verifyGossip` co-member gate, so an outsider replaying gossip frames that name a coord we already serve
  can pin that engine against idle-eviction. Marginal (cannot create engines — only pin existing ones,
  themselves bounded by real co-membership). Mitigation if it ever matters: a touch-free `has(coord)` lookup.
- *`evictOneIdle` O(n) scan.* Already recorded by the implementer (lives with the `DEFAULT_COORD_ENGINES_MAX`
  default). Fine at 2048; if the cap is raised by orders of magnitude, keep an explicit idle/LRU index.
- *Two `treeTier` validators.* `RegisterV1.treeTier` is now bounded `0..60`, while `CohortGossipV1.treeTier`
  is still validated non-negative-integer only (no upper bound). Not a defect: the gossip `treeTier` is gated
  to `0` in `maybeInstantiateColdSibling` and the coord is taken from the frame's raw `g.coord` bytes, so it
  never reaches `coordD` with an unbounded tier. Out of scope; noted for consistency awareness only.

**Deferred test coverage (from the handoff, judged acceptable — not filed as tickets).** The
`dispatchChildLink` `rejected` mapping and the `maybeInstantiateColdSibling` drop are covered by reading, not
by dedicated tests (the `dispatchRegister` refusal path and the registry-level cap/eviction/refusal are
directly tested). The mappings are one-line `catch` clauses over the same typed error the tested paths use;
the residual risk is low. If a future change touches these refusal branches, add explicit tests then.

## Disposition

Complete. One comment-only change applied in this review pass (the recency-pinning `NOTE:` in `host.ts`); no
behavioural change, no new tickets filed. No major or minor code defects surfaced.
