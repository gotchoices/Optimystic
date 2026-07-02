description: A brand-new group of nodes serving a topic used to deadlock — it could never accept its first user because idle nodes never told each other they were willing to help. Idle-but-willing nodes now announce willingness on a heartbeat, and a neighbour's announcement wakes a node that hadn't joined the group yet, so a fresh group bootstraps on its own. Reviewed and shipped.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/{types,validate,payloads}.ts (CohortGossipV1 treeTier)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (buildCohortGossip heartbeat branch)
  - packages/db-p2p/src/cohort-topic/host.ts (heartbeat clock; maybeInstantiateColdSibling)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (pumpMeshGossip)
  - packages/db-p2p/test/cohort-topic/{gossip-cadence,live-tier}.spec.ts
  - packages/db-core/test/cohort-topic/{wire,gossip}.spec.ts
  - docs/cohort-topic.md
----

# Complete: cold-start bootstrap — willingness heartbeat + cold-sibling engine instantiation

## What shipped

A freshly-brought-up group of nodes ("cohort") serving a topic used to deadlock: admitting the first
registration needs a *willingness quorum* read from gossiped sibling willingness, but an idle node built
no gossip frame at all, so nobody advertised willingness and the first register was declined forever. The
implementation broke the deadlock with two coordinated mechanisms, both scoped to tier 0:

- **Idle-but-willing willingness heartbeat** — an idle engine willing for at least one tier now emits a
  willingness/load-only gossip frame. It emits immediately on its first idle round, then throttles to
  `T_willingness_heartbeat` (default 30 s).
- **Cold-sibling engine instantiation** — a node receiving a `/cohort-gossip` frame for a coord it holds
  no engine for instantiates that engine (gated on the existing `verifyGossip` co-member check, live-signer
  mode, `treeTier === 0`), so the fresh bus joins the gossip and reciprocates.
- **Wire** — `CohortGossipV1` gained a signed `treeTier` field so a cold sibling adopts the right tier.

Convergence is ≈ 2 gossip rounds; the existing quorum gate is satisfied honestly (no admission-policy
relaxation). The smaller admission-only fallback the plan offered was not taken.

## Review findings

**Scope reviewed:** the full implement diff (commit `95f5ab0`) with fresh eyes — wire (`types`/`validate`/
`payloads`), the driver `heartbeat` branch, the host heartbeat clock + `maybeInstantiateColdSibling`, the
mesh harness `pumpMeshGossip`, all touched tests, and `docs/cohort-topic.md`. Builds (`tsc`) green for both
packages; tests green: db-core cohort-topic **334 passing** (86 wire/willingness/gossip incl. 2 new), db-p2p
cohort-topic **184 passing / 5 pending / 0 fail** (gossip-cadence + live-tier 23 passing incl. 1 new).

**Correctness — checked, no defects found.**
- *Heartbeat throttle logic* (`gossipRound`): first idle round emits (`lastGossipAt === undefined`),
  subsequent idle rounds suppressed until `now - lastGossipAt >= willingnessHeartbeatMs`; `lastGossipAt`
  updates only on a real emit, and a record-carrying round resets it so willingness ships every round while
  active. Verified the same-`now` two-wave convergence in test 5b relies precisely on the first-round-emits
  invariant. Sound.
- *Cold-sibling gate* — confirmed `verifyGossip(g, coord)` == the same auth the gossip bus already applies
  to *merge* a frame, so instantiation is no more permissive than merging. `cohortAround` prepends self
  unconditionally, so the effective gate is "our local FRET assembly around `coord` includes the sender."
  Traced the worst case (a fringe node whose assembly includes the sender but who is not truly in the
  sender's top-k): the fringe node instantiates a spurious *idle* engine, but its heartbeat is dropped by
  every genuine member's symmetric receive-side gate, so it never counts toward anyone's quorum — no
  incorrect admission, only a bounded wasted engine (already recorded as a tripwire). Acceptable.
- *Dummy `participantCoord` at tier 0* — the cold engine is built with `selfMemberBytes` as a filler
  `participantCoord`. Grepped every use: it is only read by the `parentCoord` closure (demotion, gated
  `treeTier > 0`) and `registerForwarderWithParent` (cold-start, `treeTier > 0`). A tier-0 root exercises
  neither, and a later real register for that coord reuses the existing engine (compute-if-absent) without
  needing the participantCoord. Invariant holds.
- *Registry / driver* — `registry.all()` is re-read each periodic tick, so a cold-instantiated engine is
  picked up and heartbeats on the next tick; `forCoord` is synchronous compute-if-absent (no double-create
  race); the bus subscribes synchronously in `createCoordEngine`, so the `maybeInstantiateColdSibling` →
  `deliver` ordering genuinely lets the fresh bus merge the waking frame.
- *Wire signing* — `treeTier` inserted into `cohortGossipSigningPayload` between `cohortEpoch` and
  `willingnessBits`; signer and verifier share the one function, so ordering is consistent and `treeTier`
  cannot be spoofed independent of the signature. `validate` requires a non-negative integer.

**Edge/error paths — one gap found and fixed inline (minor).**
- The `treeTier` validation branch (`must be a non-negative integer`) had no negative-case coverage —
  only the round-trip literal exercised the happy path. **Added** `wire.spec.ts` cases rejecting a negative
  and a non-integer `treeTier`.
- The heartbeat *throttle expiry* (steady-state re-broadcast) was untested — the implement tests covered
  only the first-round emit and the record-round reset (implementer's own push-point #4). **Added**
  `gossip-cadence.spec.ts` "host gossip round" case driving `gossipRound` across the throttle window
  (emit → suppressed → suppressed 1 ms shy → re-emit at the interval) with a real host + small
  `willingnessHeartbeatMs`.

**Docs — checked, accurate.** `docs/cohort-topic.md` §Willingness, §Cold-start instantiation (incl. the
Implementation + Cost notes) and the §Configuration `T_willingness_heartbeat` row all match the shipped
behaviour. No staleness found.

**Wire-compat — verified.** Grepped every `CohortGossipV1` literal across `src` and `test`; all carry
`treeTier` (build would fail otherwise). Adding it to the signed image is a breaking change for any
persisted/replayed old gossip, but nothing persists gossip today (interim in-flight only, unreleased layer)
— acceptable, matching the implementer's push-point #3.

**Major findings — none.** No new fix/plan/backlog tickets filed.

**Tripwires — verified present, not re-filed** (`NOTE:` comments + a docs §Cost bullet, all confirmed in
the diff):
- Gossip-instantiated engines are never reclaimed (`createCoordRegistry` has no eviction) — permanent
  per-co-member-coord cost, bounded by real FRET co-membership. `NOTE:` at `maybeInstantiateColdSibling`.
- The heartbeat re-broadcasts willingness for every idle willing cohort every `T_willingness_heartbeat`
  — throttle + willing-for-something gate mitigate. `NOTE:` at the `lastGossipAt` site.
- *New observation (not filed, no code site of its own):* `maybeInstantiateColdSibling` decodes+validates
  every inbound gossip frame in live mode before its early-outs, one decode on top of the per-bus decodes
  the deliver path already does. It is unavoidable (the coord is only known after decoding) and marginal
  against the pre-existing N-bus multi-decode; if gossip volume ever dominates CPU, decode once in the
  handler and thread the decoded frame into `deliver`.

**Tier-`d > 0` bootstrap — out of scope by design**, deferred to `cohort-topic-parent-child-link`
(instantiation gated to `treeTier === 0`; a tier-`d > 0` unknown-coord frame falls through to today's drop).
Confirmed the gate and the deferral note in the docs.

## No pre-existing failures

Every suite run green. The single `parent unreachable` line during the db-p2p run is an expected `log()`
from `host-antidos-coldstart.spec.ts`'s deliberate-unreachable fallback test, not a failure. No
`tickets/.pre-existing-error.md` written.
