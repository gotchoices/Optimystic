description: A brand-new group of nodes that is supposed to serve a topic can never accept its first user, because each node waits to hear that its neighbours are willing to help before it will help — and while idle none of them ever says so. Make idle-but-willing nodes announce their willingness (and let a neighbour's announcement wake a node that hasn't joined the group yet) so a fresh group can get off the ground.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (buildCohortGossip idle-skip → add a willingness-only heartbeat path)
  - packages/db-p2p/src/cohort-topic/host.ts (CoordEngine.gossipRound cadence + idle heartbeat; the /cohort-gossip inbound handler + registry.forCoord for cold-sibling instantiation; carry treeTier in the built frame)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (deliver path — may surface the frame's coord for the instantiation gate)
  - packages/db-core/src/cohort-topic/wire/types.ts (CohortGossipV1 — add treeTier)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validate the new field)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (cohortGossipSigningPayload must cover treeTier)
  - packages/db-core/src/cohort-topic/willingness.ts (GossipWillingnessCheck quorum gate — only if the Option-B fallback is taken)
  - packages/db-core/src/cohort-topic/member-engine.ts (admitOrDecline / cold path — Option-B fallback only)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (setupTopic pre-seeds willingness + engines; the repro removes that seed)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts (bootstrap coverage)
  - docs/cohort-topic.md (§Willingness, §Cold-start instantiation, §Configuration — new heartbeat knob)
difficulty: hard
----

# Bootstrap a cold multi-node cohort: willingness heartbeat + cold-sibling engine instantiation

## The bug, restated precisely

A "cohort" here is the group of ~`k` FRET peers responsible for a topic coordinate. A brand-new
multi-node cohort — every member freshly brought up, holding no registrations (**idle**) — can never
admit its first registration, so it stays idle forever. This is a genuine cold-start deadlock, not a
race.

Reproduced by analysis and confirmed against the code and the test workarounds. The deadlock has
**three interlocking causes**, and the original ticket named only the first:

1. **Idle engines never advertise willingness.** `buildCohortGossip`
   (`cohort-gossip-driver.ts:121`) returns `undefined` when `topicSummaries`, `records`, and `evicted`
   are all empty, and `CoordEngine.gossipRound` (`host.ts:1514`) skips the broadcast on `undefined`.
   Willingness/load ride the same frame, so an idle member never tells anyone it is willing.

2. **Cold siblings never instantiate an engine at all** (the deeper cause the original ticket did not
   surface). A `CoordEngine` is created lazily by `registry.forCoord` (`host.ts:1107`) — only on a
   FRET-routed `RegisterV1` or when a bus that is **already subscribed** merges an inbound frame.
   FRET's `RouteAndMaybeAct(key = coord)` lands the first register on **one** member (the nearest to
   the coord). That member creates its engine; every sibling has **no** engine for the coord, is **not**
   subscribed to its gossip, and so silently drops any willingness/record frame the first member sends
   (`bus.isOurCoord` / the transport fans only to existing subscribers —
   `cohort-gossip-transport.ts:68`, `bus.ts:117`). The siblings never learn they are in this cohort.

3. **The admission quorum gate.** When the first register lands, `GossipWillingnessCheck.evaluate`
   (`willingness.ts:181`) counts *gossiped-willing siblings + self*. The view is empty (nobody gossiped),
   so `willingCount = 1 < quorum` → `unwilling_cohort`. The participant backs off in **time** (not
   space), retries at `d_max`, routes to the same member, and gets `unwilling_cohort` again. Forever.

Crucially, **all registers for one coord route to the same nearest member**, so siblings are never
independently woken by a routed register — cause (2) does not self-heal. The test harness
`setupTopic` (`cohort-topic-mesh-harness.ts:588`) steps around *both* (1) and (2) by hand: it calls
`forCoord` on every cohort member **and** seeds each member's view with every other member's signed
willingness. Its own comment says so ("an idle engine builds no willingness frame, so the first
registration needs a seed"). Production has neither seed.

### Why an admission-only fix is not enough

The tempting minimal fix ("let the routed member admit on its own live willingness when the view is
cold") makes *admission* succeed but leaves the cohort permanently one-member for that topic:
records gossiped by the serving member are dropped by siblings that have no engine (cause 2), so there
are no warm replicas and **no failover** — if the serving member dies the participant's backup
promotion finds an empty sibling and re-walks into a fresh cold-start. Since all registers route to the
one nearest member, siblings never materialise on their own. Replication and failover are core cohort
properties (`docs/cohort-topic.md` §Overview: "Cohorts … survive member churn … shard delivery
internally"), so the fix must materialise the siblings, i.e. it must address cause (2). Once siblings
materialise and exchange willingness, the existing quorum gate (cause 3) is satisfied honestly and needs
no change.

## Recommended design (primary): willingness heartbeat + cold-sibling instantiation

Two coordinated changes, scoped to the **single tier-0 cohort** the current milestone serves (parent
links / tier `d > 0` are out of scope — see the tier-`d` note below).

### A. Idle-but-willing willingness heartbeat

Let an idle engine still emit a **willingness/load-only** frame (no `records`, no `topicSummaries`,
no `evicted`) — but only while the node is actually willing for some tier
(`selfWillingnessBits(profile, barometer) !== 0`; a node willing for nothing has nothing to bootstrap
and should stay silent). This gives siblings something to hear.

Cadence, to keep the many-idle-cohort cost bounded (a node holds one engine per coord it has been
routed to *or* — after change B — per coord a co-member heartbeats to it, and engines are never
reclaimed today — see the tripwire):

- **Emit immediately on the first idle round after the engine is created,** so bootstrap converges
  fast (≈ 2 rounds: A heartbeats → siblings instantiate + reciprocate → A's view fills → A admits).
- **Then throttle** to a slow heartbeat interval `T_willingness_heartbeat` (a new
  `docs/cohort-topic.md` §Configuration knob). A record-carrying (non-idle) round already ships
  willingness every round and resets the heartbeat clock, so the throttle only governs genuinely-idle
  engines. Suggested default: a few gossip rounds, on the order of the ping interval (~30 s); pick the
  exact value against the cost/latency tradeoff and document it. An optional refinement — heartbeat
  faster while the local view is still cold (no sibling willingness yet), slower once converged — is
  a nice-to-have, not required.

Implementation seam: `buildCohortGossip` gains a "willingness-only" branch (emit a frame with empty
`topicSummaries`/no deltas when a caller-supplied `heartbeat` flag is set and willingness is non-zero);
`gossipRound` decides `heartbeat` from the idle-state + the per-engine heartbeat clock.

### B. Cold-sibling engine instantiation on a verified co-member frame

When the node receives a `/cohort-gossip` frame for a coord it has **no engine** for, and the frame is
from a genuine co-member, instantiate the engine so the node joins the cohort's gossip and its next
heartbeat reciprocates.

- Gate instantiation on the **existing** auth check `verifyGossip(g, coord)` (`host.ts:626`): the
  signature must verify for `g.fromMember` **and** `g.fromMember` must be in
  `cohortAround(coord).members`. This bounds the DoS surface — a peer can only make you instantiate an
  engine for a coord where FRET assembly agrees you are both members. Run this gate **before** the bus
  exists (today it runs *inside* the bus, which presupposes an engine). Do the instantiation in the
  host's `/cohort-gossip` handler (`host.ts:2116`) / the transport `deliver` path: decode → read
  `coord` → if `registry.findByCoord(coord)` is undefined, run the co-member gate → `registry.forCoord`
  → then deliver the frame (which the freshly-subscribed bus now merges).
- **Only auto-instantiate in live-signer mode** (`verifyGossip !== undefined`). In key-less/interim
  mode keep today's behaviour (drop gossip for an unknown coord) — instantiating without the co-member
  gate would be an unauthenticated engine-creation vector. The real tests (`gossip-cadence`,
  `live-tier`) all run with keys.

### The `treeTier` a gossip-instantiated engine adopts

`forCoord(coord, treeTier, participantCoord)` needs a `treeTier`, and it cannot be inverted from the
coord (a hash). Solution: **carry the originator's `treeTier` in `CohortGossipV1`** so a gossip-
instantiated sibling adopts the right tier. This is always well-defined: the only members that
originate a frame are those whose engine already knows its `treeTier` (from the register that created
it, or, transitively, from a co-member's frame), and all members of a given coord share one `treeTier`
by construction (the coord encodes the tier-shard). Wire touch points: add `treeTier: number` to
`CohortGossipV1` (`wire/types.ts:209`), validate it (`wire/validate.ts`), and **include it in
`cohortGossipSigningPayload`** (`wire/payloads.ts:84`) so it is signed and cannot be spoofed
independent of the signature.

`participantCoord` seeds only the tier-`d > 0` parent-coord derivation (`host.ts:1398`), which is never
exercised at tier 0 (demotion is gated on `treeTier > 0`). A tier-0 gossip-instantiated engine can pass
a dummy `participantCoord`. **Tier `d > 0` gossip-instantiation is deliberately out of scope** — it
needs the topic/`participantCoord` context a bare willingness heartbeat lacks, and overlaps with the
parent-child link work (`cohort-topic-parent-child-link`). Keep the instantiation gated to `treeTier === 0`
for this milestone; a tier-`d > 0` frame for an unknown coord falls through to today's drop.

### CohortGossipV1 (after change)

```
interface CohortGossipV1 {
  v: 1;
  fromMember: string;      // PeerId (base64url)
  coord: string;           // cohort coord (base64url) — inbound routing + instantiation key
  cohortEpoch: string;
  treeTier: number;        // NEW: the tier d this cohort sits at, so a cold sibling instantiates at the right tier
  willingnessBits: string; // 4 bits T0..T3, hex — carried even on an idle heartbeat frame
  loadBuckets: number[];
  windowSeconds: number;
  topicSummaries: CohortTopicSummary[]; // empty on a heartbeat frame
  records?: GossipRecordV1[];           // absent on a heartbeat frame
  evicted?: GossipRecordRefV1[];        // absent on a heartbeat frame
  timestamp: number;
  signature: string;       // peer-key signature over cohortGossipSigningPayload (now covering treeTier)
}
```

## Fallback (smaller, if the team wants to stage it): admission-policy bootstrap

If a minimal admission-only unblock is wanted first, relax the quorum gate at genuine cold start:
in `GossipWillingnessCheck.evaluate`, when the routed member is itself live-willing **and** the register
is a bootstrap growth point (`reg.bootstrap === true` — the same signal `shouldInstantiate` already
gates on) **and** the view carries no sibling willingness yet (cold), admit on self-willingness alone,
treating the FRET-assembled cohort membership as the evidence gossip has not yet supplied. This is the
original ticket's candidate direction #2. **Document its limit loudly if taken:** it fixes admission
only — replication/failover stay broken until siblings materialise, which (all registers routing to one
member) does not happen without change B. It overlaps with, but is distinct from,
`cohort-topic-admission-quorum-semantics` (which pins the quorum *number*; this is the *bootstrap path*).
Recommendation: prefer the primary design; the fallback is a stopgap, not the finish line.

## Tripwires / notes for the reviewer

- **Engines are never reclaimed** (`createCoordRegistry`, `host.ts:1104` — no eviction). Change B adds a
  permanent per-co-member-coord engine cost. Bounded by real FRET co-membership, but worth a
  `NOTE:` at the instantiation site and a bound (cap / LRU on idle gossip-instantiated engines, or a
  broader idle-engine reclaim). File as a tripwire in the review, not a blocker for this ticket.
- **Heartbeat cost for a node serving many empty cohorts** — the `T_willingness_heartbeat` throttle and
  the `selfWillingnessBits !== 0` gate are the mitigations; add a `NOTE:` at the heartbeat site
  ("re-broadcasts willingness for every idle willing cohort every heartbeat; if a node serves very many
  cohorts, batch or lengthen the interval").
- Adding `treeTier` to the signing payload is a **wire-compat break** for `CohortGossipV1` — acceptable
  pre-release (the whole cohort-topic layer is unreleased), but call it out.

## TODO

### Phase 1 — reproduce
- [ ] Add a failing test (in `gossip-cadence.spec.ts` or `live-tier.spec.ts`) that stands up an
  `N ≥ minSigs` keyed cohort **without** the `setupTopic` willingness/engine pre-seed, routes one
  `bootstrap: true` register to the nearest member, and asserts it currently gets `unwilling_cohort`.
  This is the repro; it must go green by the end.

### Phase 2 — wire: carry treeTier
- [ ] Add `treeTier: number` to `CohortGossipV1` (`wire/types.ts`); validate it (`wire/validate.ts`).
- [ ] Include `treeTier` in `cohortGossipSigningPayload` (`wire/payloads.ts`); update any encode/decode
  and every `CohortGossipV1` literal (tests + `signedGossip`/`signedWillingness` builders).

### Phase 3 — willingness heartbeat (change A)
- [ ] `buildCohortGossip`: add a willingness-only heartbeat branch (emit when a `heartbeat` flag is set
  and `selfWillingnessBits !== 0`, with empty summaries/no deltas); keep the idle-skip otherwise.
- [ ] `CoordEngine.gossipRound`: track a per-engine heartbeat clock; emit a heartbeat on the first idle
  round and thereafter every `T_willingness_heartbeat`; pass `treeTier` into the built frame.

### Phase 4 — cold-sibling instantiation (change B)
- [ ] In the `/cohort-gossip` handler / transport `deliver`: for a frame whose `coord` has no engine and
  whose `treeTier === 0`, run `verifyGossip(g, coord)`; on pass, `registry.forCoord(coord, g.treeTier,
  <dummy participantCoord>)` before delivering. Live-signer mode only.
- [ ] Add the `NOTE:` tripwires (engine reclaim bound; heartbeat cost).

### Phase 5 — docs + prove bootstrap
- [ ] `docs/cohort-topic.md`: document the heartbeat under §Willingness / §Cold-start instantiation and
  add `T_willingness_heartbeat` to §Configuration with its chosen default and the cost tradeoff.
- [ ] Make the Phase-1 repro pass; keep `setupTopic` (still valid as an explicit fast-path seed) but add
  at least one bootstrap test that does **not** pre-seed, asserting: register-once → `accepted`, and a
  sibling instantiates its engine + replicates the admitted record within a couple of rounds (real
  failover path, not the harness seed).

### Phase 6 — validate
- [ ] `yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-p2p build`
  (stream output with `2>&1 | tee`).
- [ ] Run the cohort-topic suites: `yarn workspace @optimystic/db-core test` and
  `yarn workspace @optimystic/db-p2p test` (at least `gossip-cadence`, `live-tier`, `willingness`,
  `wire`), streamed. Fix fallout from the wire change.
