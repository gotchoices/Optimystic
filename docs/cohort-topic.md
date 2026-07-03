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

At `d_max`, each tier-`d_max` cohort covers `F` peers on average — roughly one cohort's worth. Deeper would mean tier coordinates with fewer peers than a cohort, which FRET handles but provides no fan-out benefit. If `n_est` confidence falls below `confidence_min` (default 0.3), participants cap `d_max` at `⌊d_max_cap / 2⌋` — i.e. `d_max = min(formula, ⌊d_max_cap / 2⌋)` — to avoid pathological deep probes from an over-estimated population. Small or sparse populations (where the formula already yields a small value) are unaffected.

`d_max` is recomputed lazily; participants don't need it precise. The simulator validates the
formula and the `confidence_min` cap against FRET's reported `(n_est, confidence)` over
N ∈ {10, 100, 1k, 10k, 100k}; see the simulator validation note under §Tier addressing.

> **Implementation.** `packages/db-core/src/cohort-topic/dmax.ts` (`makeDMaxComputer`) reads the
> estimate lazily through the injected `ISizeEstimator` (db-p2p wraps FRET's
> `estimateSizeAndConfidence`) and caps the formula result at `⌊d_max_cap / 2⌋` (upper bound, not
> a set-to) when `confidence < confidence_min` — i.e. `min(formula, ⌊d_max_cap / 2⌋)`. `⌊log_F(n_est)⌋` is computed with a power-of-`F` boundary
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
- **Follow-on cold-start (deeper-tier growth).** When a walk follows a `Promoted(d+1)` redirect and the tier-`(d+1)` child answers `NoState`, that child shard does not exist yet. Stepping inward would return to the promoting parent and be redirected again — an oscillation. Instead the **register** path re-issues **once** at that same child tier with a `followOn: true` flag, asking the cold child to instantiate (the deeper-tier analogue of the root's `bootstrap: true`). If the follow-on also returns `NoState` (the child's quorum is unwilling), the walk backs off in time rather than looping. This is what lets a join that lands on a freshly-promoted-but-not-yet-grown branch converge. `followOn` is participant-asserted on the wire, so it is gated by the **same** anti-DoS evidence a `bootstrap` cold-start pays (§Anti-DoS). A read-only `probe` never instantiates, so it backs off immediately instead of setting `followOn`.

> **Read-only lookup (`probe: true`).** `service.lookup` walks this *same* path with `RegisterV1.probe`
> set: identical routing discipline (inward on `NoState`, follow `Promoted` outward, back off on
> `UnwillingCohort`), but the terminal cohort **classifies** rather than admits — returning the same
> `Accepted` / `Promoted` / `NoState` reply without persisting a record, counting an arrival, firing a
> promotion trigger, touching the topic budget, or instantiating anything. It diverges from a register at
> two points: (1) the root `NoState` case **backs off** (`CohortBackoffError`) instead of re-issuing
> `bootstrap: true` — a probe never instantiates a cold root; (2) after following a `Promoted` redirect
> outward, if the promoted child answers `NoState`, the probe **backs off immediately** (`CohortBackoffError`)
> rather than walking inward to the promoting ancestor — the responsible child shard is not yet
> instantiated; a probe never instantiates it. Walking back to the ancestor would just re-trigger the
> `Promoted` redirect and loop. The "resolve the nearest served ancestor" alternative is deferred: the
> `Promoted` reply carries only `targetTier`, not the ancestor's `primary`/`backups`/`cohortEpoch`, so
> a richer ancestor hint requires a protocol extension.

> **Implementation.** The participant-side walk is
> [`packages/db-core/src/cohort-topic/walk.ts`](../packages/db-core/src/cohort-topic/walk.ts)
> (`WalkEngine` / `createWalkEngine`). It drives the injected `ITopicRouter` port — **not** a direct
> FRET import — keying each probe at `coord_d(self, topicId)` (via `TierAddressing`) with
> `wantK = k`, `minSigs = k − x`, decoding the `RegisterReplyV1` and dispatching: `no_state` → step
> inward (`d − 1`), with the root case re-issuing once at tier 0 with `bootstrap: true`, **and the
> after-a-`Promoted`-redirect case re-issuing once at the same child tier with `followOn: true`** (then
> backing off if that too returns `no_state`); `promoted(targetTier)` → the one outward move, recomputing
> `coord_targetTier` and registering there (or, with `followPromoted: false`, surfaced to the caller);
> `unwilling_member` → a direct `dialMember` retry of a named sibling at the **same** coord;
> `unwilling_cohort` → terminate with a `retry_later(afterMs)` so the caller backs off in time and a fresh
> `register` restarts at `d_max` (never re-hitting the declined coord). Building + signing each
> `RegisterV1` is delegated to an injected `RegisterMessageFactory` (participant identity/crypto live
> there); it mints the same signed `bootstrapEvidence` envelope on a `followOn` re-issue as on a
> `bootstrap` re-issue. A `maxSteps` safety valve remains as a backstop against a malformed tree, but the
> `followOn`-then-backoff path — not `maxSteps` — is now the primary terminator for a promoted-but-cold
> branch. Spec: `walk.spec.ts` (sparse-regime distinct-`coord_{d_max}` fan-out, `Promoted` outward
> recompute, `UnwillingCohort` restart-at-`d_max`, sibling-dial retry, bootstrap re-issue, follow-on
> re-issue → willing child accepted / unwilling child backs off).

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

An **idle** member — one holding no registrations — still advertises its willingness on a slow heartbeat (§Cold-start instantiation → *Bootstrapping a cold multi-node cohort*), rather than going silent. Without this a brand-new all-idle cohort could never reach a willingness quorum, so its first registration would be declined forever.

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
  childCohortCount:    number   // tier-(d+1) child cohorts recorded for this topic, 0 if not promoted
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
> `directParticipants` is read from the replicated store rather than summed. `childCohortCount` is a
> **converged union** of the child cohorts this parent parents — not a max-of-siblings. The child set is
> sharded across parent members (FRET routes a child-link to one member, so different child coords land on
> different members), so a per-member count is a shard, not the total. Each member gossips its own child
> link/unlink deltas (`CohortGossipV1.childLinks` / `childUnlinks`) and merges inbound ones straight into its
> per-engine child registry (last-writer-wins by `effectiveAt`, keyed by child coord — **not** the parent
> epoch, so a parent rotation never drops the set), so after one gossip round every parent member holds the
> full union and `childCohortCount` is consistent cohort-wide (`cohort-topic-child-link-replicate-unlink`). It
> is supplied to the traffic snapshot as the promotion-layer override. (The override is *always* authoritative
> when wired — it returns a number, `0` included, so the nullish-coalescing `childOverride ?? maxOfSiblings`
> never falls through to the gossiped max; that max-of-siblings computation is dormant while the registry
> override is wired, correct now that the override itself converges cohort-wide.)

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

> **TTL is clamped at admission.** A requested `ttl` is forced into `[MIN_TTL_MS, MAX_TTL_MS]` (10 s … 15 min = `10 × DEFAULT_TTL_MS`) by the single `clampTtl` policy gate in `registration/types.ts`. Both admission paths run through it: local `accept()` and — because gossip is a *second* path into the store — the `mergeRecords` step of the gossip bus, so a peer that never clamped (unpatched, buggy, or hostile) cannot replicate an unbounded lifetime that would pin a `topics_max` budget slot forever. Non-positive requests fall to `DEFAULT_TTL_MS` first. The wire validator stays a pure structural decoder; out-of-range TTLs are policy-adjusted, not rejected.

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

> **T2/T3 cert trust = FRET ring agreement (db-p2p `FretTrustAnchor`).** A FRET-published `MembershipCertV1`
> is *self-signed* by its cohort, so trusting it requires anchoring the `coord → keyset` binding (§Bootstrapping
> trust). The T2/T3 direct anchor is the node's own FRET cohort assembly: for a coord the node **covers** (a
> populated neighborhood it serves), the cert's signing quorum must agree with `assembleCohort(coord)` within a
> small churn slack, else the cert is rejected as a forgery. For a coord the node does **not** cover (a distant
> reactivity-tail coord), the anchor abstains (`"unknown"`) and verification falls back to TOFU — there is no
> transferable stabilization proof a non-covering node could check, so distant T2/T3 first-sight stays TOFU.

> **Reused by the parent-reference anti-DoS gate.** The same tier-routed membership state backs the
> synchronous local "does this parent topic exist?" check the `verifyParentReference` bootstrap-evidence
> verifier consults (§Anti-DoS). A node only knows a parent topic exists if it has *locally cached* a
> cert/commit for `coord_0(parentTopicId)` — so the gate is **fail-closed when the parent is unknown**:
> the FRET membership cache (`FretMembershipSource.has`) genuinely answers existence for **T2/T3**, while
> **T0/T1** existence needs a committed-state backing distinct from the FRET cache (committed-tier
> integrity). No coord-keyed committed-membership index exists yet (the tx-log commit certificate is
> keyed by action, not by `coord_0`), so T0/T1 parent-ref existence fails closed today; the dedicated
> committed backing — and the stronger "the parent's committed record names *this* child" check — is the
> follow-on `cohort-topic-parent-ref-tx-log-content`.

### Membership fetch

A participant verifies a notification or threshold-signed message as follows:

1. Extract the signer set from the message (every threshold-signed message carries the `signers: PeerId[]` list).
2. Compute the cohort coord the signers should belong to (from the message's claimed tier/topic/coord).
3. Look up the most recent `MembershipCertV1` for that coord, cached locally or fetched from any cohort member.
4. Verify (a) the certificate is current, signed, and consistent with FRET stabilization, and (b) the signers in the message are a `≥ minSigs` subset of the certificate's members.

`MembershipCertV1` is refreshed by the cohort every `T_membership_refresh` (default 5 minutes) and on any stabilization event that changes the cohort membership — i.e. any change to the epoch `H(sorted members)`, head or tail. Participants cache the latest one they've seen per coord; verification against a slightly stale cert is acceptable as long as the cert's signers overlap with the current cohort by quorum.

> **Implementation.** Cohort-side publication (at stabilization, on any epoch change — any member
> change, head or tail — and on the refresh tick) is
> [`membership/publisher.ts`](../packages/db-core/src/cohort-topic/membership/publisher.ts);
> participant-side verification is
> [`membership/verifier.ts`](../packages/db-core/src/cohort-topic/membership/verifier.ts). The
> verifier checks the message's `signers` are a distinct `≥ minSigs` subset of the cert's `members`
> and the signature verifies (the `k − x` threshold logic of
> [`sig/threshold.ts`](../packages/db-core/src/cohort-topic/sig/threshold.ts)). On failure against a
> cached/stale cert it re-fetches the cert from any cohort member **exactly once** and retries; still
> failing → the message is **untrusted**. Its per-coord caches (`byCoord`, the refetch-rate clock, and
> the stale-gap strike counter) are each an `LruMap` hard-capped at `maxCoords` (default 100 000, the
> replay-guard ballpark), so a flood of verify-misses against attacker-chosen coords cannot grow verifier
> memory without bound — the least-recently-used coord is evicted (best-effort against the self-published
> trust lock; see the eviction `NOTE:` in `verifier.ts`). A freshly fetched cert is accepted only if it is
> self-consistent (its own threshold signature is a quorum of its members) **and** trust-anchored — see
> §Bootstrapping trust, below, for the trust gate that distinguishes a legitimate cohort from a
> self-consistent forgery. The threshold-signature primitive is reused from FRET's `minSigs = k − x`
> cohort-signature assembly via an injected port (db-core never imports FRET).

### Bootstrapping trust

A participant joining the network gets its initial trust roots (the cohorts responsible for genesis-block-related topics) from any peer it dials, validated against the genesis block hash known out-of-band. From there, membership certificates form a chain of attestations.

> **Genesis-root seam (db-p2p host).** The trust roots are seeded into the verifier through the
> `createCohortTopicHost({ genesisTrustRoots })` option (threaded straight into
> `createMembershipVerifier({ trustRoots })`). It is the typed plumbing point, **empty by default** — the
> concrete genesis-cohort set is a property of a specific network's genesis block, validated out-of-band by
> the caller *before* seeding; the host fabricates no roots. With none configured the chain simply bottoms
> out at the direct anchor / TOFU, so a network with no genesis cohort defined is never broken.

**Why self-consistency is not enough.** A `MembershipCertV1` carries its own threshold signature over its own members, so "self-consistent" proves only that some `≥ minSigs` key set signed the cert — *not* that that key set is the legitimate cohort for the coord. An adversary controlling `k − x` keys could mint a self-consistent cert over a coord it does not own and have it pass per-message verification. The trust gate closes that gap: a (re)fetched cert is believed only if it is self-consistent **and** anchored.

**The trust gate (implemented in [`membership/verifier.ts`](../packages/db-core/src/cohort-topic/membership/verifier.ts)).** A cert's `coord → members` binding earns trust by **any one** of:

1. **Trust root** — `(coord, epoch, member-set)` is in the out-of-band-seeded `TrustRoot` set (the genesis cohorts, validated against the genesis block hash before seeding). The base case of every chain; checked before the direct anchor, so a configured root is authoritative.
2. **Direct anchor** — an injected `IMembershipTrustAnchor` (`ports.ts`) judges, from a source the node *directly* trusts, whether the members are authoritative for the coord at that tier. The verdict is three-valued: `"anchored"` (vouched → trusted), `"rejected"` (contradicted → **forgery, fatal even if self-consistent**), or `"unknown"` (no local authority → fall through). The direct anchor is tier/transport-specific (FRET ring agreement for T2/T3, the tx-log commit certificate for T0/T1) and is bound in db-p2p — **db-core never imports FRET**. The db-core default `noAuthorityTrustAnchor` returns `"unknown"` for every coord.

   > **FRET-ring binding (db-p2p `FretTrustAnchor`, `cohort-topic-trust-anchor-fret-binding`).** The T2/T3
   > direct anchor is bound to FRET's local two-sided cohort assembly, the only coord→keyset authority
   > p2p-fret 0.5.0 exposes (there is **no transferable stabilization proof** — the cert's `fretAttestation`
   > is never populated). For a **covered** coord — a populated, non-partitioned neighborhood the node is
   > itself part of, i.e. a coord it serves (the amplification-exposed `promote`-handler shape) — the anchor
   > compares the cert's **signing quorum** (`cert.signers`) against `assembleCohort(coord)`, widened by a
   > small `churn_slack` (≈ 2) for stabilization skew: a quorum that is a subset of the slack-widened ring →
   > `"anchored"`; a quorum **wholly disjoint** from the ring (a different keyset owns this coord) →
   > `"rejected"`; partial overlap beyond the slack → `"unknown"` (ambiguous churn — don't over-reject).
   > Anchoring on the *quorum* (not exact member-set equality) is sound because a forged cert must sign with
   > adversary-controlled keys, which are not in the ring → disjoint → rejected. **Limits (all → `"unknown"`,
   > so no regression):** the **committed tiers T0/T1** (the tx-log anchor's job, composed-with not
   > fought — binding tracked in `cohort-topic-trust-anchor-txlog-committed-binding`); a **distant** coord
   > the node does not cover (no local authority); and a **cold / partitioned** table (`assembleCohort`
   > short of `k`, or `detectPartition()`) — never `"rejected"` during bootstrap/partition.
3. **Attestation chain (epoch rotation)** — a cert may carry a rotation attestation (`prevEpoch` / `rotationSig` / `rotationSigners`, all three or none): the *predecessor* cohort's threshold signature over **this** cert's signing payload. If the node already holds a **trusted** cert for the same coord whose epoch is `prevEpoch`, and that predecessor's members form a `≥ minSigs` quorum over the successor payload, the successor inherits trust. This is what distinguishes a legitimate rotation (the prior cohort signed off) from a forgery. Only a *trusted* cert may anchor a successor — a cert that only reached the cache via the TOFU fallback (below) never launders trust into a rotation. The attestation is **not** part of `membershipCertSigningPayload` (it signs *over* it), so legacy certs without it still decode.

   > **Producing the attestation (db-p2p host, `cohort-topic-trust-anchor-rotation-production`).** Each
   > served `CoordEngine` tracks its last-published cohort identity. When a publish changes the cohort
   > epoch — any member change, head or tail (the publisher's own republish trigger) — the host
   > threshold-signs the **new** cert's
   > `membershipCertSignable` image under the **predecessor** cohort identity — a `/sign` round with a new
   > `"rotation"` `SignKind`, `cohortEpoch = prevEpoch`, dialing the *outgoing* members — and attaches the
   > `{ prevEpoch, rotationSig, rotationSigners }` via the publisher's `rotation` arg. Because rotation is
   > incremental, a `≥ minSigs` quorum of the prior cohort is normally still online, so this reuses the
   > existing endorsement transport, just gated on **prior**-epoch membership: a member endorses a
   > `"rotation"` request only if it (and the requester) were members at `prevEpoch` (a two-deep observed-epoch
   > history per coord). Self contributes its own chunk only when it was itself a prior member, so the quorum
   > is genuinely the outgoing cohort. The signed image is the *same* `membershipCertSignable` the publisher
   > emits, so the db-core chain check verifies `rotationSig` over an exactly-matching payload. **First-ever
   > publish** for a coord emits no attestation (its trust is the direct anchor / root, not a chain link).
   >
   > **Fallbacks (each → publish without an attestation, never blocking the cert).** *Predecessor quorum
   > unavailable* (mass churn / partition drops the prior cohort below `minSigs`): the rotation `/sign` round
   > throws, the host logs it and republishes the new cert with no attestation — trust falls to the direct
   > anchor / TOFU, no worse than a non-rotation publish. *Rapid double rotation* (N → N+1 → N+2 within one
   > observe window): each publish attests only its immediate predecessor, so a participant cached at N that
   > receives N+2 sees a gap and re-anchors — no multi-hop attestation is attempted. *Refresh republish*
   > (periodic, epoch unchanged) is not a rotation and carries no rotation fields.

> **Why no monotonic-epoch / rollback gate.** `cohortEpoch = H(sorted members)` is content-derived, not an ordered counter, so epochs are unorderable hash ids and the chain is a hash-linked attestation DAG (`prevEpoch` is a hash pointer), not a height-ordered ledger. Replaying an older legitimately-signed cert is a **freshness** concern (stale membership), already covered by `stabilizedAt` + the one-refetch tolerance — not a trust-gate concern.

**Interim TOFU fallback and its documented limits.** For a coord the node cannot anchor — the direct anchor returns `"unknown"`, there is no trust root, and no valid chain — and that holds **no trusted cert yet**, the verifier falls back to trust-on-first-use of any self-consistent cert. This is identical to the pre-gate behavior, so there is **strictly no regression** on coords no node can verify today. The security improvement is bounded and explicit:

- **FRET-covered coords** (the host / `promote`-handler path, which verifies against a coord the node serves): db-p2p binds the FRET-ring anchor (`FretTrustAnchor`, above), so a forged cert from an unrelated keyset for a covered T2/T3 coord is **`"rejected"`** — **closing the amplification-exposed attack**. (Binding landed: `cohort-topic-trust-anchor-fret-binding`.)
- **Epoch rotations**: once a coord holds a *trusted* cert, the attestation chain governs its successors. An un-anchored cert for an already-trusted coord is rejected (no silent TOFU downgrade), so a forged rotation off a trusted predecessor is dropped. A coord that was only ever TOFU'd stays in the TOFU regime (a TOFU predecessor confers no trust), which is the documented limit until the direct anchor covers it.
- **Distant first-sight T2/T3** (a reactivity-tail coord the node does not cover) and **all T0/T1** remain TOFU for now — the FRET ring anchor returns `"unknown"` for a coord outside its routing-table coverage (there is no transferable FRET stabilization proof a *non-covering* node could check — tracked in `cohort-topic-trust-anchor-fret-stabilization-proof`), and the committed-index binding does not exist yet (`cohort-topic-trust-anchor-txlog-committed-binding`).

There is deliberately **no** hard "reject on `"unknown"`" mode: the three-valued verdict already gives FRET-covered nodes their teeth (`"rejected"`) without a global flag that would break distant verifiers.

**Stale trust-lock recovery (a former member self-heals).** The "trust-established coord rejects un-anchored certs" rule (above) is a *lock*, and a node can get stranded on the wrong side of it. Consider a node that served coord `C`, self-published its cert (which trust-**locks** `C` at epoch `N` — a self-published cert is trusted), then **left `C`'s cohort**: its direct anchor now returns `"unknown"` for `C` (no local authority), and it no longer republishes `C`. If `C` then rotates `N → N+1 → N+2` while the node isn't watching and the node later receives a message signed by `C`'s cohort at `N+2`, the refetched `N+2` cert carries `prevEpoch = N+1 ≠ N`, so the attestation chain does not connect (the node never saw `N+1`) and the lock rejects it. Without recovery, the node distrusts every message from `C` until the host process restarts (which clears the in-memory cache). This is a **liveness** degradation, never a safety hole — a forgery is still rejected.

The verifier recovers on its own via **bounded re-TOFU on a demonstrated chain gap** (`membership/verifier.ts`, `staleGapRecoveryStrikes`, default `3`). A refetched cert is a *gap strike* for a locked coord only when it is self-consistent, its direct anchor is `"unknown"`, and it carries a rotation attestation whose `prevEpoch` differs from **both** its own epoch (not self-referential) and the cached locked epoch (a real gap, not a forgery off the current predecessor). After `staleGapRecoveryStrikes` **consecutive** gap strikes (any successful verify for the coord resets the count) the lock is released: the gap cert is re-cached as **untrusted** (TOFU — it must never launder trust into a rotation) and the coord re-enters the interim TOFU regime. This is **no weaker than the TOFU baseline**: a former member simply returns to the same regime a node that *never* served `C` is already in (a never-member full-TOFUs any self-consistent cert for `C`). The gate is what keeps it safe — a forged rotation off the *current* cached predecessor (`prevEpoch == N`, adversary keys) is **not** a gap, never counts as a strike, and stays rejected forever, so the lock's teeth against the amplification-exposed forgery are intact. Recovery also paces itself with the (bounded) refetch rate: a `RefetchBound`-suppressed refetch observes no cert, so no strike accrues. The cleaner root-cause fix — the host explicitly dropping a coord's lock when it stops serving that coord — needs an engine-reclaim / demotion signal the host does not emit today (`createCoordRegistry` never evicts); it is noted as a tripwire at the `onCertPublished` seam in `db-p2p/src/cohort-topic/host.ts` and is preferred over this heuristic once that infrastructure lands.

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
> demotion, additionally the parent coord); inbound, the `promote` handler (`handleInboundNotice`) runs a
> cheapest-first anti-abuse gate before any signature/network work — `decode → per-(peer, topic) rate
> limit → resolve engine by carried cohortCoord → high-water → verify+apply` — so a peer streaming junk over the
> protocol cannot amplify into per-message signature verification or membership dials. The rate limiter
> is the same `register_rate_per_peer` sliding-window limiter (its own node-level instance, since the
> handler is node-level); the per-served-coord `effectiveAt` high-water drops a replay/out-of-order
> notice before `verifyMessage` and is advanced **only** on a verified-and-applied notice (so a forged
> frame cannot poison it); and the verify itself passes a `PROMOTE_REFETCH_MIN_INTERVAL_MS` (60 s)
> bound that rate-limits the stale-cert refetch to one `source.fetch()` per coord per interval (eventual
> refetch preserved — a cold cache / membership rotation still re-fetches once it elapses). It resolves the
> target cohort by the notice's **signed `cohortCoord`** (the exact served coord the decision was made for)
> rather than by a first-match `(topic, tier)` scan: a node serving several sibling cohorts for one
> `(topic, tier)` — possible at `d ≥ 1` — thus routes the notice to the cohort that produced it, and keys
> the high-water by that coord so one cohort's notice can neither mis-apply to nor stale-drop a sibling's.
> It then verifies the threshold signature against that cohort's `MembershipCertV1` via the participant
> `MembershipVerifier` (signers ⊆ cert, `≥ minSigs`, multisig valid — `cohortCoord` is covered by the
> signature, so rewriting it to hijack a sibling breaks verification), and applies it — a notice for a coord
> this node does not serve, or undecodable / rate-limited / stale / untrusted ones, are dropped (never throws
> on the stream). Specs: `promotion.spec.ts`
> (remote-apply ordering/idempotency), db-p2p `promote-notice.spec.ts` (verify + apply, forged/short-quorum
> + non-member rejection, no-engine drop, broadcast fan-out, anti-abuse gate: flood-bounded refetch /
> rate-limit drop / high-water replay drop), db-core `membership.spec.ts` (bounded-refetch rate limit).

### Demotion (cohort shrinks)

A cohort demotes for topic `T` when, for a quorum of members:

- `directParticipants(T) ≤ cap_demote` (default = `cap_promote / 4`), AND
- The above has held for at least `T_demote` (default 5 minutes), AND
- The cohort has no live `childCohorts` for `T`.

Demotion threshold-signs a `DemotionNoticeV1` and fans it to **two** targets: the demoting cohort's own served coord (siblings adopt `promoted = false`) **and** its `parentCohortCoord`. At the parent, the notice is a second, independent apply — the parent verifies it against the **child** cohort cert (the same threshold verify a sibling runs) and, on success, **unrecords the child** from its per-engine child registry ("drop me from your tier-(d+1) children"). That release gossips across the parent cohort exactly as the link does (last-writer-wins by `effectiveAt`), so every parent member's `childCohortCount` falls; once the last child is gone the parent's own demotion gate (`childCohortCount > 0` no longer blocks) can fire in turn. The demoting cohort releases all forwarder state for `T`. (A node that serves *both* the demoting child coord and the parent coord applies both semantics from one notice; the parent-unlink runs independently of the sibling-adopt replay high-water, ordered by the child registry's own per-child freshness — see `cohort-topic-child-link-replicate-unlink`.)

### Cold-start instantiation

A cold cohort instantiates as a forwarder for `T` when:

- It receives a `RegisterV1` for `T` it doesn't yet serve, AND
- The registering participant's `bootstrap: true` flag is set (root case) or the registration arrives as a follow-on to a parent's `Promoted` redirect, AND
- A quorum of cohort members is willing to serve `T` at the registration's tier.

The newly-instantiated forwarder registers itself with its tier-(d−1) parent on first opportunity by sending a **child-link** the parent authenticates and records; until that link is acked (`linked`), the cohort accepts participants but holds notifications/queries that would require parent involvement.

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
> `false`, so the walk gets `NoState` instead of forking a parallel branch. `followOn` **is a signed wire
> flag** on `RegisterV1`: the child cohort a `Promoted` redirect points at is at an *uncorrelated* ring
> coord from the promoting parent (the tier-addressing hash decorrelates tiers) and FRET delivers the
> register with no breadcrumb of the redirect, so the child genuinely cannot infer `followOn` locally — it
> must be carried on the frame. The db-p2p host derives `ctx.followOn = reg.followOn === true` in
> `dispatchRegister`. Because a wire flag is participant-forgeable, safety comes not from provenance but
> from the anti-DoS gate: a `followOn: true` cold-start is evidence-gated identically to a `bootstrap: true`
> cold-start (§Anti-DoS), so it pays the same proof-of-work / reputation / parent-reference cost. `createForwarder` / the
> `ColdStartManager` hold the link-up state machine: a deeper forwarder starts `awaiting_parent` —
> accepting participants but holding parent-involving ops — and flips to `serving` when its
> `ParentRegistrar.registerWithParent` acks; the root (tier 0) has no parent and serves immediately.
> `promotedRedirectReply` builds the `Promoted(d+1)` bounce above (attaching the outgoing cohort's
> traffic). Spec: `coldstart.spec.ts`.
>
> The db-p2p host supplies the parent-registration **transport + recording**
> ([`host.ts`](../packages/db-p2p/src/cohort-topic/host.ts) `registerForwarderWithParent` +
> `dispatchChildLink`): a cold-started tier-`d` forwarder routes a dedicated **`ChildLinkV1`** frame to its
> tier-`(d−1)` parent coord over `ITopicRouter.routeAndAct`. The frame carries the child's served coord
> (`childCohortCoord`) and its seed `childParticipantCoord`; in live-key mode the child cohort
> **threshold-signs** it over its own coord at its current epoch (the new `"childlink"` `/sign` kind),
> key-less it ships unsigned. The routed parent member **binds** the relationship — it reject-unless
> `coord_childTier(childParticipantCoord, topicId) == childCohortCoord` **and**
> `coord_(childTier−1)(…)` is its own served coord — **verifies** the child cohort's threshold signature
> against the child cohort cert (permissive in key-less mode; a live parent never records an unsigned
> link), **records** the child in a per-engine registry (freshness-ordered, idempotent), and replies
> `ChildLinkReplyV1 { result: "linked" }`. The forwarder flips to `serving` only on a `linked` ack; a
> `rejected` reply / unreachable parent leaves it `awaiting_parent` for a later retry without crashing the
> instantiating register.
>
> The recorded count is the real input to the demotion gate, the gossip topic summary, and the traffic
> snapshot (all three were hardcoded `0` before). **Single-member scope:** FRET routes the link to *one*
> parent member, so only that member records the child; sibling parent members read `0`. Cohort-wide
> convergence (gossip-replicate the child set so every parent member agrees) and the **unlink** on child
> demotion are the follow-on `cohort-topic-child-link-replicate-unlink`. Consequence within this milestone:
> a parent that has recorded a child never sees the count drop, so it will not demote once it has parented
> a child (acceptable intermediate). Specs: `host-antidos-coldstart.spec.ts` (record + reject),
> `threshold-assembly.spec.ts` (`/sign` `childlink` endorsement), `wire.spec.ts` (frame + payload).

#### Bootstrapping a cold multi-node cohort (willingness heartbeat + cold-sibling instantiation)

The gate above (`(bootstrap ∨ followOn) ∧ quorumWilling`) assumes the routed member can actually *see* a
willing quorum. A brand-new multi-node cohort — every member freshly brought up and holding no
registrations (**idle**) — cannot: the willingness quorum is read from gossiped sibling willingness
(§Willingness), and an idle engine that holds no registrations otherwise builds no gossip frame. So nobody
advertises willingness, the routed member counts only itself, its self-willingness never reaches a quorum,
and the first registration is declined `UnwillingCohort` forever. Because FRET routes every registration
for a coord to the *same* nearest member, the siblings are never independently woken either — the cohort
never gets off the ground.

Two coordinated mechanisms break this deadlock. Both are scoped to the single **tier-0** cohort this
milestone serves; tier-`d > 0` bootstrap needs the topic/`participantCoord` context a bare willingness
frame lacks and is deferred to the parent-child link work (`cohort-topic-parent-child-link`).

1. **Idle-but-willing willingness heartbeat.** An idle engine that is willing for at least one tier
   (`selfWillingnessBits ≠ 0`) still emits a *willingness/load-only* gossip frame (empty `topicSummaries`,
   no record/eviction deltas) so siblings hear that it will serve. It emits **immediately on the first idle
   round after the engine is created** (so bootstrap converges in ≈ 2 rounds) and thereafter at most once
   per `T_willingness_heartbeat` (§Configuration). A record-carrying (non-idle) round already ships
   willingness every round and resets that clock, so the throttle governs only genuinely-idle engines; an
   engine willing for *nothing* stays silent (it has nothing to bootstrap).

2. **Cold-sibling engine instantiation.** When a node receives a `/cohort-gossip` frame (e.g. the heartbeat
   above) for a coord it holds **no engine** for, it instantiates that engine so it joins the cohort's
   gossip and its next heartbeat reciprocates. This is gated on the **same co-member authenticity check the
   gossip bus already applies** — `fromMember`'s peer-key signature verifies **and** `fromMember` is in
   `cohortAround(coord).members` — so a peer can only make you instantiate an engine for a coord FRET
   assembly agrees you both serve. This bounds the DoS surface; without it, cold siblings would materialise
   only when independently routed to, which never happens.

Convergence: the routed member's first idle round heartbeats → each sibling instantiates its own coord
engine and merges the willingness → the siblings' next heartbeat fills the routed member's view → the
retried registration meets the quorum and is admitted **through the existing quorum gate** (no
admission-policy relaxation) → the admitted record replicates to the now-materialised siblings, restoring
real warm replicas and failover.

> **Implementation.** The heartbeat is the `heartbeat` branch of `buildCohortGossip`
> ([`cohort-gossip-driver.ts`](../packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts)), driven by a
> per-`CoordEngine` heartbeat clock in `CoordEngine.gossipRound`
> ([`host.ts`](../packages/db-p2p/src/cohort-topic/host.ts)). Cold-sibling instantiation is
> `maybeInstantiateColdSibling` in the host's `/cohort-gossip` handler, run **before** the frame is
> delivered (so the freshly-subscribed bus merges the very frame that woke it) and **only in live-signer
> mode** (the co-member gate needs keys; key-less/interim mode keeps today's drop-gossip-for-an-unknown-coord
> behaviour, since unauthenticated engine creation would be a DoS vector). The originating cohort's
> `treeTier` rides `CohortGossipV1` — a coord is a hash and cannot be inverted to recover its tier, and every
> member of a coord shares one `treeTier` by construction — and is **covered by the frame signature** so it
> cannot be spoofed; instantiation is gated to `treeTier === 0` (a tier-`d > 0` frame for an unknown coord
> falls through to today's drop). Specs: `gossip-cadence.spec.ts` (the willingness-only heartbeat frame),
> `live-tier.spec.ts` 5b (cold-bootstrap end-to-end: cold cohort declines, heartbeats propagate, a sibling
> instantiates, register-once → `accepted`, and the record replicates).
>
> **Cost (tripwires).** The coord-engine registry is hard-capped (`createCoordRegistry`,
> `coordEnginesMax`, default 2048) with LRU eviction of *idle* engines (no records, no cold-start
> forwarder), so cold-sibling instantiation is no longer a permanent per-co-member-coord cost: an idle
> gossip-instantiated engine is reclaimed under memory pressure, and a creation over a full-of-live registry
> is refused (`CoordEngineRegistryFullError`, surfaced as `unwilling_cohort` / `rejected` / a dropped
> cold-sibling). Eviction is idle-only, so it never strands a verifier trust-lock (an idle engine never
> published a cert). The heartbeat re-broadcasts willingness for every idle-but-willing cohort every
> `T_willingness_heartbeat`; the throttle plus the willing-for-something gate are the mitigations, but a node
> serving very many idle cohorts may need to batch heartbeats or lengthen the interval.

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
> reaching the root. **Cold-start-storm claim semantics.** The scenario's `root-not-overloaded` claim
> measures the *cumulative* tier-0 acceptance over the burst, which is bounded by `cap_promote` only at
> moderate arrival rates — so the claim is worded as the honest bound it actually satisfies:
> **cumulative tier-0 acceptance ≤ `cap_promote` + one round of arrivals** (the same
> `peakOvershoot < arrivalsPerRound` bound quantified under §Promotion and demotion lifecycle, not a
> separate effect). The scenario **default is the moderate regime** (`subscribers = 3,000` / 5 s), where
> cumulative tier-0 acceptance is exactly `cap_promote = 64`, so `runAllScenarios()` — the default-arg
> convenience entry point — is green out of the box. The **storm regime** (10,000 / 5 s ≈ 2,000/s) is an
> explicit opt-in: there the gossip-lagged promotion lets cumulative tier-0 acceptance reach **122
> (~2× `cap_promote`)** before promotion + redirect throttle it — still within the
> `cap_promote + arrivalsPerRound` bound. Both regimes are pinned (moderate ≤ cap; storm overshoot
> > cap, ≤ cap + one round) so the behavior stays visible rather than silently passing. (Evidence:
> `scenarios.ts` cold-start-storm & tail-rotation reports, `scenarios.spec.ts`, `walk-metrics.ts`,
> `sweep.ts` `d_max_cap` rows.)

> **Simulator scenarios.** The end-to-end claims above are also exercised by the simulator's
> scenario runner (`packages/substrate-simulator`, `scenarios.ts`) — the **cold-start storm**
> (cumulative tier-0 acceptance ≤ `cap_promote` + one round of arrivals, walks fan, promotion fires,
> lookup is `O(log N)`), the
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
- **Per-cohort topic budget.** A cohort holds at most `topics_max` (default 2048) topics with forwarder state. When the budget is exhausted, new topic instantiations are refused with `UnwillingCohort`; existing topics continue. Eviction within the budget is LRU by participant count; topics with zero recent registrations are dropped first. Evicting a topic also tears down its cold-start forwarder and traffic window (via the budget's `onEvict` hook), so the served-topic set stays bounded by the budget — otherwise the leftover forwarder would keep the cohort serving the topic with no budget slot.
- **Signed registrations.** Every `RegisterV1` carries a `correlationId` (16 random bytes) and a signature from the participant's peer key over `(topicId, tier, correlationId, timestamp)`. Stale-timestamp or replayed-correlationId messages are dropped. The replay guard's remembered-id map carries a hard `maxKeys` LRU cap (default 100 000, like the rate limiter), evicting the oldest-inserted — i.e. nearest-to-stale — id when full, so a flood of fresh admitted ids cannot grow it without bound. The register pipeline runs the rate limiter **before** the replay guard records anything, so a frame the rate limiter sheds inserts no `correlationId` and cannot drive replay-guard memory at attack speed.
- **Cold-start requires evidence (bootstrap *and* follow-on).** A cold cohort accepting a cold-start register requires the registration to carry one of: a small proof-of-work, a signature from a peer with a sufficient reputation score ([architecture.md](architecture.md) §Reputation), or a signed reference to a parent topic that does exist. This gate fires on **both** cold-start flags: a `bootstrap: true` root register *and* a `followOn: true` deeper-tier register (the redirect-target instantiation) are gated identically — a follow-on is participant-asserted on the wire (the cold child cannot infer it; §Cold-start instantiation), so its safety rests on paying the same anti-abuse cost, not on provenance. Specifics depend on the application's tier — T0/T1 topics generally don't need PoW because they correspond to committed work; T2/T3 topics do. The evidence rides in a **dedicated, signature-covered** `RegisterV1.bootstrapEvidence` field — a versioned `BootstrapEvidenceEnvelopeV1` (`{ v, pow?, parentRef?, reputation? }`), base64url-encoded — **not** in the opaque `appPayload` slot (which the cohort copies verbatim into the registration's `appState` and replicates cluster-wide; overloading it would displace the real appState on the very register that needs it). Every kind binds the same canonical `(topicId, tier, participantCoord, timestamp)` tuple so a captured proof cannot be replayed for a different topic, tier, peer, or (within the replay window) time. The envelope format and the PoW preimage/difficulty are db-core (`antidos/bootstrap-evidence-envelope.ts`, crypto-free); the actual hashing and signature checks are db-p2p-injected.

> **Follow-on hardening (deferred, tripwire — not a queued ticket).** PoW-gating a follow-on makes a
> redirect-target cold-start exactly as costly as a root bootstrap, which is sufficient today. It is
> *not* proof the participant was genuinely redirected — a peer that pays the PoW can instantiate a
> tier-`(d+1)` child for a topic whose parent never promoted. If spoofed, PoW-paid follow-on
> instantiation ever shows up as real abuse, upgrade to a **parent-vouched** redirect: echo the parent
> cohort's threshold-signed `PromotionNoticeV1` on the follow-on register and verify it against the
> parent cohort's `MembershipCertV1` on the child's admission path (a new `RegisterReplyV1` field to
> carry the notice + an admission-path membership verify). The natural voucher already exists (the
> parent's `PromotionNoticeV1`), so the upgrade path is clean. Tagged `NOTE:` at
> `antidos/bootstrap-evidence.ts`.

The layer does not attempt to defend against unbounded Sybil attacks at the registration level; those are FRET's and the reputation subsystem's concern.

> **Implementation.** The four anti-DoS defenses live in
> [`packages/db-core/src/cohort-topic/antidos/`](../packages/db-core/src/cohort-topic/antidos) as
> transport-agnostic db-core logic: `RegisterRateLimiter` (sliding-window per `(peer, topic)`,
> exponential `retryAfter` via the §Willingness back-off curve; its key map is memory-bounded by a hard
> LRU cap that evicts the least-recently-checked keys — an active source stays hot, so its back-off is
> never reset — plus an idle-TTL `sweep` driven on the gossip cadence so departed peers' keys are
> reclaimed), `TopicBudget` (LRU by participant
> count, zero-participant topics evicted first; populated topics never evicted for a new
> instantiation), `CorrelationReplayGuard` (drops stale/future timestamps and replayed
> `correlationId`s, remembering ids for one `maxAge` window; its map is memory-bounded by a hard
> `maxKeys` LRU cap that evicts the oldest-inserted — nearest-to-stale — id, and the register
> pipeline rate-checks before recording so a shed frame stores no id), and `BootstrapEvidence` (tier policy
> over injected PoW / reputation / parent-reference verifiers — db-core never embeds a specific
> PoW or reputation scheme). `register_rate_per_peer = 4/min` and `topics_max = 2048` are the
> simulator-confirmed §Configuration defaults. Specs: `antidos.spec.ts`.
>
> The db-p2p host wires these into each live cohort
> ([`host.ts`](../packages/db-p2p/src/cohort-topic/host.ts)): the rate limiter, replay guard, and topic
> budget are **per-`CoordEngine`** (they key on `(peer, topic)` / per-cohort topic state, which is
> coord-scoped, so each served coord gets an independent set), while the `BootstrapEvidence` policy is
> **node-level** (a tier→verifier policy with no per-coord state) and shared. The guard is verified first
> on the inbound register so a forged/replayed/over-rate frame never pollutes downstream state. Wrapping all
> of these is a host-level bound on the *number* of `CoordEngine`s: the served coord is a hash over
> attacker-chosen inputs and an engine is created **before** its per-coord guards run, so the registry is
> hard-capped (`coordEnginesMax`, default 2048) with LRU eviction of idle engines (no records, no cold-start
> forwarder) — one peer spraying distinct coords can no longer force unbounded engine allocation. Because
> db-core embeds no PoW/reputation scheme, the host supplies the verifiers
> ([`bootstrap-evidence-verifiers.ts`](../packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts))
> and the participant-side minter
> ([`bootstrap-evidence-builder.ts`](../packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts)),
> reading the signed `BootstrapEvidenceEnvelopeV1`:
>
> - **Proof-of-work (real, T2/T3).** `verifyPoW` hashes `RingHash.H(powPreimage(reg, nonce))` and checks
>   it against `meetsDifficulty(·, powDifficultyBits)` — self-contained, one hash, bound to
>   `(topicId, tier, participantCoord, timestamp)` so a PoW minted for one topic/peer/time cannot
>   bootstrap another. The participant builder mints it (nonce search ≈ `2^bits` hashes; capped so the
>   register path never hangs). Whenever the gate is *configured*, this real PoW path runs (no longer a
>   fail-closed deny).
> - **Reputation endorsement (real verifier, T2/T3).** `verifyReputation` checks a *referee* peer-key
>   signature over the bound image **and** that the referee is sufficiently reputable in the node's local
>   `PeerReputationService` view (not banned **and** `getScore < deprioritize`, stronger than mere
>   non-ban). The referee MAY equal the participant (a reputable participant self-vouches).
>   `libp2p-node-base.ts` wires the node's reputation service in as the production backing. The
>   participant-side *minting* of an endorsement is not wired into the host yet (the builder exposes an
>   `endorse` self-vouch seam) — so today an endorsement is supplied cohort-side (tests) or by a future
>   originator, not auto-minted on every register.
> - **Parent reference (real, all tiers — the only T0/T1 evidence).** `verifyParentReference`
>   ([`bootstrap-parent-reference.ts`](../packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts))
>   accepts a `parentRef = { parentTopicId, sig }` only when **both** (1) the participant peer-key-signed
>   the `parentRefSigningImage` — the bound tuple extended with `parentTopicId` (domain-separated by a
>   distinct tag), so a reference minted for one `(topic, tier, peer, time, parent)` cannot be lifted onto
>   another register — **and** (2) the parent topic exists in locally-available committed/membership state,
>   via a **synchronous** injectable `BootstrapParentTopicView` (an admission gate never dials —
>   `createDefaultParentTopicView` reads only the in-memory caches the node already holds). A
>   self-referential `parentTopicId == topicId` is rejected. The view is tier-routed like the membership
>   source: **T2/T3** consult the FRET membership cache (`FretMembershipSource.has(coord_0(parentTopicId))`
>   — a cached `MembershipCertV1` means a cohort genuinely serves the parent); **T0/T1** consult the
>   committed backing and the verifier **fails closed without one** (a FRET-cached cert must not vouch for
>   committed-tier existence — committed-tier integrity). **Limitation (interim):** no coord-keyed
>   committed-membership index exists yet (the tx-log commit certificate is keyed by action, not by
>   `coord_0`), so a node wires no committed reader today and the T0/T1 existence check would fail closed for
>   *every* parent. Because a brand-new root has no parent to reference, routing T0/T1 through that
>   fail-closed verifier would make cold-root **origination** impossible
>   (`cohort-topic-bootstrap-coldstart-origination-regression`). The host policy therefore keeps T0/T1
>   **permissive-but-logged** while no committed backing is wired (an explicit `antiDos.parentTopicView` or a
>   future `committedParentTopicReader`), and runs the real fail-closed verifier at T0/T1 only once such a
>   backing exists; T2/T3 parent-ref is fully real throughout.
>   A node admits a parent-ref only for a parent it has *locally cached* — acceptable for a gate
>   (fail-closed when unknown → the participant retries / uses PoW for T2/T3; a genuinely-new committed
>   T0/T1 topic is bootstrapped by nodes already serving the parent's committed work, which hold its cert).
>   A *richer* check — that the parent's commit certificate names *this* child topic — is the follow-on
>   `cohort-topic-parent-ref-tx-log-content`.
>
> Once any reputation view or explicit verifier is configured, an unfilled verifier fails **closed** so a
> banned/low-rep referee cannot slip the T2/T3 `PoW || reputation || parent-ref` disjunction — **except**
> that T0/T1 stays **permissive-but-logged** until a committed backing is wired (above), so cold-root
> origination is not blocked. An *entirely unconfigured* host stays permissive-but-logged at every tier (a
> one-time warning, never an undefined gate), preserving the db-core/mock-tier flows that bootstrap tier-0
> without evidence. Specs:
> `host-antidos-coldstart.spec.ts`, `bootstrap-evidence-verifiers.spec.ts`.
>
> **Promote-handler gate (`promote` protocol, not registration).** The four defenses above guard the
> *register* path; the inbound `promote`-notice handler (§Promotion and demotion lifecycle) reuses the
> same primitives against verify/refetch amplification: a **node-level** `RegisterRateLimiter` keyed on
> `(peer, topicId)` sheds an over-rate peer before the `findServing` scan, a per-`(topic, tier)`
> `effectiveAt` high-water drops replays before the signature verify, and the verify passes a 60 s
> per-coord refetch bound (`PROMOTE_REFETCH_MIN_INTERVAL_MS`) so a flood drives a *bounded* membership
> refetch rate rather than one dial per frame. Both maps are bounded for a long-lived node
> (`cohort-topic-promote-gate-map-eviction`): the limiter — the attacker-growable one, since the rate
> check runs before `findServing` so a forged notice for an unserved `topicId` still allocates a
> `(peer, topic)` entry — carries the register-path limiter's inline `maxKeys` LRU hard cap plus an
> idle-TTL `sweep` driven on the host's gossip cadence; the high-water is an `LruMap` capped at
> `PROMOTE_HIGHWATER_MAX_KEYS = 8192` and is written **only** on a verified `applied` outcome (so it
> is *not* attacker-growable and never evicts under legitimate load). Evicting a high-water entry is
> safe: the high-water is a strictly-weaker early-drop optimization, not the idempotency authority —
> the engine's `PromotionLifecycle` is independently idempotent and `effectiveAt`-ordered
> (`PromotionState.lastEffectiveAt`), so an evicted-then-replayed stale notice re-verifies once (itself
> rate-capped) and then no-ops at the engine rather than (re-)applying.

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

The substrate is validated at three tiers (unit + mock-tier-at-scale + real-libp2p). The participant ↔
cohort composition is unit-tested with a
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

**Mock-tier e2e at scale.** The live-tier machinery is extracted into a reusable harness
([`packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts`](../packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts))
that stands up production-shaped cohorts (`k = 16`, `minSigs = 14`) inside 48–64-node rings, and the
at-scale suites
([`cohort-topic-scale-lifecycle.spec.ts`](../packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts),
[`cohort-topic-scale-antiflood.spec.ts`](../packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts))
assert the **behavioral disciplines** the design specifies on the real `CohortMemberEngine` over the
real FRET-routed cohort — driven by an explicit virtual clock (no wall-clock sleeps), deterministic
across runs. Mapped, passing claims: register / `ttl/3` renewal / TTL eviction (§TTL and renewal);
per-tier willingness admission gating (§Willingness — Edge refuses T3, Core admits); promotion firing
at `cap_promote` + `Promoted(d+1)` redirect, sticky no-flap within `T_promote_sticky` (claim 5), and
root-never-demote (§Promotion and demotion lifecycle); crash failover via signed `reattach` + the
epoch-scoped override (§Failure modes); gossip record replication + eviction convergence across the
whole `k`-member cohort; the §Anti-flood walk disciplines on real walks via the same predicates the
simulator uses (`outwardMovesArePromoted` / `inwardStepsFollowNoState` / `retriesRestartAtDMax` —
claims 1 *discipline*, 3, 4), the claim-2 `RejoinJitter` rate bound, and the §Anti-DoS per-peer rate
limit, topic-budget refusal, and `bootstrap: true` root instantiation.

> **Doc expectations tagged `it.skip([… DOC EXPECTATION NOT YET IMPLEMENTED …])` at this tier** (named,
> not omitted — each cites its parking ticket):
> - the §Anti-flood **claim-1 *fan*** (distinct `coord_{d_max}` per participant, ≈ subscriber count):
>   the wire carries `participantCoord` as the **dialable peer-id**, and every Ed25519 libp2p id
>   base58-encodes to a constant `"12D3KooW…"` prefix, so `prefix(P, d·log₂F)` is identical across
>   participants and `coord_d` for `d ≥ 1` **collapses to one coordinate** instead of fanning. The
>   single-direction walk *discipline* (probe `d_max` first, inward-only-on-`no_state`, no speculative
>   outward) IS asserted on the real engine; the fan awaits the routing-key/signer-id reconciliation in
>   `cohort-topic-participant-coord-routing-key-mismatch` (see §Wire formats "Tier-0 caveat"). The fan
>   itself is simulator-validated against the uniform ring coord (`scenarios.ts` cold-start-storm).
> - **multi-tier tree growth / depth law** `⌈log_F(N/cap_promote)⌉` over a live walk: `followOn` cold-start
>   derivation (`cohort-topic-followon-derivation`), the parent-side child recording
>   (`cohort-topic-parent-child-link` — the signed `ChildLinkV1`, verify, and per-engine `childCohortCount`),
>   and the **cohort-wide convergence + unlink** of that count (`cohort-topic-child-link-replicate-unlink`)
>   have all landed. A `Promoted`-redirect follow-on instantiates a cold tier-`(d+1)` child, which links to
>   its parent; the routed parent member records it, gossips a `childLinks` delta, and every parent member
>   converges on the same child **union** (`childCohortCount` consistent cohort-wide, not a single-member
>   shard). The remaining gap for a full **depth-law e2e over a live walk** is only the live multi-tier mesh
>   instantiation (driving real promotion past `cap_promote` so a real tier-1 child completes a live-key
>   child-link RPC) — not reliably driveable in the mock mesh (the routed member often cannot yet resolve the
>   child cohort cert), so it is deferred to the real-libp2p tier / CI. The depth law itself is
>   simulator-owned (`promotion-convergence.ts`).
> - **tier-(d>0) demotion-notice broadcast**: the parent-side `childCohortCount` blocks demotion while a
>   child is linked (cohort-wide, converged via gossip), and the demotion notice fanned to the parent coord
>   **unlinks** the child so the count falls and the parent can shrink in turn
>   (`cohort-topic-child-link-replicate-unlink`). The parent-unlink (verify against the child cohort cert →
>   `unrecordChild`), the dual-role node, the forged-rejected, and the high-water-independence cases are
>   unit-covered (`promote-notice.spec.ts`); the two-member child-union + unlink convergence is covered by
>   `gossip-cadence.spec.ts`. Promotion/demotion hysteresis is unit-covered by `promotion.spec.ts`.
> - **membership-rotation primary handoff** (inventory → pull → dual-serve → ack): `registration/handoff.ts`
>   is unit-tested in db-core but not yet wired into the FRET host, so there is no host-level rotation to
>   observe (crash failover is the wired failover path).

**Real-libp2p e2e (socket tier).** [`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`](../packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts)
(env-gated on `OPTIMYSTIC_INTEGRATION=1` / `RUN_LONG_TESTS=1`) stands up 3–16 production
`createLibp2pNode({ cohortTopic: { enabled: true } })` nodes over **real TCP** and exercises the piece the
mock mesh stubs — real FRET two-sided stabilization, the `/sign` threshold collection, the `/membership`
serve+fetch, and `/cohort-gossip` replication — at `wantK = N`. Mapped, passing claims (validated at
N ∈ {3,4,8,16}): real FRET assembles the whole-mesh tier-0 cohort with **one identical coord + epoch on
every node** (§Cohort assembly — the determinism threshold signing depends on); a routed primary collects a
genuine `(N−1)`-of-`N` `MembershipCertV1` over `/sign` and a remote participant verifies it end-to-end over
`/membership`, including the **stale-cache one-fetch-and-retry** (§Membership fetch); a touched record
replicates into a sibling store over `/cohort-gossip` (§Registration mechanics) with the sibling becoming a
warm-failover target.

> **Real-network observations (vs. the simulator / mock tier).**
> - **Confirmed on real libp2p:** small-N stabilization + threshold-cert assembly is bounded and fast — the
>   full suite (mesh bring-up + FRET stabilization + cert publish + all assertions) runs ~2 s at N = 4,
>   ~4 s at N = 8, ~11 s at N = 16. Coord/epoch determinism and the membership-verify quorum behave exactly
>   as the mock tier and simulator predict; the stale-cert refetch resolves in a single `/membership` round-trip.
> - **Differs from the mock tier (a real-transport finding):** the `/sign` threshold collection assumes
>   **warm connectivity to the whole cohort**. The mock tier routes in-process (connection warmth is a
>   non-issue), but over real TCP a star topology (leaf→bootstrap only) intermittently gathered `< minSigs`
>   because leaf↔leaf `/sign` dials resolved cold; the suite establishes a full mesh of warm connections and
>   retries the publish past transient sub-quorum rounds. Operationally: a cohort that has not yet
>   inter-connected can briefly fail to reach signing quorum — recovered by connection establishment + the
>   next round, never a fabricated sub-quorum cert (the §FRET-integration sub-quorum negative still holds).
> - **`it.skip` at this tier (production wiring not yet present, not faked):** the full FRET-routed
>   participant `service.register` walk (kept mock-tier-deterministic to avoid small-N routing flakiness; the
>   cohort-side admission it drives IS asserted over the real willingness quorum), and multi-tier promotion
>   (the single-tier-0 milestone gaps above).

**Still deferred (parked in backlog, honestly out of scope for this milestone):** the parent-side
child-cohort link recording (`cohort-topic-parent-child-link`) — without which a full multi-tier
depth-law e2e over a live walk has no observable parent state to assert against.

> **Landed since:** the read-only **lookup-probe** RPC — `lookup` now drives the walk with
> `RegisterV1.probe: true`, classifying the terminal cohort and returning the same snapshot a register
> would **without admitting anything** (no soft-state record, no arrival, no promotion trigger, no
> topic-budget touch, and never a cold-start instantiation), so a lookup leaves no TTL-expiring
> registration behind. See §Lookup and §Wire formats (`RegisterV1.probe`).
>
> **Landed since:** **follow-on cold-start derivation** (`cohort-topic-followon-derivation`) — `followOn`
> is now a signed `RegisterV1` wire flag; the register walk re-issues it once at a promoted-but-cold child
> tier (instead of oscillating), the host derives `ctx.followOn` from it, and the cold child instantiates
> under the same anti-DoS evidence a `bootstrap` cold-start pays. See §Lookup, §Cold-start instantiation,
> §Anti-DoS, and §Wire formats (`RegisterV1.followOn`).
>
> **Landed since:** the immediate **withdraw tombstone** — `withdraw` now both stops the local ping loop
> AND sends a best-effort signed `RenewV1.withdraw: true` to the current primary, which evicts the record
> and gossips the eviction so the cohort frees the slot immediately rather than holding it for up to a
> full TTL. The signature (over the renew body, sibling to `reattach`) stops a third party evicting
> someone else's registration; a forged/unsigned withdraw is answered `unknown_registration` and evicts
> nothing. If the primary is unreachable the send is swallowed and TTL expiry remains the fallback. See
> §TTL and renewal and §Wire formats (`RenewV1.withdraw`, `RenewReplyV1` result `withdrawn`).

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
  followOn?:       boolean            // true on the re-issue after a Promoted redirect target answered NoState (treeTier >= 1); deeper-tier cold-start
  probe?:          boolean            // read-only lookup: classify + return the cohort snapshot, admit nothing
  appPayload?:     string             // opaque, application-defined
  bootstrapEvidence?: string          // cold-start evidence envelope, base64url (see note); on bootstrap OR followOn
  timestamp:       number             // unix ms
  correlationId:   string             // 16 bytes random
  signature:       string             // participant peer-key signature over the body (minus signature)
}
```

> **Follow-on cold-start (`followOn`).** `followOn` marks the dedicated re-issue a participant sends after
> a `Promoted(d+1)` redirect target answers `NoState` — the deeper-tier analogue of `bootstrap`, asking a
> cold tier-`(d+1)` child to instantiate (§Lookup, §Cold-start instantiation). It is **always
> `treeTier >= 1`** and **mutually exclusive** with `bootstrap` and `probe` (the walk sets at most one; the
> validator rejects a frame that sets more than one, and rejects `followOn: true` with `treeTier < 1`). It
> is **covered by `signature`** (appended to `registerSigningPayload`, normalized to `false` when absent),
> so a MITM cannot strip or flip it. Because it is participant-asserted and forgeable, a `followOn`
> cold-start is evidence-gated identically to a `bootstrap` cold-start — it carries the same
> `bootstrapEvidence` and pays the same anti-DoS cost (§Anti-DoS). The db-p2p host derives
> `ctx.followOn = reg.followOn === true` in `dispatchRegister`.
>
> **Bootstrap / follow-on evidence.** `bootstrapEvidence` is a **dedicated, signed** field (not `appPayload`) carrying
> the cold-start anti-DoS proof a cold cohort demands when `bootstrap: true` **or** `followOn: true` (§Anti-DoS). It is the base64url
> encoding of a versioned `BootstrapEvidenceEnvelopeV1` — `{ v: 1, pow?: { nonce }, parentRef?:
> { parentTopicId, sig }, reputation?: { referee, sig } }`, each kind's bytes base64url — and is **covered
> by `signature`** (a fixed slot in `registerSigningPayload`, normalized to `null` when absent, with an
> empty string treated as absent), so a MITM cannot strip or swap it and the cohort never stores it as
> appState. PoW binds `hash(boundImage ‖ nonce)` having ≥ difficulty leading zero bits; `parentRef` /
> `reputation` sign the bound image directly. The bound image is the canonical tuple
> `["BootstrapEvidenceV1", topicId, tier, participantCoord, timestamp]` (UTF-8 JSON array), so evidence is
> non-replayable across topic / tier / peer / time. The envelope + bound image + PoW preimage/difficulty
> are crypto-free db-core (`antidos/bootstrap-evidence-envelope.ts`); db-p2p binds the hashing and the
> PoW / reputation / parent-reference verifiers.

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
>
> **Privileged-path freshness (anti-replay).** The signature binds `timestamp` (`renewSigningPayload`),
> so a captured `withdraw`/`reattach` frame can only be replayed byte-for-byte — never re-stamped fresher.
> Both privileged paths therefore also run a freshness gate (`isFreshPrivileged` in `renewal.ts`) that
> rejects a `timestamp` that is stale (older than `now − maxAgeMs`), implausibly future (newer than
> `now + maxFutureSkewMs`), or not strictly newer than the record's `lastPing`. The monotonic
> `timestamp <= lastPing` check closes a fast in-window replay against the live record — e.g. a `withdraw`
> captured before the record TTL-expired and re-registered, replayed to evict the *fresh* record. A rejected
> frame returns the same opaque answer as a forged one (`unknown_registration` / `primary_moved`), leaking
> nothing. The window reuses the register path's replay-guard config (`ctx.antiDos.replayGuard`), so tuning
> the skew window moves both paths together. Plain pings are **not** gated (a replayed ping only re-touches
> `lastPing`). See the fix ticket `cohort-topic-renew-freshness-replay`.

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

### Child link

Sent by a freshly cold-started tier-`d` (`d ≥ 1`) forwarder to its tier-`(d−1)` parent cohort, routed the
same way a participant register is (`routeAndAct` to the parent coord). The parent authenticates + records
the child (§Cold-start instantiation), so the parent's `childCohortCount` reflects a real child rather than
a placeholder.

```
interface ChildLinkV1 {
  v:                     1
  topicId:               string     // 32 bytes
  childCohortCoord:      string     // 32 bytes — the child cohort's served coord coord_d(childParticipantCoord, topicId); the verify key
  childParticipantCoord: string     // a representative participant coord in the child's prefix-shard (binds the parent-child pair)
  childTier:             number     // child tree tier d (≥ 1 — the root never links). Parent serves d − 1
  tier:                  number     // op capacity tier T0..T3
  effectiveAt:           number     // unix ms; the parent's per-child freshness/ordering key (strictly-newer wins)
  thresholdSig:          string     // child cohort threshold sig over childLinkSigningPayload (empty in key-less interim)
  signers:               string[]   // PeerIds, ≥ minSigs (empty in key-less interim)
  cohortEpoch:           string     // 32 bytes — the child cohort epoch the sig was collected under (LAST in the signing image)
}

interface ChildLinkReplyV1 {
  v:               1
  result:          "linked" | "rejected"   // linked flips the child awaiting_parent → serving
  reason?:         string                   // human-readable, optional
}
```

> **Binding + verification.** The parent recomputes `coord_childTier(childParticipantCoord, topicId)` and
> rejects unless it equals the signed `childCohortCoord`, and `coord_(childTier−1)(…)` is its own served
> coord — so an attacker cannot point the link at an unrelated parent without a `childParticipantCoord` that
> also hashes to the signed child coord (which it cannot, absent the prefix-class membership). It then
> verifies `thresholdSig` against the **child** cohort's `MembershipCertV1` (same bounded-refetch discipline
> as a promotion notice), permissive only in the key-less interim; a live parent rejects an unsigned link
> rather than silently record it. The signing image (`childLinkSigningPayload`) keeps `cohortEpoch` **last**
> so the `/sign` endorser (kind `"childlink"`) reads the embedded epoch positionally, exactly like a
> promotion / demotion notice.

### Promotion notice

```
interface PromotionNoticeV1 {
  v:               1
  topicId:         string
  fromTier:        number
  toTier:          number             // typically fromTier + 1
  cohortCoord:     string             // 32 bytes — the served coord the deciding cohort sits at (routing + verify key)
  effectiveAt:     number             // unix ms
  thresholdSig:    string             // cohort threshold sig (covers cohortCoord)
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
  parentCohortCoord: string           // 32 bytes — the tier-(d−1) parent this demotion hands off to
  cohortCoord:     string             // 32 bytes — the served coord of the DEMOTING cohort (routing + verify key)
  effectiveAt:     number
  thresholdSig:    string             // covers cohortCoord
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
    lastPing:           number        // freshness guard: the receiver ignores a stale eviction (older than the held record) so a re-registration survives
  }[]
  childLinks?: {                      // child cohorts this member recorded — converge the child SET (union)
    topicId:            string
    childCohortCoord:   string        // 32 bytes — the child cohort's served coord
    effectiveAt:        number        // convergence key: last-writer-wins per (topic, childCohortCoord)
  }[]
  childUnlinks?: {                    // child cohorts this member released (a demoted child); same key + LWW
    topicId:            string
    childCohortCoord:   string
    effectiveAt:        number
  }[]
  timestamp:          number
  signature:          string
}
```

The `records` / `evicted` deltas are how a registration replicates across the `~k` members so a
backup already holds the record when the primary fails (see §Registration record). A receiving
member merges each record last-writer-wins by `lastPing` (so a touch overwrites an older replica)
and applies evictions — an eviction deletes only when the held record is no newer than the eviction's
`lastPing`, so a stale (reordered/slow) eviction cannot delete a fresher re-registration — but **only
when the gossip's `cohortEpoch` matches its own** — a delta under a
foreign epoch belongs to a different membership snapshot (different slot assignments) and is dropped,
with the mismatch surfaced as membership drift. The implementation is the gossip bus in
[`packages/db-core/src/cohort-topic/gossip`](../packages/db-core/src/cohort-topic/gossip); the
willingness/load/`topicSummaries` fold into a per-member view the willingness, barometer, and traffic
layers read.

The `childLinks` / `childUnlinks` deltas converge the **child set** a parent cohort parents. FRET routes a
`ChildLinkV1` to a single parent member, so its recording is a shard; gossiping the link (and, on child
demotion, the unlink) replicates it to every parent member, which merges it straight into its per-engine
child registry (last-writer-wins by `effectiveAt` per `(topic, childCohortCoord)`). Unlike record deltas,
these merge **regardless of `cohortEpoch`** — the child set is keyed by child coord, not the parent's
membership snapshot, so a parent rotation does not drop it and a rotated-in member converges via gossip.
A merged delta is a direct registry write, never re-gossiped (one broadcast reaches the whole cohort). All
four delta arrays are covered by the gossip `signature`, so a MITM cannot strip or inject one.

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
the registration-record deltas the admission `onAdmit` and renewal `touch`/`evicted` hooks accumulated
since the last round into one `records`/`evicted` batch, broadcasts the signed `CohortGossipV1`, refreshes
the membership certificate (`T_membership_refresh`, self-gated), and runs the demotion check (`T_demote`,
self-gated). Idle engines (no resident topics, no deltas) build no frame and skip the broadcast. A freshly
*admitted* record is enqueued at admission time (the `onAdmit` hook), so it replicates on the next gossip
round without waiting for the participant's first renewal touch — closing the durability window between
`accept` and that first touch. The driver lives in the host
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
| `T_willingness_heartbeat` | 30 s | Slow re-broadcast interval for an idle-but-willing engine's willingness heartbeat (§Cold-start instantiation). First idle round emits immediately; a record-carrying round resets the clock. Cost/latency tradeoff: shorter converges a cold cohort faster but re-broadcasts willingness for every idle willing cohort more often. |
| `d_max_cap` | 60 | Hard cap on walk-toward-root start tier |
| `confidence_min` | 0.3 | Below this `n_est` confidence, cap `d_max` at ⌊d_max_cap/2⌋ (upper bound) |
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

### Operating envelope

> **Operating envelope (measured).** Beyond confirming each default's *value*, the design simulator's
> validity-envelope finder (`packages/substrate-simulator`, `boundary.ts` + `boundary-reference.ts` /
> `boundary-tree.ts` / `boundary-churn.ts`) measures, per load-bearing claim, the **edge** at which it
> flips pass→fail along a monotone-in-harm stress axis and the **margin** from that edge to the
> operating point the design assumes. Each margin is the principled justification for the default it
> bounds. Every edge below is re-derived from the committed simulator (`findBoundary` per axis,
> deterministic from `(seed, config)`); every cohort-topic claim sits **inside** its envelope (positive
> margin). `marginRatio` is omitted where the design assumption is 0 — the absolute margin is the
> meaningful quantity there.
>
> - **`root-not-overloaded` / depth law vs arrivals-per-gossip-round `R`** (§Why this distributes
>   naturally, §Promotion and demotion lifecycle; bounds `cap_promote`). Holds for **`R < 666`**
>   (margin **+602** to the `cap_promote = 64` reference, ≈ 10.4×). The edge is where one gossip-lagged
>   round of arrivals piles on the still-cold root before promotion cascades, dropping the tree below
>   its closed-form depth `⌈log_F(N / cap)⌉`. (N = 2,000, F = 16; `lookahead` off so the lag — and the
>   overshoot — is real.)
> - **depth law vs prefix skew `s`** (§Tier addressing, §Why this distributes naturally; bounds the
>   `sha256` sharding assumption). Holds for **`s < 0.042`** (margin **+0.042** to the
>   uniform-sharding assumption `s = 0`). This is a deliberately *thin* margin and an honest caveat:
>   concentrating only ~4% of registrations into one hot prefix shard is enough to push observed depth
>   past the law. In practice peer-ID prefixes are ~uniform, so the operating point sits at `s ≈ 0`;
>   the margin says the depth law is **not** robust to adversarial or pathological prefix concentration.
>   (N = 2,000.)
> - **promotion/demotion stability vs per-round churn `r`** (§Hysteresis, §Promotion and demotion
>   lifecycle; bounds the `4×` cap gap + `T_demote`). Holds for **`r < 0.499`** (margin **+0.499**):
>   up to ~50% of a cohort held near `cap_promote` can drain-and-refill each round before observed
>   depth oscillates. `T_demote`'s temporal hysteresis buys this margin — the boundary shortens
>   `T_demote` to one gossip round so the demotion is genuinely *reachable* inside the flap window (a
>   positive demotion-count witness), so the margin is real, not structurally zero.
> - **walk `no-give-ups` ∧ `≤ d_max + 2` hop bound vs unwilling-member fraction `f`** (§Willingness,
>   §Anti-flood properties; bounds the willingness-retry budget). Holds for **`f < 0.479`**
>   (margin **+0.479**). The binding sub-condition at the edge is the **hop bound**, not actual give-ups
>   (`unwillingBreach = hop-bound`): each unwilling member costs a sibling-retry hop, so the `d_max + 2`
>   budget is exhausted before a walk truly gives up. Up to ~48% of members replying unwilling is
>   tolerated before a landing walk breaches the bound. (N = 2,000, 100 sampled walks.)
> - **`no-lost-registrations` vs sustained member-kill rate `k`** (§Failure modes → Recovery time
>   bounds; bounds `backups_per_registration` + `ttl`). Holds for **`k < 0.249`** per renewal window
>   (margin **+0.249**), with kills staggered into the worst phase just after the renewal tick. Past
>   the edge the failure mode is **backup-exhaustion** — the cohort runs out of reachable coverage, not
>   a transient renewal race (`killMechanism = backup-exhaustion`). This is what
>   `backups_per_registration = 2` + the `ttl/3` ping cadence buys against sustained crashes.
>   (20-member cohort, 80 participants, `ttl = 90 s`.)
> - **`heal-convergence` vs partition severity `σ`** (§Failure modes → Network partition healing,
>   Recovery time bounds; bounds the one-window repoint). One-window repoint to the healed deterministic
>   primary holds for **`σ < 0.312`** (margin **+0.312**, where `σ` scales concurrent per-side
>   membership churn during the split). Just past the edge 87.5% still converge in one window and the
>   healed membership genuinely differs from the pre-split set (`healedEpoch ≠ preEpoch`), so the margin
>   is the real lazy-repoint timing, not the structurally-trivial `merge(a, b).epoch == pre.epoch`
>   identity. A participant whose served primary is *removed* by the concurrent churn must run a
>   multi-window backup-promotion failover and so misses the one-window bound. (16-member cohort, 64
>   participants.)

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
