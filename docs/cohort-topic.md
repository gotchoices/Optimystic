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

### Maximum useful depth

A participant computes an upper bound on tree depth from FRET's network-size estimate:

```
d_max = max(0, ⌊log_F(n_est)⌋ − 1)
```

At `d_max`, each tier-`d_max` cohort covers `F` peers on average — roughly one cohort's worth. Deeper would mean tier coordinates with fewer peers than a cohort, which FRET handles but provides no fan-out benefit. If `n_est` confidence falls below `confidence_min` (default 0.3), participants clamp to `d_max = ⌊d_max_cap / 2⌋` to avoid pathological deep probes.

`d_max` is recomputed lazily; participants don't need it precise.

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

### Why this distributes naturally

For a topic with `N` active participants, the tree's steady-state depth is `⌈log_F(N / cap_promote)⌉`. Three regimes:

- **Sparse** (`N ≪ cap_promote`): only the root exists. All participants register at the root. Their initial probes at `d_max` miss and walk all the way down, but each one's `coord_{d_max}` is *different* (different peer-ID prefix), so the walks fan across the ring rather than colliding.
- **Hot** (`N ≫ cap_promote`): the tree has grown to deep tiers. A participant's first probe at `d_max` hits an existing tier coordinate matching its own prefix, and registration succeeds in one or two RPCs without ever touching the root.
- **Growing/shrinking**: brief transient where probes find recently-promoted cohorts and follow `Promoted` redirects outward. Bounded by tree depth.

The root cohort sees high traffic only in the sparse regime, where it has the capacity to serve it. Under hot load, traffic is sharded across `F^{d_max}` deep cohorts. Promotion is the mechanism that moves load from concentrated to sharded; no participant ever has to guess the right tier.

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
- Three consecutive failures → participant promotes `backups[0]` to primary by sending a re-attach RPC (carries the existing record, no full re-registration). Backup verifies it sees the record in its local replica and confirms.
- All of `primary` and `backups` fail → participant re-runs the lookup from `d_max`.

Cohort members evict records where `now − lastPing > ttl`. Eviction is gossiped so all members converge on the active participant set.

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
4. The previous primary continues to serve until the new primary acknowledges receipt; this prevents a delivery gap.
5. Participants discover the new primary on their next ping (which is forwarded by the old primary) or on the next inbound delivery (which arrives from the new primary). Subscriber-side `cohortHint` is refreshed from the cohort response on either path.

The handoff is purely cohort-local; FRET is unaware of which member is primary for what.

---

## Membership snapshots and signature verification

Cohort threshold signatures are useful only if participants can verify them. The layer requires a way for any participant to obtain the authoritative membership of any cohort at any point in time.

### Membership source

Cohort memberships are anchored in the transaction log ([transactions.md](transactions.md)). Specifically:

- Each block records the cohort membership for every collection whose tail it advances. This is part of the existing commit certificate.
- The membership of *all* cohort-topic cohorts is not committed; only those that serve T0/T1 work (transaction commits, chain serving) appear in the log.
- T2/T3 cohorts (matchmaking, push forwarding) derive their membership from current FRET state. Their threshold signatures are verifiable against FRET's signed membership advertisements (the `MembershipCertV1` that FRET cohorts publish after stabilization).

### Membership fetch

A participant verifies a notification or threshold-signed message as follows:

1. Extract the signer set from the message (every threshold-signed message carries the `signers: PeerId[]` list).
2. Compute the cohort coord the signers should belong to (from the message's claimed tier/topic/coord).
3. Look up the most recent `MembershipCertV1` for that coord, cached locally or fetched from any cohort member.
4. Verify (a) the certificate is current, signed, and consistent with FRET stabilization, and (b) the signers in the message are a `≥ minSigs` subset of the certificate's members.

`MembershipCertV1` is refreshed by the cohort every `T_membership_refresh` (default 5 minutes) and on any stabilization event that changes the first `k − x` members. Participants cache the latest one they've seen per coord; verification against a slightly stale cert is acceptable as long as the cert's signers overlap with the current cohort by quorum.

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

### Hysteresis

`cap_promote` and `cap_demote` are intentionally far apart (`4×`) to prevent oscillation under bursty load. `T_demote` adds temporal hysteresis. Together they ensure a topic doesn't thrash between tree depths.

---

## Anti-flood properties

A claim of "anti-flood by construction" is only meaningful if we can name the floods the design prevents:

1. **Cold-start storm at the root.** When a popular topic first appears, all participants probe `d_max` *first*, not the root. The root sees only the tail of the walk-toward-root sequence — for a sparse topic this is the full traffic, but the topic is by definition under-loaded; for a hot topic the tree has already grown and the root is bypassed.
2. **Re-registration storm after cohort failure.** When a cohort fails, attached participants stagger re-registration with random jitter over `T_rejoin_jitter` (default 30s, scaled with cohort failure rate observed from FRET). The jitter window is set so the inbound rate at the recovering or replacement cohort doesn't exceed `cap_promote / T_rejoin_jitter`.
3. **Speculative outward probe.** Eliminated by construction: participants only move outward in response to `Promoted` from a cohort that *is* in the tree. There is no scenario where a participant tries multiple deeper coords looking for a tree edge.
4. **Inward retry storm.** A participant receiving `UnwillingCohort` waits `retryAfter` (cohort-controlled) before any retry, and retries from `d_max`, not from the same coord. This decorrelates retry traffic across the ring.
5. **Promotion feedback loop.** A cohort that has just promoted continues to receive registrations from participants in flight. Those participants are bounced with `Promoted(d+1)` — cheap, single-RPC. The cohort's promotion state is sticky for at least `T_promote_sticky` (default 60s) to avoid flapping back to accepting under transient drops.

---

## Anti-DoS

The layer relies on a small handful of structural defenses against malicious registration traffic:

- **Per-peer rate limits per cohort.** Cohort members track inbound `RegisterV1` rate per source `PeerId`. Default ceiling is 4 per minute per peer per topic at any single cohort. Exceeded → `UnwillingCohort(retryAfter)` with exponential `retryAfter`.
- **Per-cohort topic budget.** A cohort holds at most `topics_max` (default 2048) topics with forwarder state. When the budget is exhausted, new topic instantiations are refused with `UnwillingCohort`; existing topics continue. Eviction within the budget is LRU by participant count; topics with zero recent registrations are dropped first.
- **Signed registrations.** Every `RegisterV1` carries a `correlationId` (16 random bytes) and a signature from the participant's peer key over `(topicId, tier, correlationId, timestamp)`. Stale-timestamp or replayed-correlationId messages are dropped.
- **Bootstrap requires evidence.** A cold root accepting `bootstrap: true` requires the registration to carry one of: a small proof-of-work, a signature from a peer with a sufficient reputation score ([architecture.md](architecture.md) §Reputation), or a signed reference to a parent topic that does exist. Specifics depend on the application's tier — T0/T1 topics generally don't need PoW because they correspond to committed work; T2/T3 topics do.

The layer does not attempt to defend against unbounded Sybil attacks at the registration level; those are FRET's and the reputation subsystem's concern.

---

## Failure modes

### Primary fails
Participant's pings time out. After three failures, participant promotes `backups[0]` via re-attach RPC. The backup already has the registration record from cohort gossip; promotion is instant. The cohort gossips the new assignment and refreshes the deterministic primary calculation on the next stabilization round.

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

---

## FRET integration

### Protocol IDs

```
/optimystic/cohort-topic/1.0.0/register       — Register, renew, re-attach
/optimystic/cohort-topic/1.0.0/cohort-gossip  — Registration replication, willingness vectors, load barometers
/optimystic/cohort-topic/1.0.0/promote        — Threshold-signed promotion / demotion notices
/optimystic/cohort-topic/1.0.0/membership     — Membership certificates
```

Application-specific protocols (notification delivery for reactivity, query for matchmaking, etc.) live under their own subsystem prefix and reuse only the cohort identity and primary/backup assignment from this layer.

### RouteAndMaybeAct usage

Registration uses FRET's `RouteAndMaybeAct` pipeline directly:

- `key` = `coord_d(self, topicId)`
- `activity` = serialized `RegisterV1`
- `wantK` = configured cohort size `k` (default 16)
- `minSigs` = threshold `k − x` (default 14) — used only for promotion/demotion responses
- Acceptance / redirect / willingness response runs inside the cohort's activity callback

Post-registration traffic (pings, application-specific RPCs) uses direct dialing to the cached `primary` and falls back to `RouteAndMaybeAct` only when the primary is unreachable.

### Cohort assembly

The layer uses FRET's two-sided cohort assembly without modification: alternating successor/predecessor walk, automatic adaptation when `n < k`, threshold signatures via `minSigs = k − x`. The cohort at any given `coord_d` is whichever set of `k` peers FRET names.

---

## Wire formats

All messages are JSON, length-prefixed UTF-8, with byte fields encoded as base64url.

### Register

```
interface RegisterV1 {
  v:               1
  topicId:         string             // 32 bytes
  tier:            number             // 0..3
  treeTier:        number             // current walk position d
  participantCoord: string            // participant's ring coord, 32 bytes
  ttl:             number             // ms, default 90000
  bootstrap?:      boolean            // true on root cold-start request
  appPayload?:     string             // opaque, application-defined
  timestamp:       number             // unix ms
  correlationId:   string             // 16 bytes random
  signature:       string             // participant peer key
}

interface RegisterReplyV1 {
  v:               1
  result:          "accepted" | "no_state" | "promoted" | "unwilling_member" | "unwilling_cohort"
  // accepted:
  primary?:        string             // PeerId
  backups?:        string[]           // PeerIds, 1-2
  cohortEpoch?:    string             // 32 bytes
  cohortMembers?:  string[]           // PeerIds, full cohort, for client cache
  // promoted:
  targetTier?:     number             // d+1 typically; may leap
  // unwilling_member:
  candidateMembers?: string[]         // PeerIds within same cohort to try
  // unwilling_cohort:
  retryAfterMs?:   number
  reason?:         string             // human-readable, optional
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
  signature:       string
}

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
  cohortEpoch:        string
  willingnessBits:    string          // 4 bits T0..T3, hex
  loadBuckets:        number[]        // 4 entries, 0..7 per tier
  topicSummaries: {
    topicId:            string
    tier:               number
    directParticipants: number        // exact, gossiped privately within cohort
    promoted:           boolean
    childCohortCount:   number
  }[]
  timestamp:          number
  signature:          string
}
```

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
  fretAttestation: string             // optional FRET-provided proof of stabilization
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
| `confidence_min` | 0.3 | Below this `n_est` confidence, halve `d_max` |
| `topics_max` | 2048 | Max topics with forwarder state per cohort |
| `backups_per_registration` | 2 | Warm-failover cohort members per registration |
| `register_rate_per_peer` | 4 / min | Per-peer-per-topic rate limit at a single cohort |

### Per-tier overrides

Edge nodes (mobile profile) default to:

- `ttl` = 60 s
- `ping_interval` = 20 s
- T2 and T3 willingness bits permanently off
- Backups sticky-cached across reconnects to avoid re-walk on flap

---

## Application policies

The cohort-topic layer is a substrate. An application — reactivity, matchmaking, voting, broadcast — implements:

1. **Anchor derivation.** What `topicId` is and whether it rotates. Reactivity uses `H(tailId ‖ "push")` (rotates); matchmaking uses `H("match" ‖ taskId)` (stable).
2. **`appPayload` contents.** What's in the per-registration application slot.
3. **Tier choice.** Which tier this application operates at (reactivity push is T3; reactivity replay is T1; matchmaking is T2; voting is T2).
4. **Post-registration RPCs.** Notification delivery, query, voting protocols, etc. These run between participants and their cached `primary`, with the cohort-topic layer providing only the identity.
5. **Replay or caching.** If the application needs durable buffering (reactivity does, matchmaking generally doesn't), it manages that state inside the cohort using the layer's existing gossip channel.
6. **Anchor rotation handling.** If the anchor changes (tail rotation), the application detects via its own logic and re-registers under the new `topicId`; the layer treats the new anchor as a new topic.

The layer's contract to applications is: given a `topicId` and a `tier`, you will reliably find a willing primary (or fail with a clear back-off signal); registrations persist within their TTL; cohort identity and membership are verifiable. Everything else — content, ordering, durability, semantics — is the application's responsibility.

---

## Interaction with other subsystems

- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — provides ring coordinates, cohort assembly, `RouteAndMaybeAct`, stabilization, network-size estimation, and membership advertisements.
- **Transaction log** ([transactions.md](transactions.md)) — T0/T1 cohort memberships are committed as part of normal block production. The layer reads these but never writes.
- **Reactivity** ([reactivity.md](reactivity.md)) — push-tree application; uses rotating anchors and replay buffers on top of this layer.
- **Matchmaking** ([matchmaking.md](matchmaking.md)) — directory application; stable anchors, provider/seeker registrations.
- **Partition healing** ([partition-healing.md](partition-healing.md)) — cohort merge after partition is handled by FRET stabilization; the layer reacts via `cohortEpoch` refresh.
- **Reputation** (see [architecture.md](architecture.md)) — bootstrap-time evidence for cold root instantiation may reference reputation scores; persistent `UnwillingCohort` from a cohort known to be honest is also a signal the reputation subsystem may consume.
