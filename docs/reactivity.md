# Reactivity

Change-notification subscriptions for Optimystic collections, designed for high subscriber counts on mobile devices and layered on the FRET ring overlay. See [matchmaking.md](matchmaking.md) for the rendezvous concept this design extends, [fret.md](../../Fret/docs/fret.md) for the underlying ring overlay, and [transactions.md](transactions.md) for the transaction log that drives notifications.

---

## Overview

Reactivity gives clients a push-based signal when a collection's state changes, without forcing them to poll the chain. A subscriber expresses interest in a collection; some time later, when the collection commits a transaction, the subscriber receives a small notification carrying the new revision. The subscriber then decides whether to read the new state, fetch a delta, or ignore.

The system is hint-only. The transaction log remains the sole authority for collection state. Notifications can be delayed, duplicated, or (rarely) lost without compromising correctness — they exist purely to avoid wasted bandwidth and battery on idle clients.

Reactivity scales by building a fan-out tree over rendezvous coordinates derived deterministically from the collection's current tail block and the subscriber's own ring coordinate. Each tree node is a FRET cohort (~16–20 peers), so the tree survives individual peer churn without reconfiguration. Subscribers far apart in the ring meet only near the source; subscribers near each other share intermediate forwarders. As subscriber population grows, the tree deepens automatically; as it shrinks, intermediate cohorts demote and the tree contracts.

---

## Goals and non-goals

### Goals
- Push-based change delivery with minimal mobile bandwidth and CPU.
- Scale from 1 subscriber to millions per collection without redesign.
- Survive 20%-scale cohort churn without losing subscriptions.
- End-to-end authentic notifications (no per-hop trust required).
- Mobile-friendly wake/resume: subscribers backfill missed events in one round trip when within the replay window.
- No long-term hotspots: the rendezvous root rotates with tail block churn so no specific cohort becomes a permanent attack target.

### Non-goals
- Ordering guarantees beyond per-collection revision monotonicity.
- Exactly-once delivery (subscribers dedupe by revision).
- Cross-collection joins or filtered subscriptions (the subscriber re-reads the collection if it cares about specific fields).
- Authority over collection state — that is owned by the transaction log.

---

## Concepts

- **Collection** — the unit of subscription. Identified by a stable `collectionId` (the genesis block hash) for topic identity, separately from its current tail.
- **Tail block** — the latest committed block in the collection's chain. Tail rotates when a block fills (default: every 64 transactions). Its block ID `tailId` provides the *source coordinate* for the rendezvous tree.
- **Source coordinate** `coord_T` — the FRET ring coordinate of the current tail block, `SHA-256(tailId)` truncated to B = 256 bits.
- **Subscriber coordinate** `coord_S` — the subscriber's own ring coordinate.
- **Rendezvous coordinate** `coord_L(S, T)` — a coordinate derived by bit-shifting between `coord_T` and `coord_S` (see Coordinate Derivation).
- **Cohort** — the FRET two-sided cohort of size k around a coordinate. A cohort is the unit of forwarder identity: ~16 peers with quorum-signed actions.
- **Forwarder cohort** — a cohort actively relaying notifications for one or more collections.
- **Tail cohort** — the cohort at `coord_T`. Originates notifications.
- **Subscription** — soft state held by 1–3 cohort members on behalf of one subscriber, refreshed by TTL pings.
- **Revision** — the monotonic per-collection sequence number stamped on each committed transaction. Used as the notification sequence number.
- **Replay window** — the most recent W revisions buffered by each forwarder cohort and the tail cohort, available for backfill on subscriber wake.

---

## Rendezvous tree

### Coordinate derivation

Rendezvous coordinates form a deterministic ladder between the source (tail) coordinate and each subscriber's coordinate. For subscriber `S` interested in collection with tail `T`:

```
coord_L(S, T) = high (B − L) bits of coord_T  ‖  low L bits of coord_S
```

- At `L = 0`: `coord_L = coord_T`. The most specific point. All subscribers agree on this single coordinate.
- At `L = B`: `coord_L = coord_S`. The least specific point relative to the source — the subscriber's own neighborhood.
- At intermediate `L`: the coordinate drifts from `T` toward `S`. The high `B − L` bits anchor it near the source; the low `L` bits position it within the subscriber's region.

Two subscribers with similar low-bit address share the same `coord_L` for sufficiently small `L`. Two subscribers far apart in ring distance diverge immediately and only converge when `L ≤ k_diff`, where `k_diff` is the bit-position of their first differing bit. This means subscribers naturally cluster at intermediate forwarders proportional to their ring proximity.

### Level selection

A subscriber chooses an initial level `L_init` from FRET's network-size estimate `n_est` and a target subscribers-per-cohort `D_target`:

```
L_init = clamp(round(log2(n_est / D_target)), L_min, L_max)
```

- `D_target` defaults to 64 (a comfortable per-cohort delivery load).
- `L_min = 0`, `L_max = B − 16` (avoid degenerate single-bit anchoring).
- If `n_est` confidence is below 0.3, `L_init` defaults conservatively to `L_max / 2`.

The subscriber walks inward (decrementing `L`) if the cohort at `coord_L` has no existing forwarder state for the collection. The cohort at level `L` either accepts the subscription (becoming or remaining a forwarder) or redirects the subscriber to `coord_(L−1)`.

### Tree topology

The tree is rooted at the tail cohort and fans outward. Each forwarder cohort knows:

- **Upward (one parent):** the level-`(L−1)` cohort it registered with. Pushes its subscriber-count gossip up; receives notifications down.
- **Downward (zero or more children):** level-`(L+1)` forwarder cohorts that registered with it, plus directly-attached subscribers.

Children are discovered by registration, not by the parent enumerating coordinates. The fan-out shape adapts to actual subscriber distribution: dense subscriber regions produce deeper subtrees; sparse regions produce direct attachment to the tail.

---

## Subscription registration

### Walk-inward

A subscriber registers with the following algorithm:

```
L = L_init
loop:
  C = coord_L(self, T)
  reply = RouteAndMaybeAct(key = C, activity = SubscribeV1{...})
  match reply:
    Accepted(cohort, primary, backups) → done
    Redirect(L_inner)                  → L = L_inner; continue
    Denied(reason)                     → backoff and retry with new L
  if L == 0 and reply == Denied        → fail
```

The cohort at each probed coordinate decides:

- **Accept** if it already serves this collection (forwarder state exists), or if its current direct-subscriber count is below `D_target`.
- **Redirect** to `L − 1` if it has no forwarder state for the collection and is unwilling to instantiate (e.g., during cold-start denial; see Promotion).
- **Deny** with `Retry-After` if rate-limited or in a partition-conservative mode.

### Subscription record

A cohort that accepts a subscription holds soft state:

```
SubscriptionRecord {
  collectionId:    bytes
  subscriberId:    PeerId
  subscriberCoord: ringCoord
  level:           uint
  primary:         PeerId            // cohort member that delivers
  backups:         PeerId[1..2]      // warm-failover cohort members
  attachedAt:      timestamp
  lastPing:        timestamp
  ttl:             duration          // default 90s
  lastDeliveredRev: revision
}
```

The record is replicated across all `~k` cohort members via standard FRET cohort gossip. Only `primary` actually delivers notifications; `backups` watch and take over on primary failure. This avoids `k`-fold delivery amplification within the cohort.

### TTL and renewal

The subscriber pings `primary` every `ttl / 3` (default 30s). A successful ping refreshes `lastPing`. If three consecutive pings fail, the subscriber promotes a `backup` to primary (sending a re-attach RPC) and resumes. If all of `primary` and `backups` fail, the subscriber re-runs the walk-inward registration.

Cohort members evict records where `now − lastPing > ttl`. The cohort gossips eviction so all members agree on the active subscriber set.

### Subscriber-side state

A subscriber holds, per active subscription:

```
ActiveSubscription {
  collectionId:    bytes
  level:           uint              // current registration level
  primary:         PeerId
  backups:         PeerId[]
  cohortHint:      PeerId[]          // small set for fast re-attach
  lastRevision:    revision
  attachedAt:      timestamp
  cohortEpoch:     bytes             // tail block ID at registration time
}
```

`cohortEpoch` lets the subscriber detect tail rotation: if a notification arrives stamped with a tail ID different from `cohortEpoch`, the subscriber knows the tree root has moved and re-registers at the new tail.

---

## Cohort responsibilities

### Forwarder state

A forwarder cohort holds, per collection it serves:

```
ForwarderState {
  collectionId:     bytes
  tailIdAtJoin:     bytes             // for rotation detection
  parentCohort:     CohortRef         // level (L-1) cohort
  parentLevel:      uint
  childCohorts:     CohortRef[]       // level (L+1) cohorts registered with us
  directSubscribers: SubscriptionRecord[]
  subscriberCountBucket: uint         // log-bucketed coarse count for gossip
  replayBuffer:     RevisionEntry[W]  // ring buffer, default W = 256
  lastRevision:     revision
  threshold:        thresholdSigParams
}
```

`childCohorts` and `directSubscribers` are the two delivery paths. On notification, the cohort's primary forwards to every entry in both lists.

### Primary and backup selection

Within the cohort of `~k` members, primary assignment for each subscriber is a deterministic hash:

```
primary(subscriberId, cohortMembers) = cohortMembers[ H(subscriberId) mod len(cohortMembers) ]
backups(subscriberId, cohortMembers) = next 2 entries in the same hash ordering
```

This shards delivery load roughly evenly across the cohort. When cohort membership changes (FRET stabilization), primary may move; the cohort gossips the new assignment and the new primary takes over silently. Subscribers learn of changes via the next notification (which arrives from the new primary) or via heartbeat refresh.

### Subscriber-count gossip

Cohort members exchange a coarse subscriber count using log buckets:

```
bucket(n) = floor(log2(n + 1))   // 0, 1, 2-3, 4-7, 8-15, 16-31, ...
```

Five bits suffice. The bucketed count is included in every cohort heartbeat and in upward registrations to the parent. A parent cohort uses the sum of child buckets and its own direct-subscriber bucket to decide promotion and demotion.

### Promotion (cohort grows)

A cohort promotes when its direct-subscriber bucket exceeds `bucket_promote` (default = bucket(`D_target`)). Promotion means: stop accepting new direct subscriptions; redirect new subscribers outward to `L + 1`. Existing subscribers remain attached. As they renew, they may be migrated outward in batches if the load remains high.

A cold cohort instantiates as a forwarder when:

- It receives the first subscription registration for a collection it does not yet serve, AND
- The walk-inward path indicates this is the chosen level (the subscriber's `L` is the current level).

The newly-instantiated forwarder immediately registers up to its parent (`L − 1`).

### Demotion (cohort shrinks)

A cohort demotes when its total subscriber count (direct + sum of children) falls below `bucket_demote` (default = bucket(`D_target / 4`)) for at least `T_demote` (default 5 minutes). Demotion is a single cohort decision, threshold-signed by the cohort to prevent demote races:

1. Cohort members reach quorum that demotion is appropriate.
2. A threshold-signed `DemoteNotice` is sent to all direct subscribers and child cohorts.
3. Recipients re-register at level `L − 1` (closer to source).
4. After all recipients ack or TTL expires, the cohort tells its parent to drop it from `childCohorts`.
5. Forwarder state is released.

The hysteresis (`bucket_promote` vs `bucket_demote`, plus `T_demote`) prevents oscillation under bursty subscribe/unsubscribe.

---

## Notification flow

### Origination

When the tail cohort commits a transaction, it produces a notification:

```
NotificationV1 {
  v:            1
  collectionId: bytes
  tailId:       bytes              // tail block ID at notification time
  revision:     uint64
  digest:       bytes              // small commit summary (hash of new state, op count, etc.)
  delta?:       bytes              // optional bounded delta payload
  timestamp:    int64
  sig:          thresholdSig       // tail cohort's threshold signature, minSigs = k − x
}
```

The threshold signature is the tail cohort's commit certificate (already produced by the transaction layer). Reactivity reuses it without additional cohort signing rounds.

### Propagation

The tail cohort's primary delivers the signed notification to:

- Every entry in `directSubscribers` (using each subscriber's primary assignment).
- Every entry in `childCohorts`, addressed to each child's primary.

A receiving forwarder cohort:

1. Verifies the threshold signature against the tail cohort's known membership.
2. Verifies `revision > lastRevision` for the collection (drop replays).
3. Appends to its `replayBuffer`.
4. Forwards the unmodified, unwrapped notification to its own `directSubscribers` and `childCohorts`.

Forwarders never re-sign. Subscribers verify the same end-to-end signature regardless of how many hops the notification traveled. A compromised forwarder can drop or delay messages but cannot forge them; subscribers detect drops via revision gaps and re-fetch from the replay window.

### Delivery

A subscriber receiving a notification:

1. Verifies the signature using the cached tail cohort membership.
2. Checks `revision == lastRevision + 1`. If not, requests `BackfillV1{from: lastRevision + 1, to: revision − 1}` from primary.
3. Updates `lastRevision`.
4. Surfaces the notification to the application layer.

Subscribers dedupe by `(collectionId, revision)`; duplicates from forwarder retries are discarded.

---

## Replay window

Each forwarder cohort and the tail cohort maintain a per-collection ring buffer of the last `W` notifications (default `W = 256`). The buffer is replicated across the cohort via standard FRET cohort gossip so any member can serve replay requests.

```
RevisionEntry {
  revision:  uint64
  payload:   NotificationV1     // the full signed notification
  receivedAt: timestamp
}
```

A subscriber resuming from sleep sends:

```
ResumeV1 { collectionId, fromRevision, latestKnownTailId }
```

The cohort responds with one of:

- `Backfill { entries: [...], currentRevision }` — `fromRevision` is within the window. Subscriber replays entries and is current.
- `OutOfWindow { currentTailId, currentRevision, currentMembership }` — `fromRevision` is older than the buffer. Subscriber falls back to reading the chain directly to catch up, then resubscribes.
- `TailRotated { newTailId, newRevisionAtRotation }` — the subscriber's `latestKnownTailId` is stale. Subscriber re-registers under the new tail.

`W = 256` covers roughly 4 minutes of activity at 1 commit/second per collection — long enough for typical mobile sleep gaps short of the OS killing the process.

---

## Tail rotation

Tail block ID changes when a block fills (default 64 transactions). Rotation moves `coord_T` to a new ring location, which means the entire forwarder tree is rooted somewhere new.

### Rotation protocol

When the current tail block fills and a new tail block is born:

1. **Pre-announce.** While committing the block-filling transaction, the outgoing tail cohort includes in the notification a `RotationHintV1 { newTailId, effectiveAtRevision }`. This hint reaches every active subscriber via the existing tree.

2. **Drain.** The outgoing tail cohort continues to accept notifications and serve replays for `T_drain` (default 60 seconds) after rotation. New subscriptions are rejected with a redirect to `newTailId`'s tree.

3. **Re-register.** Subscribers, on receiving the rotation hint, re-run walk-inward at the new tail. They retain their old `lastRevision` (revisions are continuous across rotations).

4. **Forwarder migration.** Forwarder cohorts under the old tail observe their direct-subscriber count dropping (subscribers re-registering elsewhere) and demote naturally per the standard demotion protocol. They do not migrate forwarder state to the new tree — re-registration rebuilds it under the new root.

5. **New tail bootstrapping.** The new tail cohort, on its first commit, may face a registration storm. It accepts the first `D_target` direct subscribers and redirects subsequent ones outward. The cold-start cost is bounded by `T_drain`: subscribers are draining from the old tree throughout, so the storm spreads over a minute rather than arriving instantly.

### Cost amortization

Block fill rate is typically minutes-to-hours for normal collections. For very busy collections, rotation may occur every few seconds — but in that regime, the per-rotation re-registration cost is a small fraction of total notification traffic. The hot-spot rotation property is the explicit goal: no single cohort is the rendezvous root for long enough to become a persistent attack target.

### Anticipatory warm-up (optional)

When a tail block is near full (e.g., > 56/64 transactions), the outgoing tail cohort may opportunistically forward subscription hints to the cohort that will own the next-tail coordinate, letting it pre-warm. This is best-effort: the next tail ID is unknown until the filling transaction commits, but the cohort can use the current cohort's own subscriber list to bias FRET pre-dialing toward likely successor regions.

---

## Authentication and integrity

- **Notifications** carry the tail cohort's threshold signature. The signature covers `(collectionId, tailId, revision, digest, delta?, timestamp)`. Subscribers verify against the tail cohort's known membership; membership is itself anchored in the transaction log (cohort changes are committed events).
- **Subscribe RPCs** are signed by the subscriber's peer key and include a fresh `correlationId` (cryptographically random) and timestamp; cohort members reject stale or replayed registrations.
- **Demote notices** carry the demoting cohort's threshold signature.
- **Rotation hints** are part of the notification payload and inherit its signature.
- **Forwarder cohorts do not re-sign.** They pass through the original threshold signature unchanged. A forwarder can drop messages (detectable by revision gap) but cannot inject or modify.
- **Replay buffer entries** retain the original signature. Backfill responses are verifiable end-to-end.

A subscriber needs no trust in any forwarder. The trust root is the tail cohort's membership, which derives from the transaction log.

---

## Failure modes

### Primary delivery member fails
The subscriber's pings to primary time out. After three failures, the subscriber promotes a backup. The backup has been gossiping with the cohort and has the current `SubscriptionRecord`, so promotion is instant from the subscriber's perspective. The new primary becomes the canonical assignment per the cohort's hash function once the cohort detects the original primary's absence via FRET stabilization.

### Cohort partition (minority loss)
FRET cohort gossip handles this: as long as a quorum of `k − x = 14` members remains reachable, the cohort continues to operate. Subscribers attached to evicted minority members reconnect via re-registration when their pings start failing.

### Cohort fully fails
Rare in a healthy network (~16-of-16 simultaneous failure). When it happens, all child subtrees and direct subscribers detect via heartbeat and re-register. Re-registrations walk inward; the parent cohort accepts increased load, possibly promoting itself outward to neighboring cohorts. The tree heals in `O(ttl)` time.

### Mobile subscriber sleep / wake
On wake, the subscriber sends `ResumeV1`. If within the replay window, it backfills and continues. If beyond, it reads the chain directly to catch up, then re-subscribes from the current revision. No tree-walk required — the resume RPC goes straight to the cached primary (or any cohort member if primary is stale).

### Tail rotation during subscriber outage
Subscriber wakes, sends `ResumeV1` with stale `latestKnownTailId`. Cohort responds `TailRotated`. Subscriber re-registers under the new tail. Lost notifications between rotation and wake are recoverable from the chain if they exceeded the replay window.

### Network partition healing
FRET surfaces partition-merge events. Reactivity treats them as no-ops at the protocol layer: forwarder cohorts on each side of the partition served their subscribers independently; on heal, FRET re-stabilization merges cohort memberships and the trees converge. A subscriber attached to a forwarder that survives the merge experiences no disruption; one attached to a forwarder that collapsed re-registers normally.

### Subscription flood (popular collection cold-start)
Tail cohort accepts the first `D_target` direct subscribers, redirects the rest outward. Outer cohorts each fill to `D_target` and redirect further. The tree forms in `O(log n)` cascade. The cohort denial protocol prevents any single cohort from being overwhelmed; the registration storm spreads spatially across the ring as it ramps temporally.

---

## FRET integration

### Protocol IDs

```
/optimystic/reactivity/1.0.0/subscribe       — Subscribe and Resume RPCs
/optimystic/reactivity/1.0.0/notify          — Notification delivery (push)
/optimystic/reactivity/1.0.0/cohort-gossip   — Subscriber-count and forwarder-state gossip
/optimystic/reactivity/1.0.0/demote          — Threshold-signed demote notice
```

### RouteAndMaybeAct usage

Subscribe registration uses FRET's `RouteAndMaybeAct` pipeline directly:

- `key` = `coord_L(self, T)`
- `activity` = serialized `SubscribeV1`
- `wantK` = cohort size for the rendezvous level
- `minSigs` = quorum required for cohort acceptance
- The cohort's activity callback runs the subscription-acceptance logic and returns either `Accepted`, `Redirect`, or `Denied`.

Notifications and resume requests use direct dialing to the known primary (cached from registration) and only fall back to `RouteAndMaybeAct` when the primary is unreachable.

### Ring coordinate computation

The bit-shift derivation operates directly on FRET's 256-bit ring coordinates. No additional hashing is required beyond the single `SHA-256(blockId)` and `SHA-256(peerId)` already performed by FRET.

### Cohort assembly

Reactivity uses FRET's two-sided cohort assembly without modification. The cohort at `coord_L` is whichever set of `k` peers FRET names as the cohort for that coordinate, with all the standard properties: alternating successor/predecessor walk, automatic adaptation when `n < k`, threshold signatures via `minSigs = k − x`.

---

## Wire formats

### Subscribe RPC (JSON, length-prefixed UTF-8)

```
interface SubscribeV1 {
  v:               1
  collectionId:    string          // base64url
  subscriberCoord: string          // base64url, 32 bytes
  level:           number
  ttl:             number          // ms, default 90000
  lastKnownRev:    number          // 0 for fresh subscribe
  timestamp:       number          // unix ms
  correlationId:   string          // base64url, 16 bytes random
  signature:       string          // base64url, sender peer key
}

interface SubscribeReplyV1 {
  v:               1
  result:          "accepted" | "redirect" | "denied"
  // when accepted:
  cohort?:         string[]        // PeerIds in the assigned cohort
  primary?:        string          // PeerId
  backups?:        string[]        // PeerIds, length 1-2
  currentRev?:     number
  cohortEpoch?:    string          // base64url, current tailId
  // when redirect:
  redirectLevel?:  number          // walk inward to this level
  // when denied:
  reason?:         string
  retryAfterMs?:   number
}
```

### Notification (JSON)

```
interface NotificationV1 {
  v:            1
  collectionId: string             // base64url
  tailId:       string             // base64url
  revision:     number
  digest:       string             // base64url
  delta?:       string             // base64url, optional, bounded
  timestamp:    number
  sig:          string             // base64url, threshold signature
  signers:      string[]           // PeerIds contributing to the threshold
  rotationHint?: {
    newTailId:          string
    effectiveAtRevision: number
  }
}
```

### Resume RPC (JSON)

```
interface ResumeV1 {
  v:                  1
  collectionId:       string
  fromRevision:       number
  latestKnownTailId:  string
  subscriberCoord:    string
  timestamp:          number
  signature:          string
}

interface ResumeReplyV1 {
  v:        1
  result:   "backfill" | "out_of_window" | "tail_rotated"
  // backfill:
  entries?:        NotificationV1[]
  currentRevision?: number
  // out_of_window:
  currentTailId?:   string
  currentRevision?: number
  // tail_rotated:
  newTailId?:           string
  newRevisionAtRotation?: number
}
```

### Demote notice (JSON)

```
interface DemoteNoticeV1 {
  v:               1
  collectionId:    string
  cohortCoord:     string
  level:           number
  effectiveAt:     number          // unix ms
  thresholdSig:    string          // base64url
  signers:         string[]
}
```

### Cohort gossip (JSON)

```
interface CohortGossipV1 {
  v:                  1
  collectionId:       string
  level:              number
  fromMember:         string         // PeerId
  directSubBucket:    number         // log-bucketed
  childCount:         number
  childBucketSum:     number         // sum of child log-buckets
  replayHead:         number         // highest revision in replay buffer
  parentCohort?:      string[]       // PeerIds, when announcing
  timestamp:          number
  signature:          string
}
```

---

## Configuration

### Defaults

| Parameter | Default | Description |
|---|---|---|
| `D_target` | 64 | Target direct subscribers per cohort |
| `bucket_promote` | bucket(64) = 6 | Promote outward above this bucket |
| `bucket_demote` | bucket(16) = 4 | Demote when below this bucket |
| `T_demote` | 5 min | Hysteresis window before demotion fires |
| `W` | 256 | Replay buffer depth (revisions) |
| `ttl` | 90s | Subscription TTL |
| `ping_interval` | 30s | Subscriber ping cadence (`ttl / 3`) |
| `T_drain` | 60s | Old-tail drain time after rotation |
| `L_max` | 240 | Cap on walk-inward starting level |
| `confidence_min` | 0.3 | Below this, fall back to conservative `L_init` |
| `backups_per_subscription` | 2 | Warm-failover cohort members |
| `block_fill_size` | 64 | Transactions per block (drives tail rotation) |

### Edge vs Core profiles

Reactivity inherits FRET's Edge/Core profile distinction. Edge subscribers (mobile) default to:

- `ttl` = 60s (shorter, faster reclamation by cohort if app is killed)
- `ping_interval` = 20s
- Backups are sticky-cached even across reconnects to avoid re-walk on flap
- `delta` field is rejected on incoming notifications above 4 KB (subscriber re-reads chain instead)

Edge cohort members (rare; cohorts skew Core) refuse forwarder-promotion duties and only serve direct subscribers.

---

## Worked scenarios

### Cold collection becomes popular

`t=0`: Collection C exists with 0 subscribers. Tail block is `T0`.

`t=1`: First subscriber `S_1` registers. `n_est = 1M`, `D_target = 64`, so `L_init ≈ 14`. Walks inward: outer cohorts have no state for C; eventually reaches the tail cohort at `L=0`. Tail cohort accepts (count = 1 ≪ 64).

`t=10`–`t=60`: Subscribers `S_2 … S_64` arrive. Each walks inward and lands at the tail cohort. Tail cohort serves all 64 directly.

`t=61`: Subscriber `S_65` arrives. Tail cohort's bucket exceeds `bucket_promote` and redirects to `L = 1`. `S_65` recomputes `coord_1(S_65, T_0)` and registers at the level-1 cohort that coord names. The level-1 cohort instantiates as a forwarder, registers up to the tail cohort, and accepts `S_65`.

`t=62…`: New subscribers fill level-1 cohorts in their respective ring regions. Each level-1 cohort fills to 64, then redirects further to `L = 2`, and so on.

The tree depth at steady state is `⌈log_64(N)⌉`. For `N = 1M` subscribers, depth = 4 levels.

### Mobile subscriber wakes after 90 seconds

Phone app resumes. `lastRevision = 1042`. Cached primary = `P_42`. Sends `ResumeV1{from: 1043}` to `P_42`. `P_42`'s replay buffer has revisions 950–1100. `P_42` returns `Backfill{entries: [1043..1098], currentRevision: 1098}`. Subscriber processes 56 backfilled notifications, updates `lastRevision = 1098`, resumes normal operation. Total: one round trip, no tree walk, no chain read.

### Tail rotation during steady-state load

Collection C has 10,000 subscribers, tree depth 3. Tail block `T_5` fills at revision 5400. The notification for revision 5400 includes `rotationHint{newTailId: T_6, effectiveAtRevision: 5401}`.

All 10,000 subscribers receive the hint via the existing tree within seconds. Each schedules re-registration with jitter over the next 30 seconds (bounded by `T_drain = 60s`). The new tail cohort at `coord(T_6)` sees an arrival rate of ~330 subscribers/second; it accepts 64, redirects the rest. Outer cohorts under `T_6` form during the same window. By `T_drain`, the new tree mirrors the old tree's shape under a different root. Forwarder cohorts under `T_5` demote naturally as their subscribers drain.

Notifications for revision 5401 onward originate from the new tail cohort under `T_6`. Continuity is preserved by the monotonic revision sequence; subscribers experience the rotation as a brief pause followed by resumed delivery.

### Cohort failure mid-notification

Tail cohort emits notification for revision 7800. Level-1 forwarder cohort `F_a` receives, forwards to its children. Mid-fanout, three of `F_a`'s 16 members crash simultaneously (e.g., shared infrastructure failure). The remaining 13 are still above quorum (`k − x = 14`); FRET stabilization kicks in and promotes successors into the cohort. During the brief instability window, `F_a`'s primary for some subscribers may be among the crashed three. Those subscribers' pings fail; they promote backups. Backups have the `SubscriptionRecord` and the replay buffer (gossiped). Subscribers issue `ResumeV1{from: 7800}`; the new primary serves from the buffer. No notifications are lost.

---

## Interaction with other subsystems

- **Transaction log** ([transactions.md](transactions.md)) — owns the canonical state. Reactivity reads commit events and tail-cohort threshold signatures. Reactivity does not affect transaction processing.
- **FRET** ([fret.md](../../Fret/docs/fret.md)) — provides ring coordinates, cohort assembly, `RouteAndMaybeAct`, network-size estimation, and stabilization. Reactivity is a pure consumer of FRET primitives.
- **Repository** ([repository.md](repository.md)) — supplies the collection-id and tail-id resolution and the chain-read fallback when subscribers are out of replay window.
- **Right-is-Right** ([right-is-right.md](right-is-right.md)) — the threshold-signed notification reuses the commit certificate that Right-is-Right already requires for transaction finality.
- **Partition healing** ([partition-healing.md](partition-healing.md)) — partition-merge events surface to forwarder cohorts as a hint to re-validate `parentCohort` and `childCohorts` references; mismatched cohort epochs trigger localized re-registration.
