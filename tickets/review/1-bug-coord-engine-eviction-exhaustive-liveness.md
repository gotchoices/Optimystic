description: When a node ran low on memory it threw away the least-useful of its small in-memory working sets, but its test for "useless" only checked two of the four things such a working set can hold — so it silently discarded linked child groups and recorded group-resize decisions. Eviction now ranks working sets by what they actually hold, and also releases a trust record the discarded set may have published.
files:
  - packages/db-p2p/src/cohort-topic/host.ts                            # EngineStateKind/EngineLiveness (~339-350), CoordEngine.liveness (~370-378), EVICTION_RANK (~1397-1420), evictionRank + evictOne (~1450-1506), onEngineEvicted wiring (~840-843), engine liveness() impl (~2197-2213)
  - packages/db-core/src/cohort-topic/promotion.ts                      # PromotionLifecycle.hasAdoptedState (iface ~174-180, impl ~235-245)
  - packages/db-core/src/cohort-topic/membership/verifier.ts            # MembershipVerifier.forget (iface ~72-79, impl ~209-217)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts    # 5 new tests in "coord-engine registry cap" (~779-end)
  - packages/db-core/test/cohort-topic/promotion.spec.ts                # new "adopted-state census" describe (~248-end)
  - packages/db-core/test/cohort-topic/membership.spec.ts               # 4 new forget() tests in "stale trust-lock recovery" (~632-700)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts            # 5 fake PromotionLifecycle literals widened
  - docs/cohort-topic.md                                                # §Cold-start instantiation "Cost (tripwires)" (~813), anti-DoS wiring summary (~1009)
difficulty: medium
----

# Review: coord-engine eviction ranks by an exhaustive liveness census

## What this is

A node keeps one small in-memory working set — a `CoordEngine` — per cohort coordinate it serves. Because
the coordinate is a hash over attacker-chosen inputs and an engine is created *before* the per-coordinate
anti-DoS gates run, the registry is hard-capped (`coordEnginesMax`, default 2048) and evicts under
pressure. Two bugs in that eviction:

1. **The "is this engine worth keeping" test was not exhaustive.** It asked only "does it hold
   registration records?" and "does it hold a cold-start forwarder?" An engine holding *only* linked child
   cohorts, or *only* adopted promotion/demotion state, answered no to both and was evicted as a
   throwaway — silently zeroing its `childCohortCount` and forgetting that its topic was promoted.
2. **The eviction path's stated safety claim was false.** It said an evicted engine had never published a
   membership certificate, so there was no verifier trust-lock to release. On a keyed node the
   gossip-cadence driver calls `pumpMembership` for *every* engine, record-less ones included — so
   eviction could strand a trust-lock and leave the node distrusting that coordinate's later messages.

## What landed

**Source (landed in commit `a471746d` by this ticket's prior run — re-review it, it was never reviewed):**

- `EngineStateKind = "records" | "forwarders" | "children" | "promotion"` — the exhaustive set of state
  classes eviction destroys — with `EngineLiveness = Readonly<Record<EngineStateKind, boolean>>`.
- `CoordEngine.liveness()`: one census, computed in one place. `hasState()` / `hasForwarders()` stay on the
  interface but now derive from it, so the two views cannot drift.
- `EVICTION_RANK: Record<EngineStateKind, "pinned" | number>` = `{ records: "pinned", forwarders: "pinned",
  children: 1, promotion: 1 }`. `evictOne()` picks the `(rank, recency)`-lexicographically-least candidate:
  rank first, LRU only to break ties within a rank.
- `CoordEngineContext.onEngineEvicted?`, fired for **every** victim, wired at the host to
  `verifier.forget(bytesToB64url(coord))` — unconditional, no "did this engine publish" tracking.
- `PromotionLifecycle.hasAdoptedState()` (db-core) and `MembershipVerifier.forget(cohortCoord)` (db-core).

**Tests and docs (this run):** 15 new tests, two rewritten doc passages, one tripwire note, one compile fix
the prior run missed (see *Known gaps*).

## The design decision most worth a reviewer's attention

**`children` and `promotion` are ranked (1), not pinned.** This is deliberate and is the load-bearing
choice in the whole change. A child link is peer-supplied input — in key-less-permissive mode the host
records one with **no signature check** — so pinning on it would let any single peer make all
`coordEnginesMax` slots un-evictable and turn every subsequent legitimate coordinate into a
`CoordEngineRegistryFullError`. That reopens the exact spray vector the cap exists to close. Ranking keeps
the hard guarantee (some engine is always evictable while any unpinned one exists) while making the
realistic loss the *last* to go. `host.ts:~1397` carries the rationale; a test pins the behaviour.

If a reviewer disagrees, the counter-argument to weigh is that a rank-1 engine can still be evicted under a
large enough spray, so this reduces how often state is lost without making it impossible — which is exactly
what `tickets/implement/2-bug-promotion-state-survives-engine-eviction.md` (prereq'd on this ticket) exists
to fix durably for the promotion arm. That ticket is **not** in scope here.

## Use cases to validate

**Rank ordering.** Fill the cap with cold engines; give the *oldest* (the pure-LRU victim) a linked child
via `recordChild`, or adopted promotion state via `applyPromotionNotice`; then spray many new coordinates.
The state-holder must survive while every childless/cold original is reclaimed, and its `childCohortCount`
/ `isPromoted` must still be right. Note the freshly-sprayed engines are themselves rank-0, so once the
originals are consumed the spray eats its own tail — the state-holder still survives.

**Availability under a child-link spray.** Fill every slot with an engine holding one recorded child (all
rank 1), then request one more coordinate. It must be admitted — no `CoordEngineRegistryFullError` — and
the registry must still hold exactly `coordEnginesMax` engines.

**Trust-lock release.** `host.service.verifier()` returns the same verifier instance the host wires, so
shadowing `forget` on it observes the host's own calls. Evicting a coordinate must call
`forget(bytesToB64url(coord))` exactly once, for the evicted coordinate.

**`forget` semantics (db-core).** It drops the cached certificate (the trust lock) and the stale-gap strike
count, but deliberately **keeps** `lastFetchAt` — that is anti-amplification state, so a forget must not
reset a flood-exposed coordinate's refetch budget. All four properties have a test.

**`hasAdoptedState` boundary.** True for a `promoted` flag or a `lastEffectiveAt` high-water; false for
growth samples / `lowLoadSince` alone, which rebuild from the store on the next `onParticipantCountChange`.
Still true after a demotion — the high-water outlives the flag by design, and discarding it would let a
replayed older promotion re-promote a cohort that has since demoted.

**Exhaustiveness.** `Object.keys(EVICTION_RANK).sort()` must deep-equal `Object.keys(engine.liveness())
.sort()`. TypeScript's `Record<EngineStateKind, …>` pins the *table*, but nothing type-checks that the
engine's `liveness()` object literal reports every kind — this guard catches a fifth field added to the
census but not the table, and a dropped one.

## Validation actually run

- `yarn workspace @optimystic/db-core build` — clean (after the fix below).
- Root `yarn build` — clean. Root `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-core test` — **1469 passing**.
- `yarn workspace @optimystic/db-p2p test` — **2482 passing, 49 pending** (both counts pre-existing; no
  test was skipped or loosened by this work).
- The four pre-existing `coord-engine registry cap` tests pass **unchanged**.
- **Non-vacuity check.** Temporarily set `children`/`promotion` to rank `0` in `EVICTION_RANK` and re-ran
  the suite: both new rank tests failed with `expected undefined to not equal undefined` (the state-holder
  was evicted). Restored and re-confirmed green — `git diff` on `host.ts` shows only the intended change.

## Known gaps — read these before trusting the above

- **The prior run left db-core not building.** Five fake `PromotionLifecycle` literals in
  `packages/db-core/test/cohort-topic/member-engine.spec.ts` were missing `hasAdoptedState`, so
  `yarn workspace @optimystic/db-core build` failed at HEAD. Fixed here (one added line per literal). Worth
  a glance that nothing else was missed by that same widening — I found these five via the build, not a
  search, so the build is the authority.
- **The trust-lock test asserts the wiring, not the end-to-end scenario.** It shadows `forget` and checks
  the host calls it with the right key. It does **not** drive a keyed node through publish → evict →
  re-verify. The end-to-end consequence (a released lock lets a later-epoch message verify) is covered
  separately as a db-core unit test on `forget` itself. A reviewer wanting a true end-to-end test would
  need a keyed multi-node harness — `live-tier.spec.ts` is the closest existing one.
- **The child-link-spray availability test also passes against the old code** (where every engine was
  idle-evictable). It is a *regression guard* against someone later "hardening" this by pinning children,
  not a proof of the fix. The two rank tests are the ones that fail without the fix.
- **No test exercises rank 1 vs rank 1.** Both ranked classes share rank 1, so nothing distinguishes a
  child-holder from a promotion-holder; ties fall through to LRU. Correct today, untested as a contract.
- **Eviction under real memory pressure is untested.** Every test drives `registry.forCoord` directly with
  a tiny `coordEnginesMax`. Nothing exercises the default 2048-engine path or a real spray over the wire.
- **`liveness()` is computed fresh per call, with no memoisation.** `evictOne` calls it once per resident
  engine per eviction — so a single eviction over a full 2048-engine registry runs 2048 censuses, each
  touching `store.listAll()`, the cold-start map, the child registry and the promotion lifecycle. I did not
  measure this. It replaces a scan that was already O(engines) per eviction, but the per-engine constant is
  larger now.

## Tripwire parked

`hasState()` / `hasForwarders()` now run the **full** census (allocating a record and touching the child
registry and promotion lifecycle) where `hasState()` used to be a bare `store.listAll()` check. Free today:
nothing in `src/` calls either accessor — the registry ranks via `liveness()` directly, and the only
callers are specs. Parked as a `NOTE:` at the derivation site
(`packages/db-p2p/src/cohort-topic/host.ts`, the `hasState`/`hasForwarders` entries in the engine's return
object) saying to give a hot caller a direct single-field read rather than routing it through the census.
