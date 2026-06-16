# Cohort Topic Layer

Shared substrate for FRET-backed topic trees in Optimystic. The cohort-topic layer provides the *mechanism* — deterministic per-tier addressing, peer-prefix sharded fan-out, willingness-gated admission, TTL-refreshed soft state — on top of which the reactivity push trees ([reactivity.md](reactivity.md)), the matchmaking and voting directories ([matchmaking.md](matchmaking.md)), and any future topic-shaped service is built. It assumes FRET ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) for ring coordinates, cohort assembly, `RouteAndMaybeAct`, and stabilization.

---

## Overview

Many parts of Optimystic need the same primitive: take a *topic*, find the peers responsible for it, attach to them, and either deliver work to them or have them deliver work back. The topic might be a collection's change stream, a matchmaking task, a voting quorum, or a generic broadcast channel. The cohort-topic layer expresses this as a **tiered tree of FRET cohorts** that grows root-outward as load increases and shrinks back as load drops.

The design has three properties that the applications above rely on:

1. **Anti-flood by construction.** Subscribers, providers, and seekers never speculatively probe outward; they only walk in one direction (toward the root) and only follow explicit redirects toward the leaves. There is no per-hop budget to tune.
2. **Cohorts as forwarder identity.** A cohort of `~k` peers, not an individual node, is the unit of topic responsibility. Cohorts survive member churn, threshold-sign their decisions, and shard delivery internally so no single member is amplified `k`-fold.
3. **Tiered priority.** Every topic operation declares a *tier* (essential, correctness-supporting, functional, luxury). Cohort members decide individually, based on device and configuration, which tiers they're willing to serve. A subscriber that can't find a willing serving member backs off in time rather than spreading load.

The layer holds *only soft state*. Authority over any underlying truth (transaction log, collection state, peer identity) remains with the subsystems that own it.

---

## Goals and non-goals

### Goals
- One implementation behind all topic-shaped subsystems (push notifications, directories, voting quorums, future broadcast).
- Scale from one participant to millions per topic without redesign or reconfiguration.
- Tolerate ~20% per-cohort churn and full-cohort loss with bounded recovery time.
- Resist registration-storm and flooding attacks structurally, not by tuning.
- Allow lightweight nodes (phones, IoT) to participate as topic *consumers* without being conscripted as forwarders.
- Provide per-tier admission so essential work (transaction commit) is never starved by luxury work (push notifications).

### Non-goals
- Authoritative storage of any kind. Cohorts hold caches and registrations; truth lives in the transaction log and chain.
- Ordering or delivery guarantees stronger than each application requires. Applications choose their own consistency story.
- Cross-topic semantics (joins, intersections, atomic multi-topic operations).

---

## Concepts

- **Topic** — the unit of attachment. A topic is identified by an opaque `topicId` (32 bytes). What `topicId` *means* is application-defined; the layer treats it as a label.
- **Topic anchor** — the value the layer hashes to derive tier coordinates. For most applications the anchor *is* `topicId` and is stable; for the reactivity push tree the anchor rotates with the tail block. Anchor rotation is opaque to this layer: when an application reports a new anchor, the layer treats it as a new topic.
- **Tier** `d` — the layer of the tree, with `d = 0` at the root. Tier `d` partitions participating peers into `F^d` groups by peer-ID prefix, where `F` is the fan-out (default 16).
- **Tier coordinate** `coord_d(P, topicId)` — the FRET ring coordinate at which the cohort responsible for tier `d` and peer-prefix sharing `P`'s first `d·log₂F` bits sits.
- **Cohort** — the FRET two-sided cohort of `k` peers (default 16) around a tier coordinate.
- **Forwarder cohort** — a cohort with active state for one or more topics. Cold cohorts hold nothing.
- **Promoted cohort** — a forwarder cohort that has hit its direct-participant cap for a topic and now redirects new arrivals to tier `d+1`.
- **Willingness** — a per-cohort-member, per-tier decision whether to personally serve a given registration. Device-specific.
- **Registration** — soft state held by 1–3 cohort members on behalf of one participant. Refreshed by TTL pings.
- **Capacity tier** — a system-wide priority class (T0–T3, see below) that frames admission decisions.
- **Topic traffic** — per-(topic, cohort) flow signal (arrival rate, query rate, current count) returned on registration replies. The layer measures it; applications interpret it.

---

## Tier addressing

A topic's tree is described entirely by the hash function below; there is no separate "tree state" object.

```
coord_0(_, topicId)         = H(0x00 ‖ topicId)
coord_d(P, topicId)         = H(d ‖ prefix(P, d·log₂F) ‖ topicId)   for d ≥ 1
```

Where:
- `H` is SHA-256 truncated to FRET's ring width `B` (256 bits today).
- `prefix(P, n)` is the `n` most-significant bits of peer ID `P`, left-padded if shorter.
- `F` is the configured fan-out (default 16; `log₂F = 4`).
- Tier `d` has exactly `F^d` distinct coordinates across the ring.

The hash mixes the tier number, the peer-ID prefix, and the topic ID so that:
- Different topics produce uncorrelated coordinate sets even at the same tier.
- Different tiers of the same topic produce uncorrelated coordinates (a tier-2 cohort is not a neighbor of its tier-1 parent on the ring).
- Sibling cohorts at tier `d` (peers sharing the first `d·log₂F` bits) deterministically converge on a single coord.

This is the only addressing scheme used by the layer. It replaces older bit-shift coord-ladder designs.

> **Implementation.** `packages/db-core/src/cohort-topic/addressing.ts` (`TierAddressing` /
> `HashTierAddressing`, default `F = 16`) implements the formula exactly: `coord_d` builds
> `d ‖ prefix(P, d·log₂F) ‖ topicId` and hashes it through the injected `IRingHash` (db-core's own
> SHA-256 truncated to the ring width — **not** a FRET import; the db-p2p binding makes the ring
> width match FRET's `RING_BITS` so routing keys line up). `prefix(P, n)` extracts the `n` MSBs
> MSB-first, left-padding when `P` is shorter than `n` bits. `coord(0, …)` dispatches to
> `coord_0 = H(0x00 ‖ topicId)`, which equals `coord_d` with the empty tier-0 prefix.
> **Validated:** the spec `addressing.spec.ts` ("coord_d collision rate") reproduces the
> simulator's zero-collision result — distinct `(tier, prefix-shard, topic)` triples never alias,
> and same-prefix peers converge — confirming no revision to the scheme.

> **Simulator validation.** Coordinate distribution and `d_max` are exercised by the design
> simulator (`packages/substrate-simulator`) against real FRET math — it wraps FRET's own
> `hashKey`, `xorDistance`, `assembleCohort`, and `estimateSizeAndConfidence`
> ([../../Fret/packages/fret/src/ring/hash.ts](../../Fret/packages/fret/src/ring/hash.ts),
> [.../ring/distance.ts](../../Fret/packages/fret/src/ring/distance.ts),
> [.../service/cohort.ts](../../Fret/packages/fret/src/service/cohort.ts),
> [.../estimate/size-estimator.ts](../../Fret/packages/fret/src/estimate/size-estimator.ts))
> rather than restating them here. The simulator also models `coord_d` directly
> (`topic-addressing.ts`: `coord_d = H(d ‖ prefix(P, d·log₂F) ‖ topicId)` over `hashKey`) and
> validates its two addressing invariants — peers sharing a `d·log₂F`-bit prefix converge on one
> tier-`d` coordinate, while coordinates stay uncorrelated across tiers and topics — by measuring
> the cross-(tier, prefix, topic) **`coord_d` collision rate**.
>
> **Measured (validated by simulator):** the collision test enumerates 64 distinct ring positions ×
> 4 topics × tiers 0–5 = **1,536 coordinates and observes 0 collisions** — consistent with the
> birthday bound (≈ `total² / 2²⁵⁷`, negligible at 256-bit width). The two invariants hold as
> written: distinct `(tier, prefix, topic)` triples never alias, and same-prefix peers do converge.
> **No revision to the `coord_d` scheme is warranted.** (Evidence: `topic-addressing.spec.ts`
> "coord_d collision rate".)

### Maximum useful depth

A participant computes an upper bound on tree depth from FRET's network-size estimate:

```
d_max = max(0, ⌊log_F(n_est)⌋ − 1)
```

At `d_max`, each tier-`d_max` cohort covers `F` peers on average — roughly one cohort's worth. Deeper would mean tier coordinates with fewer peers than a cohort, which FRET handles but provides no fan-out benefit. If `n_est` confidence falls below `confidence_min` (default 0.3), participants clamp to `d_max = ⌊d_max_cap / 2⌋` to avoid pathological deep probes.

`d_max` is recomputed lazily; participants don't need it precise. The simulator validates the
formula and the `confidence_min` clamp against FRET's reported `(n_est, confidence)` over
N ∈ {10, 100, 1k, 10k, 100k}; see the simulator validation note under §Tier addressing.

> **Implementation.** `packages/db-core/src/cohort-topic/dmax.ts` (`makeDMaxComputer`) reads the
> estimate lazily through the injected `ISizeEstimator` (db-p2p wraps FRET's
> `estimateSizeAndConfidence`) and applies the clamp to `⌊d_max_cap / 2⌋` when
> `confidence < confidence_min`. `⌊log_F(n_est)⌋` is computed with a power-of-`F` boundary
> correction so exact powers (e.g. `16³`) don't lose a tier to floating-point error; the result is
> capped at `d_max_cap`. Tier classes and Edge/Core profiles live in
> `packages/db-core/src/cohort-topic/tiers.ts`. Defaults (`F = 16`, `d_max_cap = 60`,
> `confidence_min = 0.3`) match §Configuration. Specs: `dmax.spec.ts`, `tiers.spec.ts`.

---

## Tree growth and lookup

### Growth

A topic's tree grows from the root outward, driven entirely by load:

1. **Cold topic.** Only the tier-0 cohort at `coord_0(_, topicId)` holds any state. Until that cohort hits its participant cap, every registration lands there.
2. **First promotion.** When tier-0's direct-participant count exceeds `cap_promote`, the cohort threshold-signs a state transition into **promoted** mode for that topic. From that point on, it responds to new registrations with `Promoted(targetTier = 1)`. Existing participants stay attached; their renewals continue to be accepted at tier 0.
3. **Tier-1 instantiation.** A participant receiving `Promoted(1)` computes its own `coord_1(self, topicId)` and registers there. The tier-1 cohort, on receiving its first registration for this topic, instantiates forwarder state, links upward to tier 0 (as the cohort responsible for one of `F` sibling slots), and accepts the participant.
4. **Continued promotion.** Each tier-1 cohort fills and promotes independently, spawning tier-2 cohorts in the corresponding prefix-shards. The tree's actual depth at any moment depends on how participant load distributes across peer-ID space — dense regions go deeper, sparse regions stay shallow.

The root's promotion state is the only thing that needs threshold signing for liveness; intermediate cohorts' promotion is purely local.

### Lookup

A participant walks *toward the root* from `d_max`:

```
d = d_max
loop:
  C = coord_d(self, topicId)
  reply = RouteAndMaybeAct(key = C, activity = RegisterV1{...})
  match reply:
    Accepted(primary, backups, cohortEpoch)
      → done
    NoState
      → d = d − 1
        if d < 0: fail (root unreachable, retry later)
        continue
    Promoted(targetTier)
      → d = targetTier
        continue
    UnwillingMember(otherMembers)
      → reissue to next member in otherMembers, same coord
    UnwillingCohort(retryAfter)
      → wait retryAfter; on retry, restart at d_max
```

Key points:

- The walk has a single direction at any moment. It never simultaneously probes multiple tiers; there is no fan-out of probe traffic.
- `NoState` means "I'm not serving this topic" — the participant moves one tier toward the root and tries again. Each step is a single RPC.
- `Promoted(targetTier)` is the only signal that moves the walk outward (away from the root). It is authoritative: the cohort returning it is part of the tree and reports the next live tier.
- `UnwillingMember` and `UnwillingCohort` are distinct: the former routes to a sibling within the same cohort, the latter is a temporal back-off with no spatial movement.
- The root case (`d = 0` returning `NoState`) means no cohort anywhere serves this topic. The participant treats this as an opportunity to bootstrap: it re-issues the registration at `d = 0` with a `bootstrap: true` flag, asking the root cohort to instantiate. Cold-start denial (root is unwilling) yields `UnwillingCohort` and the participant retries.

> **Implementation.** The participant-side walk is
> [`packages/db-core/src/cohort-topic/walk.ts`](../packages/db-core/src/cohort-topic/walk.ts)
> (`WalkEngine` / `createWalkEngine`). It drives the injected `ITopicRouter` port — **not** a direct
> FRET import — keying each probe at `coord_d(self, topicId)` (via `TierAddressing`) with
> `wantK = k`, `minSigs = k − x`, decoding the `RegisterReplyV1` and dispatching: `no_state` → step
> inward (`d − 1`), with the root case re-issuing once at tier 0 with `bootstrap: true`;
> `promoted(targetTier)` → the one outward move, recomputing `coord_targetTier` and registering there
> (or, with `followPromoted: false`, surfaced to the caller); `unwilling_member` → a direct
> `dialMember` retry of a named sibling at the **same** coord; `unwilling_cohort` → terminate with a
> `retry_later(afterMs)` so the caller backs off in time and a fresh `register` restarts at `d_max`
> (never re-hitting the declined coord). Building + signing each `RegisterV1` is delegated to an
> injected `RegisterMessageFactory` (participant identity/crypto live there). A `maxSteps` safety
> valve bounds pathological inward/outward oscillation in a malformed tree. Spec: `walk.spec.ts`
> (sparse-regime distinct-`coord_{d_max}` fan-out, `Promoted` outward recompute, `UnwillingCohort`
> restart-at-`d_max`, sibling-dial retry, bootstrap re-issue).

### Why this distributes naturally

For a topic with `N` active participants, the tree's steady-state depth is `⌈log_F(N / cap_promote)⌉`. Three regimes:

- **Sparse** (`N ≪ cap_promote`): only the root exists. All participants register at the root. Their initial probes at `d_max` miss and walk all the way down, but each one's `coord_{d_max}` is *different* (different peer-ID prefix), so the walks fan across the ring rather than colliding.
- **Hot** (`N ≫ cap_promote`): the tree has grown to deep tiers. A participant's first probe at `d_max` hits an existing tier coordinate matching its own prefix, and registration succeeds in one or two RPCs without ever touching the root.
- **Growing/shrinking**: brief transient where probes find recently-promoted cohorts and follow `Promoted` redirects outward. Bounded by tree depth.

The root cohort sees high traffic only in the sparse regime, where it has the capacity to serve it. Under hot load, traffic is sharded across `F^{d_max}` deep cohorts. Promotion is the mechanism that moves load from concentrated to sharded; no participant ever has to guess the right tier.

> **Simulator validation.** The design simulator (`packages/substrate-simulator`,
> `promotion-convergence.ts`) confirms the steady-state **depth law**
> `⌈log_F(N / cap_promote)⌉` across the N sweep `N ∈ {10, 100, 1k, 10k, 100k}` (`F = 16`,
> `cap_promote = 64`), driving a gossip-lagged growth model where promotion is decided on the
> gossip tick rather than eagerly, so the promotion-window **overshoot** past `cap_promote` is
> observable. It records, per N, the **convergence latency** (peak-load → depth-stabilization), the
> **peak overshoot** (bounded by one gossip-round of arrivals — the slope-based pre-promotion of
> §Promotion `T_promote_lookahead` removes it only in the small-increment regime, not under a storm;
> see §Promotion and demotion lifecycle), and the **oscillation count** (0 — depth locks
> monotonically; the `cap_promote`/
> `cap_demote` `4×` gap + `T_demote` thrash resistance is exercised in §Promotion and demotion
> lifecycle).
>
> **Measured (validated by simulator).** Across the scale sweep `N ∈ {100, 1k, 10k, 100k, 1M}` the
> observed steady-state depth equals the law exactly (1, 1, 2, 3, 4), **convergence latency is 0**
> (depth stabilizes within the load ramp), **oscillation count is 0** (monotone lock), and the
> **peak overshoot is `< arrivalsPerRound`** (0, 0, 36, 436, 4,936 under the `⌈N/200⌉` ramp). The
> full convergence/overshoot analysis — including when `T_promote_lookahead` does and does not remove
> overshoot — is in §Promotion and demotion lifecycle.

---

## Tier ladder

Every cohort-topic operation belongs to one of four system-wide tiers, in priority order:

| Tier | Examples | Decline policy |
|---|---|---|
| **T0 — essential** | Transaction commit participation, block production, threshold-sig contribution for committed blocks | Cohort members never decline T0 work for a topic they already serve; declining T0 means leaving the cohort. |
| **T1 — correctness-supporting** | Chain serving, replay-window storage for committed work, partition-heal participation, membership snapshots | Declined only when shedding cohort duties entirely. |
| **T2 — functional** | Matchmaking and voting directories, capability discovery, capacity gossip | Per-member decline allowed; caller backs off in time, not space. |
| **T3 — luxury** | Reactivity push forwarding, anticipatory warm-up, optional delta payloads | Declined freely; dropped first when shedding state. |

Tier is a property of the *operation*, not of the node. A node's profile is the set of tiers it advertises capacity for. Cohort admission for tier T requires a quorum of members willing to serve T; if quorum can't be reached, the cohort doesn't take on T duties for that topic at all and registrations get `UnwillingCohort`.

The Edge/Core distinction inherited from FRET is:

- **Edge** nodes (mobile, browser, IoT): T0 + T1 only. Edge nodes participate fully in transaction processing and chain serving but refuse forwarder roles for T2 and T3.
- **Core** nodes (servers, fixed infrastructure): T0 + T1 + T2 + T3. Subject to per-node configuration; an operator can restrict a core node to fewer tiers.

Cohort assembly under FRET is tier-blind — a cohort may contain a mix of Edge and Core members. The willingness check inside the cohort sorts out who actually serves what.

---

## Willingness

Within a cohort serving topic `T` at tier `d`, each member independently decides whether to accept a given registration as `primary`. The decision depends on:

- The member's advertised tier set (does it serve this op's tier at all?).
- The member's current per-tier load (queue depth, bandwidth, storage budget).
- Per-topic budget: how many topics this member is already primary for at this tier.
- Operator-supplied configuration overrides.

When a registration arrives at a cohort, FRET's `RouteAndMaybeAct` lands it on one member (the routing target). That member runs the willingness check:

- **Willing** → become `primary` for this registration; assign two backups by the cohort's deterministic hash (see [Primary and backup sharding](#primary-and-backup-sharding)); return `Accepted`.
- **Unwilling personally, but knows other members will serve** → return `UnwillingMember(candidateMembers)`. Caller retries the same coord at a named alternative member.
- **Unwilling, and gossip indicates no member of this cohort will serve** → return `UnwillingCohort(retryAfter)`. Caller backs off in time.

The cohort gossips a coarse "willingness vector" (one bit per tier per member, refreshed every gossip round) so any member can answer `UnwillingMember` vs `UnwillingCohort` without polling siblings. Stale gossip is acceptable; over-reporting unwillingness costs a temporal retry, not a flood.

> **Resolved (decided).** Willingness stays at **1 bit per tier** — no finer T3 gradations (e.g.
> subscriber-count buckets). The capacity barometer's 3-bit load bucket already supplies coarse
> load, and finer willingness gradations buy little against the gossip cost. The gossiped bit is
> `profile-serves-tier ∧ load-bucket < bucket_overload`; the per-tier primary-topic **budget** is a
> finer gate applied *live* at the routed member, not folded into the gossiped bit. The reactivity
> Edge/Core policy ticket may revisit if the simulator/e2e shows need. Implemented in
> `packages/db-core/src/cohort-topic/willingness.ts` (`selfWillingnessBits`, `createWillingnessCheck`).

> **Simulator validation.** The design simulator (`packages/substrate-simulator`, `backoff.ts` +
> `willingness.ts`) drives per-member willingness under churn-induced load and validates two
> behaviours this section relies on: (a) the **exponential `UnwillingCohort` back-off curve**
> minimizes repeated rejections per participant (`O(log(window/base))` rather than the
> `window/base` a fixed interval would suffer) while still admitting promptly once capacity frees,
> and gating under a burst caps accepted/sec at the willing-quorum capacity without a cascading
> load increase; and (b) the **~1-heartbeat willingness-gossip staleness** edge case — a member
> that just became unwilling while a sibling still gossips it as willing yields `UnwillingMember`
> to a seeker routed onto it, which then recovers via a sibling retry / back-off.
>
> **Settled back-off parameters (validated by simulator).** `backoff.ts` `DEFAULT_BACKOFF_CONFIG`:
> **`base = 1 s`, `factor = 2` (doubling), `cap = 60 s`** — `retryAfter(attempt) = min(base ·
> 2^attempt, 60 s)`. The capped doubling bounds the rejections a participant suffers across an
> overload window at `O(log(window/base))` (e.g. ≤ ~6 rejections to span a 60 s window vs. 60 at a
> fixed 1 s interval). Confirmed as written; no change for downstream tickets.

### Why the caller doesn't walk on `UnwillingCohort`

A participant receiving `UnwillingCohort` knows two things:

1. The cohort at this tier coordinate is real (FRET routed to it).
2. No member is willing to serve at this tier right now.

Walking to a deeper tier would land at a coord the tree hasn't instantiated yet — the participant would either get `NoState` (and walk back toward the root, defeating the purpose) or, worse, succeed in bootstrapping a parallel branch unrelated to the actual tree. Walking toward the root would land at cohorts that haven't promoted yet and are equally likely to be unwilling. Spatial movement gains nothing. Temporal back-off lets device profiles change, cohort membership rotate, or load shift before the next attempt.

---

## Capacity barometer

Cohort members exchange a coarse per-tier load signal in their normal heartbeat gossip:

```
LoadBarometer {
  tier:           T0 | T1 | T2 | T3
  bucket:         uint    // 0..7, log-bucketed utilization
}
```

Per-tier load buckets (3 bits) plus a willingness bit (1 bit) fit in 16 bits across all four tiers; cohort gossip cost is negligible.

The barometer feeds two decisions:

1. **Willingness vector refresh.** A member that observes its own per-tier utilization crossing a threshold flips its willingness bit for that tier. Sibling members see this within one gossip round.
2. **Promotion threshold.** A cohort's promotion decision uses its bucketed direct-participant count (per-topic) and the per-tier load barometer (per-cohort). If the cohort is hot at the tier it's serving, promotion fires earlier than the strict `cap_promote` would dictate, shedding new registrations to tier `d+1` faster.

The barometer is not aggregated across the tree. A parent cohort doesn't know its children's load and doesn't need to — children promote independently.

> **Implementation.** `packages/db-core/src/cohort-topic/load/barometer.ts` log-buckets utilization
> as `bucket = clamp(7 + ⌊log₂(load/capacity)⌋, 0, 7)`, so each bucket spans a doubling and bucket 7
> is at/over capacity. The willingness-flip and early-promote thresholds are the **same** bucket —
> `bucket_overload = 6` (utilization ≥ ½ capacity), matching §Configuration and the
> simulator-validated `DEFAULT_OVERLOAD_BUCKET`. Crossing it both flips the member's load-driven
> willingness bit off (`loadWilling` → false) and raises the `isOverloaded` early-promote signal the
> promotion ticket consumes.

---

## Topic traffic signal

A cohort tracks per-topic flow rates alongside the stock `directParticipants` count and returns them on registration replies. Applications use the signal to decide whether the current tier is dense enough to settle on or whether to continue walking.

```
TopicTrafficV1 {
  windowSeconds:       number   // observation window, default 60
  arrivalsPerMin:      number   // exact, combined fresh registrations + renewals over windowSeconds
  queriesPerMin:       number   // exact, application-level queries against this topic over windowSeconds
  directParticipants:  number   // stock count (same value that drives promotion)
  childCohortCount:    number   // tier-(d+1) cohorts known for this topic, 0 if not promoted
}
```

`arrivalsPerMin` deliberately combines fresh registrations and renewals into a single scalar: the seeker uses renewals as a proxy for active matchable supply, and the consumer-side formulas in [matchmaking.md §Hang-out vs. continue](matchmaking.md#hang-out-vs-continue) take the combined value. A separate split is not currently needed; if a future consumer wants fresh-only or renewal-only, the field can be split then.

Each member counts only the arrivals/queries that land on it (FRET routes each registration to one member; renewals go to the primary), so a member's own count is roughly `1/k` of the cohort's flow. The rate is therefore **cohort-wide aggregated**: the responder sums its own most-recent gossiped per-topic counts with the last-gossiped counts of its siblings (exact integers; `directParticipants` comes from the replicated store, not the sum). The reply uses this gossip-derived view — never a recompute from raw counters at reply time — and so lags by at most one gossip round.

Wire-format note: traffic fields are sent as **exact integers**, not log-bucketed like the load barometer in §Capacity barometer. Cohort gossip is intra-cohort and tiny, and the consumer-side formulas are numeric — bucketing would buy nothing and complicate matchmaking math. The load barometer is bucketed because it is a coarse priority signal; the traffic counts feed real arithmetic.

The signal is advisory — neither admission, routing, nor promotion depends on it.

Per-topic counters reset to zero on `cohortEpoch` change (see §Primary and backup sharding, [Membership rotation and primary handoff](#membership-rotation-and-primary-handoff)). The first gossip round after a rotation may therefore under-report traffic; consumers tolerate this — matchmaking's edge-case rule does not withdraw on a single zero reading without first issuing a query to confirm.

This layer does not interpret the signal. The reactivity application ignores it (subscribers always want the tail). The matchmaking application uses it for the seeker's hang-out decision; see [matchmaking.md §Hang-out vs. continue](matchmaking.md#hang-out-vs-continue). Future applications may use it however they like.

A participant that receives `NoState` at tier `d` gets no traffic signal from that cohort (it has none for this topic); the participant simply continues toward the root. A participant that receives `Promoted(d+1)` gets the outgoing cohort's traffic signal anyway, which lets it estimate whether the tier it's redirected to is likely to be hot.

> **Resolved (decided).** The traffic signal is returned **only** on `accepted` and `promoted`
> replies; it is absent on `no_state`, `unwilling_member`, and `unwilling_cohort` (matches the
> `RegisterReplyV1.topicTraffic` wire comment). Implemented as `attachTopicTraffic` in
> `packages/db-core/src/cohort-topic/traffic.ts`, with the windowed exact-integer counters,
> combined fresh+renewal arrivals, gossip-derived snapshot (lags ≤ one round, no reply-time
> recompute), and `cohortEpoch`-change reset alongside it. The snapshot **sums own + sibling**
> gossiped per-topic counts (cohort-wide flow, since arrivals shard ~`1/k` across members);
> `directParticipants` is read from the replicated store rather than summed, and `childCohortCount`
> takes the max across siblings (or a promotion-layer override).

---

## Registration mechanics

### Registration record

A cohort that accepts a registration holds, per participant:

```
RegistrationRecord {
  topicId:         bytes
  participantId:   PeerId
  tier:            uint
  primary:         PeerId             // cohort member assigned to deliver / serve
  backups:         PeerId[1..2]       // warm-failover cohort members
  attachedAt:      timestamp
  lastPing:        timestamp
  ttl:             duration           // default 90s
  appState:        opaque             // application-defined per-registration state
}
```

`appState` is the application's slot. Reactivity stores `lastDeliveredRev` here; matchmaking stores provider metadata; voting stores ballot intent. The cohort-topic layer never interprets `appState`.

The record is replicated across all `~k` cohort members via standard FRET cohort gossip. Only `primary` actually serves the participant; `backups` watch and take over on primary failure.

### TTL and renewal

The participant pings `primary` every `ttl / 3` (default 30s):

- Success → primary updates `lastPing`, gossips the touch to the cohort.
- Three consecutive failures → participant promotes `backups[0]` to primary by sending a re-attach RPC. This is a renew carrying a **signed `reattach` flag** (`reattach: true`, part of the signed body so a member can trust the attestation and a stray/MITM'd ping can never silently usurp a live primary). The backup accepts when it both holds the record in its local replica *and* is a computed backup for it under the current epoch: it re-stamps `primary` to itself, gossips the new assignment, and replies `ok`. A plain ping (no `reattach`) on a backup that holds the record is never a promotion — it replies `primary_moved`.
- All of `primary` and `backups` fail → participant re-runs the lookup from `d_max`.

> **Resolved.** Backup failover refreshes the participant's `cohortEpoch` hint **lazily** — on the *next* ping/renewal after failover (when a `primary_moved` reply carries the fresh epoch), not eagerly at failover time. Promoting `backups[0]` keeps the existing epoch hint; the new primary corrects it on the following round.
>
> **Resolved (crash failover ↔ deterministic assignment).** On a *crash* (no membership rotation, so `cohortEpoch` is unchanged) `assignSlots` still names the dead member as primary. To keep the participant from bouncing between the promoted backup and the corpse, the accepting backup records an **epoch-scoped failover override** (sibling to the rotation dual-serve exception) so its *subsequent plain pings* keep being served — `onRenew` serves when `self` is the computed primary **or** dual-serving **or** an override tagged with the current epoch exists. The re-stamp of `primary` drives gossip convergence and the next rotation's handoff (not the serve decision). The override is **cleared on `cohortEpoch` change** (so the next stabilization's deterministic assignment + handoff reasserts authority) **and when its record is evicted on TTL** (so a stale override can never outlive its registration and wrongly serve a later re-registration under the same epoch). If a re-attach instead returns `primary_moved` (a real rotation moved primary to a live member), the participant adopts that payload via `applyPrimaryMoved` rather than promoting the contacted backup — unless `newPrimary` is the just-failed primary, which it ignores (the bounce guard).

Cohort members evict records where `now − lastPing > ttl`. Eviction is gossiped so all members converge on the active participant set.

> **Implementation.** The local soft-state store, the deterministic `assignSlots`, the participant/cohort renewal sides, and the rotation handoff state machine live in `packages/db-core/src/cohort-topic/registration/` (peer ids are raw `Uint8Array`; the wire layer carries them as base64url). Cross-member replication of these records runs over cohort gossip (a later ticket); this layer owns the local store and the deterministic functions the gossip layer and TTL loop call.

### Cohort epoch

Each registration response includes a `cohortEpoch` — a stable identifier for the cohort membership snapshot under which the registration was made. Today this is the hash of the sorted cohort PeerId list at registration time. Applications use `cohortEpoch` to detect cohort membership drift; the layer uses it to invalidate cached `primary` assignments when membership has rotated by more than a configurable threshold (default: any change to the first `k − x = 14` members).

---

## Primary and backup sharding

Within a cohort of `~k` members, primary assignment per registration is deterministic:

```
order(cohortMembers) = sort(cohortMembers, by = PeerId ascending)
slot(participantId, cohortMembers) = H(participantId ‖ cohortEpoch) mod k
primary(participantId, cohortMembers)   = order(cohortMembers)[slot]
backups(participantId, cohortMembers)   = order(cohortMembers)[slot+1 .. slot+2 mod k]
```

This shards delivery load roughly evenly across the cohort: `k` members each carry approximately `(registrations / k) + O(√(registrations / k))` primary assignments under typical hash distribution.

### Membership rotation and primary handoff

When cohort membership changes (FRET stabilization, partition heal), the slot calculation may move a registration's primary. The cohort runs a deterministic handoff:

1. New cohort membership stabilizes; all members compute the new `cohortEpoch`.
2. Members exchange a "primary inventory" gossip listing the registrations they hold as primary.
3. For each registration, the new computed primary either already holds the record (no-op) or pulls it from the previous holder via gossip.
4. **Resolved (dual-serve until ack).** The previous primary continues to serve until the new primary acknowledges receipt of the pulled record; this dual-serve window prevents a delivery gap. The new primary sends the ack immediately after it stores the pulled record.
5. Participants discover the new primary on their next ping (which is forwarded by the old primary) or on the next inbound delivery (which arrives from the new primary). Subscriber-side `cohortHint` is refreshed from the cohort response on either path.

The handoff is purely cohort-local; FRET is unaware of which member is primary for what. The state machine (inventory → pull → dual-serve → ack) is implemented over an injected transport in `registration/handoff.ts`; on pull the new primary re-stamps the record's `primary`/`backups` to the new assignment so a subsequent rotation recognises it.

---

## Membership snapshots and signature verification

Cohort threshold signatures are useful only if participants can verify them. The layer requires a way for any participant to obtain the authoritative membership of any cohort at any point in time.

### Membership source

> **Resolved.** Membership is read from one of two sources, dispatched by tier; the verifier never
> writes either. **T0/T1 → transaction-log commit certificate; T2/T3 → FRET-published
> `MembershipCertV1`.** This is implemented as the coord→source dispatch in
> [`membership/source.ts`](../packages/db-core/src/cohort-topic/membership/source.ts)
> (`createMembershipSourceRouter`), which the verifier consults by the message's claimed tier.

Cohort memberships are anchored in the transaction log ([transactions.md](transactions.md)). Specifically:

- Each block records the cohort membership for every collection whose tail it advances. This is part of the existing commit certificate.
- The membership of *all* cohort-topic cohorts is not committed; only those that serve T0/T1 work (transaction commits, chain serving) appear in the log. The verifier **reads** this committed membership (it never writes the log).
- T2/T3 cohorts (matchmaking, push forwarding) derive their membership from current FRET state. Their threshold signatures are verifiable against FRET's signed membership advertisements (the `MembershipCertV1` that FRET cohorts publish after stabilization).

### Membership fetch

A participant verifies a notification or threshold-signed message as follows:

1. Extract the signer set from the message (every threshold-signed message carries the `signers: PeerId[]` list).
2. Compute the cohort coord the signers should belong to (from the message's claimed tier/topic/coord).
3. Look up the most recent `MembershipCertV1` for that coord, cached locally or fetched from any cohort member.
4. Verify (a) the certificate is current, signed, and consistent with FRET stabilization, and (b) the signers in the message are a `≥ minSigs` subset of the certificate's members.

`MembershipCertV1` is refreshed by the cohort every `T_membership_refresh` (default 5 minutes) and on any stabilization event that changes the first `k − x` members. Participants cache the latest one they've seen per coord; verification against a slightly stale cert is acceptable as long as the cert's signers overlap with the current cohort by quorum.

> **Implementation.** Cohort-side publication (at stabilization, on a first-`k − x` change, and on
> the refresh tick) is
> [`membership/publisher.ts`](../packages/db-core/src/cohort-topic/membership/publisher.ts);
> participant-side verification is
> [`membership/verifier.ts`](../packages/db-core/src/cohort-topic/membership/verifier.ts). The
> verifier checks the message's `signers` are a distinct `≥ minSigs` subset of the cert's `members`
> and the signature verifies (the `k − x` threshold logic of
> [`sig/threshold.ts`](../packages/db-core/src/cohort-topic/sig/threshold.ts)). On failure against a
> cached/stale cert it re-fetches the cert from any cohort member **exactly once** and retries; still
> failing → the message is **untrusted**. A freshly fetched cert is itself accepted only if its own
> threshold signature is a self-consistent quorum of its members (full chain-to-genesis validation is
> §Bootstrapping trust, below, and out of scope of the per-message check). The threshold-signature
> primitive is reused from FRET's `minSigs = k − x` cohort-signature assembly via an injected port
> (db-core never imports FRET).

### Bootstrapping trust

A participant joining the network gets its initial trust roots (the cohorts responsible for genesis-block-related topics) from any peer it dials, validated against the genesis block hash known out-of-band. From there, membership certificates form a chain of attestations.

---

## Promotion and demotion lifecycle

### Promotion (cohort grows)

A cohort promotes for topic `T` when, for a quorum of members:

- `directParticipants(T) ≥ cap_promote`, OR
- `loadBarometer[tier(T)].bucket ≥ bucket_overload` AND `directParticipants(T) ≥ cap_promote_fast`

The cohort threshold-signs a `PromotionNoticeV1` and stores it as part of its forwarder state for `T`. Future registrations get `Promoted(d+1)` responses derived from the notice; existing participants are unaffected.

A cohort may also pre-promote on observing rapid growth: if the slope of `directParticipants(T)` over a gossip window predicts crossing `cap_promote` within `T_promote_lookahead` (default 30s), promotion fires now. This avoids the gossip-lag race where a cohort over-shoots its cap before promotion can land.

> **Implementation.** The promotion/demotion state machine is
> [`packages/db-core/src/cohort-topic/promotion.ts`](../packages/db-core/src/cohort-topic/promotion.ts)
> (`PromotionLifecycle` / `createPromotionLifecycle`), keyed by `topicId` across every topic a cohort
> serves. `onParticipantCountChange` (called eagerly per arrival/eviction) refreshes the growth + low-load
> clocks and fires the cap / hot-fast-path (`cap_promote_fast` at `bucket ≥ bucket_overload`) / slope
> triggers; `maybeDemote` (called on the gossip tick) enforces the `cap_demote` floor held for
> `T_demote`, the no-live-children requirement, the `T_promote_sticky` floor, and the root-never-demotes
> rule. Both transitions threshold-sign their notice via the gossip ticket's `CohortSigner`
> (`sig/threshold.ts` + `sig/payloads.ts`) over the injected `ICohortThresholdCrypto` port, so the
> methods are `async` and **return** the signed `PromotionNoticeV1` / `DemotionNoticeV1` (a documented
> refinement of the doc's `void`-returning sketch, since signing is asynchronous). The op-tier the load
> barometer is indexed by is supplied through an injected `loadBucket(topicId)` resolver, keeping the
> module tier-agnostic and FRET-free. Defaults match §Configuration. Spec: `promotion.spec.ts`
> (cap/fast/slope triggers, no-flap within `T_promote_sticky`, demotion gated on children + `T_demote`,
> root never demotes).
>
> **Broadcast + remote apply.** `promote()` / `demote()` set the cohort's per-topic state only on the
> member that *originates* a notice. A member that **learns** of a transition (via the `promote` protocol
> fan-out) adopts it through `applyPromotionNotice` / `applyDemotionNotice`, which set the same
> `PromotionState` **without re-signing** (the notice is already a verified quorum decision — db-core is
> crypto-free and trusts that the caller verified it). The apply path is idempotent and `effectiveAt`-
> ordered via a monotonic per-topic high-water mark that survives demotion, so re-applying a notice
> (including a member's own echoed broadcast) or a replayed older one is a no-op — a stale promotion can
> never un-demote a cohort. `isPromoted` reflects remotely-applied state, so a member that learned of a
> promotion answers `Promoted(d+1)` even though it did not originate it. On the wire (db-p2p host): a
> freshly-signed notice surfaced on an arrival is captured via the engine's `onNotice` hook and
> `sendOneWay`-broadcast over the `promote` protocol to the cohort around the served coord (and, for a
> demotion, additionally the parent coord); inbound, the `promote` handler decodes the notice, resolves
> the local coord engine serving its `(topic, tier)`, verifies the threshold signature against that
> cohort's `MembershipCertV1` via the participant `MembershipVerifier` (signers ⊆ cert, `≥ minSigs`,
> multisig valid), and applies it — untrusted or undeliverable notices are dropped. Specs:
> `promotion.spec.ts` (remote-apply ordering/idempotency), db-p2p `promote-notice.spec.ts`
> (verify + apply, forged/short-quorum + non-member rejection, no-engine drop, broadcast fan-out).

### Demotion (cohort shrinks)

A cohort demotes for topic `T` when, for a quorum of members:

- `directParticipants(T) ≤ cap_demote` (default = `cap_promote / 4`), AND
- The above has held for at least `T_demote` (default 5 minutes), AND
- The cohort has no live `childCohorts` for `T`.

Demotion threshold-signs a `DemotionNoticeV1` sent to the parent cohort (registers as "drop me from your tier-(d+1) children"). The cohort releases all forwarder state for `T`.

### Cold-start instantiation

A cold cohort instantiates as a forwarder for `T` when:

- It receives a `RegisterV1` for `T` it doesn't yet serve, AND
- The registering participant's `bootstrap: true` flag is set (root case) or the registration arrives as a follow-on to a parent's `Promoted` redirect, AND
- A quorum of cohort members is willing to serve `T` at the registration's tier.

The newly-instantiated forwarder registers itself with its tier-(d−1) parent on first opportunity; until that registration is acked, the cohort accepts participants but holds notifications/queries that would require parent involvement.

> **Resolved (decided): burst at a just-promoted cohort.** A cohort that has just promoted but whose
> tier-`(d+1)` is not yet fully instantiated, on a burst of new same-tier registrations, **bounces
> each with `Promoted(d+1)`** (cheap single-RPC) — it does **not** buffer the registrations and does
> **not** decline them with `UnwillingCohort`. The `T_promote_sticky` window keeps it in promoted mode
> through the burst (see §Anti-flood properties claim 5). This is the documented resolution of the
> prior open question.

> **Implementation.** Cold-start lives in
> [`packages/db-core/src/cohort-topic/coldstart.ts`](../packages/db-core/src/cohort-topic/coldstart.ts).
> `shouldInstantiate({ bootstrap, followOn, quorumWilling })` is the admission gate
> (`(bootstrap ∨ followOn) ∧ quorumWilling`) — a speculative `d_max` probe (neither flag) yields
> `false`, so the walk gets `NoState` instead of forking a parallel branch. The `followOn` signal is
> **not** on the wire (`RegisterV1` carries only `bootstrap`); the db-p2p cohort host determines it
> from routing context and passes it in (a documented integration seam). `createForwarder` / the
> `ColdStartManager` hold the link-up state machine: a deeper forwarder starts `awaiting_parent` —
> accepting participants but holding parent-involving ops — and flips to `serving` when its
> `ParentRegistrar.registerWithParent` acks; the root (tier 0) has no parent and serves immediately.
> `promotedRedirectReply` builds the `Promoted(d+1)` bounce above (attaching the outgoing cohort's
> traffic). Spec: `coldstart.spec.ts`.
>
> The db-p2p host supplies the parent-registration **transport**
> ([`host.ts`](../packages/db-p2p/src/cohort-topic/host.ts) `registerForwarderWithParent`): a
> cold-started tier-`d` forwarder routes a `RegisterV1`-style forwarder-link frame to its tier-`(d−1)`
> parent coord over `ITopicRouter.routeAndAct` (riding the parent's serving tier so the parent recomputes
> the parent coord); a resolved round-trip is the ack, a rejection leaves the forwarder `awaiting_parent`
> for a later retry without crashing the instantiating register. The parent-side child-cohort
> *recording* (`childCohortCount`, a dedicated signed child-link frame) is deferred
> (`cohort-topic-parent-child-link`); the single-tier-0 milestone has no parent, so this path is covered
> by `host-antidos-coldstart.spec.ts`, not the tier-0 e2e.

### Hysteresis

`cap_promote` and `cap_demote` are intentionally far apart (`4×`) to prevent oscillation under bursty load. `T_demote` adds temporal hysteresis. Together they ensure a topic doesn't thrash between tree depths.

> **Simulator validation.** The design simulator (`packages/substrate-simulator`,
> `topic-tree.ts`) models this lifecycle as scheduled virtual-clock events and validates its
> three load-bearing properties: (a) the steady-state **depth law** `⌈log_F(N/cap_promote)⌉`
> emerges from promotion alone (smoke check here; the full N-sweep is in
> `simulator-promotion-convergence`); (b) the **`4×` cap gap + `T_demote` hold absorb thrash** — a
> load barometer bouncing across `bucket_overload` does not flap promotion; and (c) a cohort with
> `childCohortCount > 0` **never demotes**, even below `cap_demote` past `T_demote`. The
> `cap_promote`/`cap_demote`/`T_demote`/`T_promote_sticky`/`bucket_overload` values are settled and
> recorded below (and confirmed unchanged in §Configuration).
>
> **Measured convergence + overshoot (validated by simulator).** The N-scale sweep
> (`sweep.ts` → `runConvergence`, N ∈ {100, 1k, 10k, 100k, 1M}) confirms the depth law exactly at
> every N: observed steady-state depth equals `⌈log_F(N/cap_promote)⌉` (= 1, 1, 2, 3, 4
> respectively) with **zero oscillations** (monotone lock — the `4×` cap gap + `T_demote` never let
> depth flap). **Convergence latency is 0 on the virtual clock**: depth stabilizes *within* the load
> ramp, so there is no post-peak settling lag — the tree reaches its final depth by the time the last
> arrival lands.
>
> **Promotion-window overshoot is real and scales with the per-round arrival increment**, not with
> N directly. Because the promotion decision is gossip-lagged by one round, a cohort accrues up to
> one round's worth of arrivals past `cap_promote` before promotion lands; the measured
> `peakOvershoot` (excess `directParticipants` past `cap_promote` at the busiest cohort) is **0 at
> N ≤ 1k, 36 at 10k, 436 at 100k, 4,936 at 1M** under the sweep's default ramp
> (`arrivalsPerRound = ⌈N/200⌉`), i.e. `peakOvershoot < arrivalsPerRound`. The overshoot magnitude
> is set by how far the *first* over-cap round lands past the cap —
> `⌈cap_promote / arrivalsPerRound⌉ · arrivalsPerRound − cap_promote` — so it is **0 whenever the
> per-round increment divides `cap_promote`** (`compareLookahead` at `arrivalsPerRound ∈ {16, 32, 64}`
> → 0) and otherwise stays `< arrivalsPerRound` (R = 10 → 6, R = 50 → 36, R = 128 → 64; identical
> across N, since it depends on the increment, not the population). **Pre-promotion lookahead
> (`T_promote_lookahead`) does not bound this overshoot in general** — it removes the lagged overshoot
> only in the small-increment regime the test pins (`compareLookahead` at `N = 1,000`,
> `arrivalsPerRound = 10`: overshoot **6 without lookahead → 0 with**). Once a single round's excess
> past the cap is larger — a moderate non-divisor (`arrivalsPerRound = 50` → 36, *unchanged* by
> lookahead) or a steep storm (`arrivalsPerRound = 5,000` at N = 1M → 4,936) — firing one round early
> cannot prevent the in-round pile-up, so the scale sweep's 0/0/36/436/4,936 above are the
> **lookahead-on** figures (the sweep runs with lookahead enabled and still shows the full `< R`
> overshoot at large N). At `arrivalsPerRound = 64` overshoot is 0 with or without lookahead simply
> because 64 divides `cap_promote` — lookahead removes nothing there. **Implication for implementers:** size the cohort's
> per-topic admission buffer for ~`cap_promote + (peak arrival rate × gossip round)` direct
> participants, not a hard `cap_promote`; the `Promoted(d+1)` redirect throttles *new* walks but
> in-flight arrivals within the lag window still land. (Evidence: `sweep.ts` scale samples,
> `promotion-convergence.ts` `compareLookahead`.)

---

## Anti-flood properties

A claim of "anti-flood by construction" is only meaningful if we can name the floods the design prevents:

1. **Cold-start storm at the root.** When a popular topic first appears, all participants probe `d_max` *first*, not the root. The root sees only the tail of the walk-toward-root sequence — for a sparse topic this is the full traffic, but the topic is by definition under-loaded; for a hot topic the tree has already grown and the root is bypassed.
2. **Re-registration storm after cohort failure.** When a cohort fails, attached participants stagger re-registration with random jitter over `T_rejoin_jitter` (default 30s, scaled with cohort failure rate observed from FRET). The jitter window is set so the inbound rate at the recovering or replacement cohort doesn't exceed `cap_promote / T_rejoin_jitter`.
3. **Speculative outward probe.** Eliminated by construction: participants only move outward in response to `Promoted` from a cohort that *is* in the tree. There is no scenario where a participant tries multiple deeper coords looking for a tree edge.
4. **Inward retry storm.** A participant receiving `UnwillingCohort` waits `retryAfter` (cohort-controlled) before any retry, and retries from `d_max`, not from the same coord. This decorrelates retry traffic across the ring.
5. **Promotion feedback loop.** A cohort that has just promoted continues to receive registrations from participants in flight. Those participants are bounced with `Promoted(d+1)` — cheap, single-RPC. The cohort's promotion state is sticky for at least `T_promote_sticky` (default 60s) to avoid flapping back to accepting under transient drops.

> **Implementation.** Claims 1, 3, 4 and 5 are emergent from the walk / promotion machinery
> (`walk.ts`, `promotion.ts`) and are not re-implemented; claim 2's jitter and the centralized
> invariant predicates live in
> [`packages/db-core/src/cohort-topic/antiflood/`](../packages/db-core/src/cohort-topic/antiflood).
> `RejoinJitter` (`jitter.ts`) staggers a re-registration wave so any `T_rejoin_jitter`-long window
> holds at most `cap_promote` arrivals — the single-participant form draws a uniform offset, the
> wave form spaces arrivals at `T_rejoin_jitter / cap_promote` for the hard bound, and the window
> widens with the observed FRET cohort-failure rate. `invariants.ts` exposes pure predicates over a
> recorded walk trace — `outwardMovesArePromoted` (claim 3), `inwardStepsFollowNoState` (walk
> discipline), `retriesRestartAtDMax` (claim 4), `stickyHolds` (claim 5) — so the unit and e2e
> suites assert the structural disciplines hold on the real engine, mirroring the simulator's
> `walk-metrics.ts` instrumentation. `T_rejoin_jitter = 30 s` is the simulator-confirmed
> §Configuration default. Specs: `antiflood.spec.ts`.

> **Simulator validation.** The design simulator (`packages/substrate-simulator`, `walk.ts` +
> `walk-metrics.ts`) models the `d_max`→root participant walk as scheduled per-hop RPC events and
> instruments all five claims directly; each is quantitatively validated:
> 1. **Cold-start storm avoidance** — in a sparse-regime burst (large `d_max`, `N ≪ cap_promote`)
>    the walks start at **distinct `coord_{d_max}`** (distinct-start count ≈ participant count) and
>    fan across the ring, all draining to the root and attaching there.
> 2. **Re-registration storm bound** — re-registrations spread over `T_rejoin_jitter`
>    (`rateLimitedStagger`/`rejoinStagger`) cap the recovering cohort's inbound at
>    `cap_promote / T_rejoin_jitter` (peak accepted/sec within the bound; ≤ `cap_promote` per
>    jitter window), where an unstaggered burst spikes the whole set into one second.
> 3. **No speculative outward probe** — every outward move in a walk's probe log is preceded by a
>    `Promoted` reply; no walk ever probes a deeper tier on a guess (`outwardMovesArePromoted`).
> 4. **Inward retry restarts at `d_max`** — every post-`UnwillingCohort` retry restarts at `d_max`,
>    never re-hitting the declined coord (`unwillingRetriesRestartAtDMax`).
> 5. **Promotion-flap prevention** — under a synchronized burst the bursting cohort accepts at most
>    `cap_promote` then promotes (sticky window holds it promoted), bouncing the overflow outward
>    with single-RPC `Promoted` redirects; no participant is starved.
>
> **Measured per-claim (validated by simulator):**
> 1. **Cold-start storm avoidance** — in the cold-start-storm scenario the walks start at
>    **distinct `coord_{d_max}` for every subscriber** (distinct-start count == subscriber count,
>    e.g. 3,000/3,000 and 10,000/10,000) and all drain to the root with **zero give-ups**, so no
>    speculative deeper probing and no root pre-saturation.
> 2. **Re-registration storm bound** — the tail-rotation burst (a re-registration wave *is* this
>    flood) spreads 2,000 subscribers over `T_rejoin_jitter = 30 s`; the new tail's root holds at
>    most `cap_promote_fast = 32` direct subscribers at peak and the whole wave lands by
>    `t = 29,995 ms ≤ T_drain = 60 s` — the inbound rate stays inside `cap_promote / T_rejoin_jitter`.
> 3. **No speculative outward probe** — confirmed by `outwardMovesArePromoted` over every walk trace:
>    each outward move is preceded by a `Promoted` reply.
> 4. **Inward retry restarts at `d_max`** — confirmed by `unwillingRetriesRestartAtDMax`: no
>    post-`UnwillingCohort` retry re-hits the declined coord.
> 5. **Promotion-flap prevention** — under the synchronized storm the cohort promotes (≥ 1 `Promoted`
>    event fires) and the sticky window holds it promoted while overflow is bounced outward by
>    single-RPC redirects.
>
> **Lookup cost is `O(log_F N)`, measured:** landing-walk **max hops == `d_max + 2`** wherever
> sampled (= 4 at N ≤ 10k where the full tree is grown; the cold-bootstrap worst case in the storm
> is 6 = `d_max + 2`). The `d_max_cap` sensitivity sweep confirms the cold worst case is exactly
> `d_max_cap + 2` (5, 6, 7, 8 hops for `d_max_cap` = 3, 4, 5, 6). The hot regime resolves without
> reaching the root. **One caveat, surfaced honestly:** the cold-start-storm claim
> "root accepts ≤ `cap_promote`" is the *cumulative tier-0 acceptance*, and it is bounded only when
> the arrival rate is moderate — at 3,000 subscribers / 5 s it stays ≤ 64, but at 10,000 / 5 s
> (≈ 2,000/s) cumulative tier-0 acceptance reaches **122 (~2× `cap_promote`)** before promotion +
> redirect throttle it. This is the same gossip-lag overshoot quantified under §Promotion and
> demotion lifecycle, not a separate effect. (Evidence: `scenarios.ts` cold-start-storm &
> tail-rotation reports, `walk-metrics.ts`, `sweep.ts` `d_max_cap` rows.)

> **Simulator scenarios.** The end-to-end claims above are also exercised by the simulator's
> scenario runner (`packages/substrate-simulator`, `scenarios.ts`) — the **cold-start storm**
> (root stays ≤ `cap_promote`, walks fan, promotion fires, lookup is `O(log N)`), the
> **voting-quorum hot-proposal** herd (tree absorbs the flash registration at depth
> `⌈log_F(N/cap_promote)⌉` with the root never overloaded), and **churn recovery** (20% member
> turnover fails over with no lost registrations and heals to convergence). Each emits a pass/fail
> `ClaimReport`; the N-scale + parameter-sensitivity sweep (`sweep.ts`) confirms the depth law and
> quantifies each parameter's effect. The measured numbers are recorded in the per-claim evidence
> above and the §Configuration "Defaults validated by simulator" callout.

---

## Anti-DoS

The layer relies on a small handful of structural defenses against malicious registration traffic:

- **Per-peer rate limits per cohort.** Cohort members track inbound `RegisterV1` rate per source `PeerId`. Default ceiling is 4 per minute per peer per topic at any single cohort. Exceeded → `UnwillingCohort(retryAfter)` with exponential `retryAfter`.
- **Per-cohort topic budget.** A cohort holds at most `topics_max` (default 2048) topics with forwarder state. When the budget is exhausted, new topic instantiations are refused with `UnwillingCohort`; existing topics continue. Eviction within the budget is LRU by participant count; topics with zero recent registrations are dropped first.
- **Signed registrations.** Every `RegisterV1` carries a `correlationId` (16 random bytes) and a signature from the participant's peer key over `(topicId, tier, correlationId, timestamp)`. Stale-timestamp or replayed-correlationId messages are dropped.
- **Bootstrap requires evidence.** A cold root accepting `bootstrap: true` requires the registration to carry one of: a small proof-of-work, a signature from a peer with a sufficient reputation score ([architecture.md](architecture.md) §Reputation), or a signed reference to a parent topic that does exist. Specifics depend on the application's tier — T0/T1 topics generally don't need PoW because they correspond to committed work; T2/T3 topics do.

The layer does not attempt to defend against unbounded Sybil attacks at the registration level; those are FRET's and the reputation subsystem's concern.

> **Implementation.** The four anti-DoS defenses live in
> [`packages/db-core/src/cohort-topic/antidos/`](../packages/db-core/src/cohort-topic/antidos) as
> transport-agnostic db-core logic: `RegisterRateLimiter` (sliding-window per `(peer, topic)`,
> exponential `retryAfter` via the §Willingness back-off curve), `TopicBudget` (LRU by participant
> count, zero-participant topics evicted first; populated topics never evicted for a new
> instantiation), `CorrelationReplayGuard` (drops stale/future timestamps and replayed
> `correlationId`s, remembering ids for one `maxAge` window), and `BootstrapEvidence` (tier policy
> over injected PoW / reputation / parent-reference verifiers — db-core never embeds a specific
> PoW or reputation scheme). `register_rate_per_peer = 4/min` and `topics_max = 2048` are the
> simulator-confirmed §Configuration defaults. Specs: `antidos.spec.ts`.
>
> The db-p2p host wires these into each live cohort
> ([`host.ts`](../packages/db-p2p/src/cohort-topic/host.ts)): the rate limiter, replay guard, and topic
> budget are **per-`CoordEngine`** (they key on `(peer, topic)` / per-cohort topic state, which is
> coord-scoped, so each served coord gets an independent set), while the `BootstrapEvidence` policy is
> **node-level** (a tier→verifier policy with no per-coord state) and shared. The guard is verified first
> on the inbound register so a forged/replayed/over-rate frame never pollutes downstream state. Because
> db-core embeds no PoW/reputation scheme, the host injects the verifiers via `antiDos` options: a
> supplied reputation view gates T0/T1 (a non-banned participant is the committed-work proxy) and the
> T2/T3 reputation option; otherwise the verifiers are **permissive-but-logged** (a one-time warning,
> never an undefined gate). The production PoW + committed-work-reference evidence schemes are deferred
> (`cohort-topic-bootstrap-evidence-scheme`). Host wiring specs: `host-antidos-coldstart.spec.ts`.

> **Open question — `F^d` fan-out under per-coord rate limits (not resolved here).** The per-peer
> rate limit bounds cost *per cohort*, but a malicious peer can hit every one of the `F^d`
> coordinates at tier `d` (e.g. `F = 16`, `d = 3` → 4,096 shards × 4/min ≈ **16K registrations/min
> network-wide** from a single peer). Whether that aggregate fan-out is acceptable is a
> **reputation-escalation** question, not a per-cohort one: the local rate limit is doing its job;
> the network-wide budget is set by how fast reputation must throttle a peer that sprays the whole
> ring. The simulator's adversarial DoS scenario (`packages/substrate-simulator`,
> `simulator-metrics-and-scenarios`) is the intended venue for measuring whether reputation
> escalation must be faster — deliberately left open pending those numbers.

---

## Failure modes

### Primary fails
Participant's pings time out. After three failures, participant promotes `backups[0]` via a re-attach RPC (a renew carrying the signed `reattach` flag). The backup already has the registration record from cohort gossip; promotion is instant — it re-stamps `primary` to itself, gossips the new assignment, and serves the participant's subsequent plain pings immediately via an **epoch-scoped failover override** (the unchanged `cohortEpoch` still names the dead node as the computed primary, so the override, not the deterministic calculation, is what keeps serving). The override is cleared at the next `cohortEpoch` change, when the deterministic calculation and the rotation handoff reassert authority and collapse any ambiguity (a revived dead primary receives no pings from the migrated participant and goes stale on TTL).

### Backup fails before becoming primary
Cohort gossip notices via missed heartbeat. The cohort re-derives `backups` for affected registrations using the deterministic hash function and the new membership. No participant-facing change.

### Cohort partition (minority loss)
FRET stabilization handles this: as long as `≥ k − x` (default 14) members remain reachable, the cohort continues. Registrations served by evicted minority members fail-over to backups; on `cohortEpoch` change at the participant's next ping, the participant refreshes its cohort hint.

### Cohort full failure
Rare. All attached participants detect via heartbeat and re-register. Re-registration walks toward the root (because their cached cohort coord no longer answers), eventually reaches a live cohort, which absorbs them — possibly triggering its own promotion if load spikes. Jitter (above) prevents the absorb step from collapsing.

### Network partition healing
FRET surfaces merge events. Each side's cohorts served their participants independently. On heal, FRET re-stabilizes memberships; cohort-topic responds by (a) refreshing `cohortEpoch` for affected registrations, (b) re-running primary assignment, (c) merging child-cohort lists for any cohort that diverged. Participants attached to surviving primaries see no disruption.

### Stale membership cache
A participant verifying a threshold-signed message against an out-of-date `MembershipCertV1` may fail verification even though the message is honest. Fallback: re-fetch the certificate from any cohort member and retry verification once. If still failing, treat the message as untrusted.

### Recovery time bounds

> **Simulator validation.** The design simulator (`packages/substrate-simulator`,
> `registration.ts` + `partition.ts`) models the two recovery paths above as virtual-clock events
> and validates their shape: a crashed primary is detected after three consecutive `ttl/3` pings
> and the participant promotes `backups[0]` via re-attach (bounded by one TTL); a deterministic
> membership rotation surfaces as `primary_moved` on the next ping (within one `ttl/3` window); and
> a partition heal reconstitutes the pre-split `cohortEpoch`, so both sides re-derive the *same*
> deterministic primary (`hash(participantId ‖ cohortEpoch) mod k`) and subscribers converge via
> `primary_moved` in ~one gossip round.
>
> **Measured (validated by simulator).** The churn-recovery scenario (16-member cohort, 64 attached
> participants, 20% member turnover) recorded **0 lost registrations**, **failover engaged
> (12 backup-promotion + re-lookup events)** within the renewal window, and a split→heal where
> **all 64 participants re-converged** on the same deterministic primary (`partition.ts`
> `checkConvergence`). Backup promotion is bounded by one TTL (three `ttl/3` ping failures = `ttl`);
> heal convergence is ~one gossip round. Confirmed.

---

## FRET integration

> **Package layering.** The transport-agnostic *ports* for this integration —
> `ITopicRouter` (wraps `RouteAndMaybeAct`), `ICohortGossipTransport`, `IMembershipSource`,
> `ISizeEstimator`, and `IRingHash` — are defined in **db-core**
> (`packages/db-core/src/cohort-topic/ports.ts`); their concrete FRET + libp2p
> implementations live in **db-p2p** (`packages/db-p2p/src/cohort-topic`). db-core supplies its
> own SHA-256 for `coord_d` via `IRingHash` and never imports FRET or libp2p.

### Protocol IDs

```
/optimystic/cohort-topic/1.0.0/register       — Register, renew, re-attach
/optimystic/cohort-topic/1.0.0/cohort-gossip  — Registration replication, willingness vectors, load barometers
/optimystic/cohort-topic/1.0.0/promote        — Threshold-signed promotion / demotion notices
/optimystic/cohort-topic/1.0.0/membership     — Membership certificates
/optimystic/cohort-topic/1.0.0/sign           — Per-member endorsement for k − x threshold-signature assembly
```

The `k − x` threshold signature carried by promotion / demotion notices and membership certificates is
a **collected Ed25519 multi-signature**: the assembling member signs the canonical payload locally and
dials each cohort member over `/sign` (`SignRequestV1` → `SignReplyV1`), concatenating the per-member
signatures (64 bytes each) into `thresholdSig` aligned with `signers`. A member endorses only the exact
bytes it is sent (no re-canonicalization) and only for a cohort + epoch it shares. Verification splits
the blob into `signers.length` chunks and checks each against its signer's embedded peer key; the
db-core `CohortSigner.verifyThreshold` layer adds the distinct-signer / `signers ⊆ members` / `≥ minSigs`
checks. The scheme needs no trusted setup, no new crypto dependency, and no aggregation round; it is
O(k) in size (≤ ~14 × 64 bytes at the default `minSigs`) and swappable behind the `ICohortThresholdCrypto`
port if a constant-size scheme is ever needed at larger `k`.

Application-specific protocols (notification delivery for reactivity, query for matchmaking, etc.) live under their own subsystem prefix and reuse only the cohort identity and primary/backup assignment from this layer.

### RouteAndMaybeAct usage

Registration uses FRET's `RouteAndMaybeAct` pipeline directly:

- `key` = `coord_d(self, topicId)`
- `activity` = serialized `RegisterV1`
- `wantK` = configured cohort size `k` (default 16)
- `minSigs` = threshold `k − x` (default 14) — used only for promotion/demotion responses
- Acceptance / redirect / willingness response runs inside the cohort's activity callback

Post-registration traffic (pings, application-specific RPCs) dials the cached `primary` directly and falls back to `RouteAndMaybeAct` only when the primary is unreachable.

### Cohort assembly

The layer uses FRET's two-sided cohort assembly without modification: alternating successor/predecessor walk, automatic adaptation when `n < k`, threshold signatures via `minSigs = k − x`. The cohort at any given `coord_d` is whichever set of `k` peers FRET names.

### Validation

The substrate is validated at two tiers. The participant ↔ cohort composition is unit-tested with a
mock transport in [`packages/db-p2p/test/cohort-topic/service.spec.ts`](../packages/db-p2p/test/cohort-topic/service.spec.ts)
(register / renew / withdraw / lookup / promote, plus per-coord scoping with a FRET fake that returns a
different set per coordinate). On top of that, an **end-to-end milestone** stands up an `N ≥ minSigs`
in-process multi-node cohort over **real Ed25519 keys** and a mock transport that routes the five
cohort-topic protocols plus FRET `routeAct`/`assembleCohort` between the node engines —
[`packages/db-p2p/test/cohort-topic/live-tier.spec.ts`](../packages/db-p2p/test/cohort-topic/live-tier.spec.ts).
It proves the prereq machinery composes: a real per-coord cohort (`assembleCohort(coord_0(topic))` =
all N nodes, computed identically everywhere), registration through the walk, a genuine collected `k − x`
threshold-signed `MembershipCertV1` a participant verifier accepts (with a forged single-signer cert
rejected), promotion end-to-end (the cohort threshold-signs + broadcasts a `PromotionNoticeV1`, a
non-originating node verify-applies it, and a later walk gets `Promoted(1)` and terminates within
`maxSteps`), gossip record replication + eviction convergence, and the sub-quorum negative case (no
single-signer fallback when a member is unreachable). The production `minSigs = 14` path is the same
code, just larger.

**Still deferred (parked in backlog, honestly out of scope for this milestone):** multi-tier
promoted-redirect *follow-on* instantiation (`cohort-topic-followon-derivation`) and the parent-side
child-cohort link recording (`cohort-topic-parent-child-link`); a dedicated read-only **lookup-probe**
RPC (today `lookup` shares the registration walk and leaves TTL-expiring soft state); an immediate
**withdraw tombstone** (today `withdraw` stops renewing and lets the soft state TTL-expire); and the
real-libp2p (socket) e2e tier.

---

## Wire formats

All messages are JSON, length-prefixed UTF-8, with byte fields encoded as base64url.

> **Canonical codec.** The implementation lives in
> [`packages/db-core/src/cohort-topic/wire`](../packages/db-core/src/cohort-topic/wire) — the
> single source of truth for these shapes and their serialization. Framing is a **4-byte
> big-endian unsigned length prefix** over the UTF-8 JSON body (so a frame is self-delimiting on a
> stream), and a frame whose declared body length exceeds `max_message_bytes` (default 1 MiB,
> pending an exact bound derived from `topics_max` × the cohort-gossip per-summary size) is
> rejected before allocation. Byte fields are base64url **without padding**. Decode validates
> structure per message type and throws a typed `CohortWireError` on any malformed or oversized
> frame.

### Register

```
interface RegisterV1 {
  v:               1
  topicId:         string             // 32 bytes
  tier:            number             // 0..3
  treeTier:        number             // current walk position d
  participantCoord: string            // participant identity P (see note)
  ttl:             number             // ms, default 90000
  bootstrap?:      boolean            // true on root cold-start request
  appPayload?:     string             // opaque, application-defined
  timestamp:       number             // unix ms
  correlationId:   string             // 16 bytes random
  signature:       string             // participant peer-key signature over the body (minus signature)
}
```

> **Participant signature.** `signature` is the participant's libp2p peer-key (Ed25519) signature over
> the deterministic byte image of the body **minus** the `signature` field
> (`registerSigningPayload`, an ordered-array UTF-8 encoding — the sibling of the threshold-notice
> payloads). A cohort member recomputes that image and verifies it against the participant's peer key
> before admitting (an unverifiable register is answered `no_state` — serve nothing, record nothing).
> The signer's public key is read from the participant identity `participantCoord`, which the current
> implementation carries as the participant's **dialable peer id** (the UTF-8 of the peer-id string,
> the same peer-codec encoding as the reply's `primary`/`backups`/`cohortMembers`) so the embedded
> Ed25519 key is recoverable with no network lookup. This `P` is also the record key and the routing
> coordinate fed to `coord_d`. *Tier-0 caveat:* `coord_0` is participant-independent, so this is exact
> for the single-tier milestone; multi-tier (`d ≥ 1`) sharding still wants a **uniform** ring coord
> for `prefix(P, …)`, so reconciling the routing/sharding key with the verifiable signer id (e.g. a
> separate signer field, or hashing `P` only for the `coord_d` input) is a documented follow-on,
> tracked with the rest of the multi-tier work.

```
interface RegisterReplyV1 {
  v:               1
  result:          "accepted" | "no_state" | "promoted" | "unwilling_member" | "unwilling_cohort"
  // accepted:
  primary?:        string             // PeerId
  backups?:        string[]           // PeerIds, 1-2
  cohortEpoch?:    string             // 32 bytes
  cohortMembers?:  string[]           // PeerIds, full cohort, for client cache
  topicTraffic?:   TopicTrafficV1     // present on accepted and promoted; absent on no_state, unwilling_member, unwilling_cohort
  // promoted:
  targetTier?:     number             // d+1 typically; may leap
  // unwilling_member:
  candidateMembers?: string[]         // PeerIds within same cohort to try
  // unwilling_cohort:
  retryAfterMs?:   number
  reason?:         string             // human-readable, optional
}

interface TopicTrafficV1 {
  windowSeconds:       number
  arrivalsPerMin:      number
  queriesPerMin:       number
  directParticipants:  number
  childCohortCount:    number
}
```

### Renew (ping)

```
interface RenewV1 {
  v:               1
  topicId:         string
  participantId:   string
  correlationId:   string             // matches original RegisterV1
  timestamp:       number
  reattach?:       boolean            // true on a crash-failover re-attach (signed; absent on a normal ping)
  signature:       string             // participant peer-key signature over the body (minus signature)
}
```

> **Participant signature.** Like `RegisterV1`, `signature` is the participant's libp2p peer-key
> (Ed25519) signature over the deterministic body image minus the `signature` field
> (`renewSigningPayload`). `participantId` carries the participant's **dialable peer id** (the same
> peer-codec encoding as a reply's `primary`/`backups`), so the signer's Ed25519 key is recoverable
> with no network lookup. A cohort member verifies it on a **`reattach`** renew — the
> privilege-escalating path: an unverifiable `reattach` is redirected (`primary_moved`), never
> promoted, so a stray/MITM'd ping cannot usurp a live primary. A plain ping (no `reattach`) only
> touches `lastPing`, so it is not signature-gated.

```
interface RenewReplyV1 {
  v:               1
  result:          "ok" | "unknown_registration" | "primary_moved"
  // primary_moved:
  newPrimary?:     string
  newBackups?:     string[]
  cohortEpoch?:    string
}
```

### Promotion notice

```
interface PromotionNoticeV1 {
  v:               1
  topicId:         string
  fromTier:        number
  toTier:          number             // typically fromTier + 1
  effectiveAt:     number             // unix ms
  thresholdSig:    string             // cohort threshold sig
  signers:         string[]           // PeerIds, ≥ minSigs
  cohortEpoch:     string
}
```

### Demotion notice

```
interface DemotionNoticeV1 {
  v:               1
  topicId:         string
  tier:            number
  parentCohortCoord: string
  effectiveAt:     number
  thresholdSig:    string
  signers:         string[]
  cohortEpoch:     string
}
```

### Cohort gossip

```
interface CohortGossipV1 {
  v:                  1
  fromMember:         string          // PeerId
  coord:              string          // 32 bytes — the cohort coord this gossip is for (inbound routing key)
  cohortEpoch:        string
  willingnessBits:    string          // 4 bits T0..T3, hex
  loadBuckets:        number[]        // 4 entries, 0..7 per tier
  windowSeconds:      number          // observation window for the rate fields below, cohort-wide
  topicSummaries: {
    topicId:            string
    tier:               number
    directParticipants: number        // exact, gossiped privately within cohort
    arrivalsPerMin:     number        // exact, combined fresh + renewals over windowSeconds
    queriesPerMin:      number        // exact, application-level queries over windowSeconds
    promoted:           boolean
    childCohortCount:   number
  }[]
  records?: {                         // registration-record deltas (new/touched); base64url byte fields
    topicId:            string
    participantId:      string
    tier:               number
    primary:            string
    backups:            string[]
    attachedAt:         number
    lastPing:           number        // convergence key: merge is last-writer-wins by lastPing
    ttl:                number
    appState?:          string
  }[]
  evicted?: {                         // records this member evicted (stale); converge the active set
    topicId:            string
    participantId:      string
  }[]
  timestamp:          number
  signature:          string
}
```

The `records` / `evicted` deltas are how a registration replicates across the `~k` members so a
backup already holds the record when the primary fails (see §Registration record). A receiving
member merges each record last-writer-wins by `lastPing` (so a touch overwrites an older replica)
and applies evictions, but **only when the gossip's `cohortEpoch` matches its own** — a delta under a
foreign epoch belongs to a different membership snapshot (different slot assignments) and is dropped,
with the mismatch surfaced as membership drift. The implementation is the gossip bus in
[`packages/db-core/src/cohort-topic/gossip`](../packages/db-core/src/cohort-topic/gossip); the
willingness/load/`topicSummaries` fold into a per-member view the willingness, barometer, and traffic
layers read.

**Per-coord routing.** A node serves many cohorts at once (one per coord FRET routes to it — see
§FRET integration), and a delivered `cohort-gossip` frame is fanned to every coord engine's bus on the
node. Each bus merges only the gossip whose `coord` names its own cohort: `cohortEpoch` alone cannot
isolate two cohorts because they can share a member set (and therefore an epoch). In the live-signing
path the receiver also drops any frame whose `fromMember` peer-key signature does not verify, or whose
`fromMember` is not a member of the cohort around that coord — so willingness/load cannot be spoofed and
forged records cannot replicate.

**Cadence (host driver).** The cohort-topic host owns one repeating timer (`gossipIntervalMs`, default
5 s — there is no dedicated `gossip_round` constant; it is a derived sub-round of `ping_interval`). On
each tick, for every live coord engine, it TTL-sweeps stale records (gossiping each eviction), drains
the registration-record deltas the renewal `touch`/`evicted` hooks accumulated since the last round into
one `records`/`evicted` batch, broadcasts the signed `CohortGossipV1`, refreshes the membership
certificate (`T_membership_refresh`, self-gated), and runs the demotion check (`T_demote`, self-gated).
Idle engines (no resident topics, no deltas) build no frame and skip the broadcast. A freshly
*admitted* record first replicates on its next renewal touch (the per-touch path), not at admission
time. The driver lives in the host
([`packages/db-p2p/src/cohort-topic`](../packages/db-p2p/src/cohort-topic)); db-core has no timer port.

### Membership certificate

```
interface MembershipCertV1 {
  v:               1
  cohortCoord:     string             // 32 bytes
  cohortEpoch:     string
  members:         string[]           // PeerIds, sorted ascending, length k
  stabilizedAt:    number             // unix ms
  thresholdSig:    string             // sig of (cohortCoord, cohortEpoch, members, stabilizedAt)
  signers:         string[]
  fretAttestation?: string            // optional FRET-provided proof of stabilization
}
```

---

## Configuration

### Defaults

| Parameter | Default | Description |
|---|---|---|
| `F` | 16 | Fan-out per tier |
| `k` | 16 | Cohort size |
| `k − x` | 14 | Threshold for cohort signatures |
| `cap_promote` | 64 | Direct-participant cap before promotion |
| `cap_promote_fast` | 32 | Cap when load barometer is hot |
| `bucket_overload` | 6 | Load-barometer bucket triggering fast promotion |
| `cap_demote` | 16 | Direct-participant floor for demotion |
| `T_demote` | 5 min | Hysteresis window before demotion |
| `T_promote_lookahead` | 30 s | Pre-promotion slope window |
| `T_promote_sticky` | 60 s | Minimum time a cohort stays promoted before re-evaluating |
| `T_rejoin_jitter` | 30 s | Jitter window for post-failure re-registration |
| `ttl` | 90 s | Default registration TTL |
| `ping_interval` | 30 s | Participant ping cadence (`ttl / 3`) |
| `T_membership_refresh` | 5 min | Default refresh interval for membership certs |
| `d_max_cap` | 60 | Hard cap on walk-toward-root start tier |
| `confidence_min` | 0.3 | Below this `n_est` confidence, clamp `d_max` to ⌊d_max_cap/2⌋ |
| `topics_max` | 2048 | Max topics with forwarder state per cohort |
| `backups_per_registration` | 2 | Warm-failover cohort members per registration |
| `register_rate_per_peer` | 4 / min | Per-peer-per-topic rate limit at a single cohort |

> **Defaults validated by simulator.** The design simulator (`packages/substrate-simulator`)
> measured each load-bearing default; all are **confirmed as written** — no value changes for
> downstream implementers (`cohort-topic-wire-formats`, `cohort-topic-tier-addressing-dmax`, …):
>
> - **`F = 16`** — sensitivity sweep (`sweep.ts`, F ∈ {4, 8, 16, 32} at N = 10k) gives steady-state
>   depth 4, 3, 2, 2. `F = 16` sits at the knee: doubling to 32 saves no depth, halving to 8 adds a
>   tier. Confirmed.
> - **`cap_promote = 64`** — sweep (cap ∈ {16, 32, 64, 128}) gives depth 3, 3, 2, 2; `64` is the
>   smallest cap that holds the 10k tree at depth 2 (the depth-law value). Its job is bounding the
>   *root* fan-in, and the measured promotion-window **overshoot is `< arrivalsPerRound`** (see
>   §Promotion and demotion lifecycle), so `cap_promote` is the steady-state floor, not a hard
>   instantaneous ceiling under a storm. Confirmed.
> - **`cap_promote_fast = 32`** — the tail-rotation burst (reactivity) caps the hot new-tail root at
>   exactly 32 direct subscribers and drains 2,000 re-registrations inside `T_drain = 60 s` at
>   `T_rejoin_jitter = 30 s`, `block_fill_size = 64`. The fast cap absorbs the rotation tail without
>   piling the root. Confirmed.
> - **`T_promote_lookahead = 30 s`** — measured to remove the gossip-lagged promotion overshoot **only
>   in the small-increment regime** (`compareLookahead` at `arrivalsPerRound = 10`: 6 → 0); at a larger
>   per-round increment (`arrivalsPerRound = 50` → overshoot 36, unchanged) or under a steep storm it
>   does not (a full round of arrivals lands past the cap regardless). Kept at 30 s, but implementers
>   should not rely on it to bound storm overshoot — it is a smoothing aid, not a hard cap.
>   Confirmed-with-caveat. (See §Promotion and demotion lifecycle for the divisor relationship.)
> - **`T_demote = 5 min`** — convergence runs show **zero depth oscillations** across N ∈ {100 … 1M};
>   the `4×` cap gap + `T_demote` hold prevent flap. Confirmed.
> - **`d_max_cap = 60`** — cold-lookup hop cost is exactly `d_max + 2` (sweep `d_max_cap`
>   ∈ {3,4,5,6} → 5,6,7,8 hops), so the start tier is the sole driver of cold cost and the cap simply
>   bounds the pathological deep probe; at realistic `d_max` (≤ 6 for N ≤ 1M) it is never the binding
>   constraint. Confirmed.
>
> Scenarios: cold-start-storm, tail-rotation, voting-quorum (`scenarios.ts`); scale + sensitivity
> sweep (`sweep.ts`).

### Per-tier overrides

Edge nodes (mobile profile) default to:

- `ttl` = 60 s
- `ping_interval` = 20 s
- T2 and T3 willingness bits permanently off
- Backups sticky-cached across reconnects to avoid re-walk on flap

---

## Application policies

The cohort-topic layer is a substrate. An application — reactivity, matchmaking, voting, broadcast — implements:

1. **Anchor derivation.** What `topicId` is and whether it rotates. Reactivity uses `H(tailId ‖ "reactivity")` (rotates); matchmaking uses `H("match" ‖ taskId)` (stable).
2. **`appPayload` contents.** What's in the per-registration application slot.
3. **Tier choice.** Which tier this application operates at (reactivity push is T3; reactivity replay is T1; matchmaking is T2; voting is T2).
4. **Post-registration RPCs.** Notification delivery, query, voting protocols, etc. These run between participants and their cached `primary`, with the cohort-topic layer providing only the identity. Matchmaking's primary→seeker arrival push ([matchmaking.md §Arrival push on provider arrival](matchmaking.md#arrival-push-on-provider-arrival)) is one such RPC: it fires off the existing gossip-replicated registration records, so it needs no new substrate protocol.
5. **Replay or caching.** If the application needs durable buffering (reactivity does, matchmaking generally doesn't), it manages that state inside the cohort using the layer's existing gossip channel.
6. **Anchor rotation handling.** If the anchor changes (tail rotation), the application detects via its own logic and re-registers under the new `topicId`; the layer treats the new anchor as a new topic.

> **Reactivity interaction — tail rotation is a fresh topic.** When a reactivity collection's tail block
> fills, its anchor `H(tailId ‖ "reactivity")` changes, so the new `topicId` is — from this layer's
> perspective — an **entirely new topic**: a fresh tree at a new tier-0 ring coord, with no relationship to
> the old one. The two trees coexist for the rotation's drain window. The **old** tree drains and shrinks
> via the standard demotion protocol (§Promotion and demotion lifecycle): its forwarder cohorts watch their
> direct-subscriber count fall as subscribers re-register elsewhere and demote naturally — no state is
> migrated through this layer. The **new** tree forms via ordinary registration + promotion (§Tree growth
> and lookup), absorbing the re-registration wave; reactivity staggers that wave over `T_rejoin_jitter` so
> the new root stays within `cap_promote_fast` (§Configuration `cap_promote_fast = 32`). The only state
> reactivity migrates across the rotation (a replay-buffer→checkpoint handoff) rides reactivity's own logic,
> not this layer; see [reactivity.md §Tail rotation](reactivity.md#tail-rotation).

The layer's contract to applications is: given a `topicId` and a `tier`, you will reliably find a willing primary (or fail with a clear back-off signal); registrations persist within their TTL; cohort identity and membership are verifiable. Everything else — content, ordering, durability, semantics — is the application's responsibility.

---

## Interaction with other subsystems

- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — provides ring coordinates, cohort assembly, `RouteAndMaybeAct`, stabilization, network-size estimation, and membership advertisements.
- **Transaction log** ([transactions.md](transactions.md)) — T0/T1 cohort memberships are committed as part of normal block production. The layer reads these but never writes.
- **Reactivity** ([reactivity.md](reactivity.md)) — push-tree application; uses rotating anchors and replay buffers on top of this layer.
- **Matchmaking** ([matchmaking.md](matchmaking.md)) — directory application; stable anchors, provider/seeker registrations.
- **Partition healing** ([partition-healing.md](partition-healing.md)) — cohort merge after partition is handled by FRET stabilization; the layer reacts via `cohortEpoch` refresh.
- **Reputation** (see [architecture.md](architecture.md)) — bootstrap-time evidence for cold root instantiation may reference reputation scores; persistent `UnwillingCohort` from a cohort known to be honest is also a signal the reputation subsystem may consume.
