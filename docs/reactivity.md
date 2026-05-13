# Reactivity

Push-based change notifications for Optimystic collections, layered on the cohort-topic substrate ([cohort-topic.md](cohort-topic.md)). Reactivity is the **push-tree application** of the cohort-topic layer: a rotating-anchor topic tree, with the tail block's coordinate as the anchor, used to fan out signed notifications to subscribers. See [transactions.md](transactions.md) for the transaction log that drives notifications and [fret.md](../../Fret/docs/fret.md) for the underlying ring overlay.

---

## Overview

Reactivity gives clients a push-based signal when a collection's state changes, without forcing them to poll the chain. A subscriber registers on the collection's topic tree; when the collection commits a transaction, the tail cohort emits a signed notification that fans out through the tree to every active subscriber. The subscriber decides whether to read the new state, fetch a delta, or ignore.

The system is **hint-only**. The transaction log remains the sole authority for collection state. Notifications can be delayed, duplicated, or (rarely) lost without compromising correctness; they exist purely to avoid wasted bandwidth and battery on idle clients.

All addressing, walk semantics, willingness, promotion, demotion, and primary/backup sharding are inherited from the cohort-topic layer. This document specifies only the parts unique to push notification:

- **Anchor rotation** with the collection's tail block, to deny attackers a long-lived root.
- **Threshold-signed notifications** that reuse the commit certificate from the transaction layer.
- **Replay buffer** for backfilling subscribers that wake from sleep within the window.
- **Per-revision dedupe** and **slow-subscriber backpressure** that keep fan-out bounded.
- **Mobile-friendly resume** including longer-than-buffer recovery via parent checkpoint summaries.

---

## Goals and non-goals

### Goals
- Push-based change delivery with minimal mobile bandwidth and CPU.
- Scale from 1 subscriber to millions per collection, sharing infrastructure with matchmaking and any other cohort-topic application.
- End-to-end authentic notifications (no per-hop trust required).
- Mobile-friendly wake/resume: subscribers backfill in one round trip within the replay window; within parent-checkpoint range, one extra round trip.
- Treat push as **T3 (luxury)**: never starves transaction commit, never forces lightweight nodes into forwarder duty.

### Non-goals
- Ordering guarantees beyond per-collection revision monotonicity.
- Exactly-once delivery (subscribers dedupe by revision).
- Cross-collection joins or filtered subscriptions.
- Authority over collection state — that belongs to the transaction log.
- Catching subscribers up from arbitrarily old state. Beyond parent checkpoint range, subscribers fall back to a normal chain read.

---

## Anchor: rotating with the tail block

Reactivity uses a rotating topic anchor so the tree's root cohort changes with the collection's transaction churn. This denies an attacker any single coordinate to attack persistently and naturally amortizes hot-spot duty across the ring.

```
topicId(collection C, tail T) = H(T.blockId ‖ "reactivity")
```

The cohort-topic layer's tier addressing then proceeds normally:

```
coord_0(_, topicId)   = H(0x00 ‖ topicId)
coord_d(P, topicId)   = H(d ‖ prefix(P, d·log₂F) ‖ topicId)   for d ≥ 1
```

When the tail rotates (the current tail block fills and a new tail block is born), `topicId` changes. The cohort-topic layer treats the new `topicId` as an entirely new topic; reactivity manages the migration of subscribers and replay state explicitly (see [Tail rotation](#tail-rotation)).

### Why not anchor on the stable `collectionId`?

Stable anchoring would concentrate notification production at a single coord for the collection's lifetime, creating a permanent attack target and load hotspot. Rotation costs a periodic re-registration storm (bounded by `T_drain`; see below) in exchange for distributing the root duty across the ring over time. For collections rotating once per minute or slower, rotation traffic is a small fraction of total notification traffic.

---

## Subscription

Subscribing to collection `C` is a normal cohort-topic registration with:

- `topicId` = `H(currentTailId(C) ‖ "reactivity")`
- `tier` = `T3` (luxury)
- `appPayload` = `SubscribeAppPayloadV1` (see [Wire formats](#wire-formats))
- `ttl` = configured TTL (Edge default 60 s, Core default 90 s)

The walk-toward-root from `d_max`, the willingness-driven member selection, the `Promoted`/`UnwillingMember`/`UnwillingCohort` reply set, and the TTL renewal protocol are all the cohort-topic standard.

### Subscriber-side state

```
ActiveSubscription {
  collectionId:    bytes                    // stable, for identifying the subscription
  topicId:         bytes                    // current tail-anchored topic
  tailIdAtAttach:  bytes                    // tail block ID at registration time
  primary:         PeerId
  backups:         PeerId[]
  cohortHint:      PeerId[]                 // for fast re-attach
  cohortEpoch:     bytes                    // for membership-drift detection
  lastRevision:    revision
  lastDeliveredAt: timestamp
  attachedAt:      timestamp
}
```

`tailIdAtAttach` is the subscriber-side detector for tail rotation. The cohort-topic-level `cohortEpoch` already detects cohort membership churn within a topic; `tailIdAtAttach` detects the whole-tree migration triggered by tail rotation.

### Forwarder-cohort state (per collection served)

A reactivity forwarder cohort holds the cohort-topic-standard registration records plus per-collection notification state:

```
PushState {
  collectionId:       bytes
  topicId:            bytes
  tailIdAtJoin:       bytes
  parentCohort:       CohortRef                  // tier-(d−1) cohort
  childCohorts:       CohortRef[]                // tier-(d+1) cohorts
  replayBuffer:       RevisionEntry[W]           // ring buffer, default W = 256
  parentCheckpoint:   CheckpointSummary?         // see Resume beyond replay window
  lastRevision:       revision
  pendingDedupe:      Set<(revision, sigDigest)> // sliding 64-entry window
  perSubscriberQueue: Map<PeerId, BoundedQueue>  // see Slow-subscriber backpressure
}
```

The direct-subscriber list is the cohort-topic layer's `RegistrationRecord` set with `appPayload.kind == "reactivity"`. Reactivity reads it but does not duplicate it.

---

## Notification origination

When the tail cohort commits a transaction, the commit machinery in the transaction layer ([transactions.md](transactions.md)) already produces a threshold-signed commit certificate. Reactivity reuses that certificate without additional cohort signing:

```
NotificationV1 {
  v:            1
  collectionId: bytes
  tailId:       bytes
  revision:     uint64
  digest:       bytes                       // commit digest from the transaction layer
  delta?:       bytes                       // optional, bounded; opt-in per collection
  timestamp:    int64
  sig:          thresholdSig                // = commit cert; signers ≥ minSigs = k − x
  signers:      PeerId[]
  rotationHint?: { newTailId, effectiveAtRevision }   // see Tail rotation
}
```

The `sig` field is bit-for-bit the same threshold signature the transaction layer produces. A subscriber that already trusts the transaction-layer machinery (which it must, to trust the collection at all) automatically trusts notifications without additional verifiers.

### Origination point

The tail cohort's primary for the collection (the cohort-topic primary at `coord_0(_, topicId)`) is the notification origin. It is by definition the tail cohort because `topicId` is derived from `tailId`. When this cohort is also serving as the transaction-layer tail-cluster — which it is, since they share the same coordinate — origination is a side-effect of commit: as soon as the threshold signature on the commit is assembled, the primary emits the notification.

### Delta payloads

The `delta` field is optional and bounded by `delta_max` (default: 4 KB at Core profile, 0 at Edge profile — Edge subscribers reject any inbound `delta` and re-read the chain instead, since paying for the delta wire bytes when CPU is the bottleneck is the wrong tradeoff). Whether to include a delta is a per-collection configuration; collections whose typical delta is larger than `delta_max` simply omit it.

---

## Propagation

The tail cohort's primary delivers the signed notification to:

- Every direct subscriber (via each subscriber's primary assignment as held in the cohort-topic registration record).
- Every entry in `childCohorts`, addressed to that child's primary.

A receiving forwarder cohort's primary:

1. Verifies the threshold signature against the tail cohort's `MembershipCertV1` ([cohort-topic.md §Membership snapshots](cohort-topic.md#membership-snapshots-and-signature-verification)).
2. Runs the dedupe check (see below).
3. Appends to the replay buffer.
4. Forwards the unmodified notification to its own direct subscribers and child cohorts.

Forwarders never re-sign. Subscribers verify the same end-to-end signature regardless of how many hops the notification traveled. A compromised forwarder can drop or delay messages but cannot forge them; subscribers detect drops via revision gaps and re-fetch from the replay window.

### Per-revision dedupe (sliding-window set)

A single scalar `lastRevision` is not sufficient under partition healing or transient cohort partitioning: the same revision may legitimately arrive from multiple parents during merge, and dropping all but the first based on `revision > lastRevision` discards honest retransmits the moment a subscriber needs them.

Each forwarder cohort keeps a sliding `pendingDedupe` set of `(revision, sigDigest)` pairs for the last `dedupe_window` revisions (default 64). A new notification is forwarded if:

- It is for the *highest revision* seen in the window (normal case), OR
- It is for an earlier revision *and* the `(revision, sigDigest)` is not already in the set *and* it passes verification (recovery case: a retransmit closing a gap).

Notifications already in the set are dropped silently. The set is gossiped within the cohort so all members agree on what has been seen.

### Slow-subscriber backpressure

A forwarder's primary maintains a per-subscriber bounded queue with drop-oldest semantics:

```
BoundedQueue {
  capacity:   queue_max         // default 32 revisions
  entries:    NotificationV1[]
  dropped:    uint              // monotone counter
}
```

If a subscriber's queue is full when a new notification arrives, the oldest entry is dropped and `dropped` is incremented. The subscriber learns about the gap on next delivery (revision jump) and issues a `BackfillV1` against the replay buffer.

This isolates slow subscribers: one phone with a flaky connection does not stall fan-out to the rest of the cohort's attached subscribers. The queue size is small enough (a few KB per subscriber) that cohort memory is bounded by `cohort_subscribers × queue_max × notification_size`.

---

## Delivery

A subscriber receiving a notification:

1. Verifies `sig` against the cached `MembershipCertV1` for the tail cohort (with one fetch-and-retry fallback for stale-cache cases).
2. Checks `revision == lastRevision + 1`. If not equal, requests `BackfillV1{from: lastRevision + 1, to: revision}` from `primary`.
3. Updates `lastRevision` once revisions are contiguous.
4. Surfaces the notification to the application layer.

Subscribers dedupe by `(collectionId, revision)`; duplicates from forwarder retries are discarded.

---

## Replay window

Each forwarder cohort and the tail cohort maintain a per-collection ring buffer of the last `W` notifications (default `W = 256`). Entries are gossiped across the cohort so any member can serve replay requests if the primary is unavailable.

```
RevisionEntry {
  revision:    uint64
  payload:     NotificationV1            // the full signed notification
  receivedAt:  timestamp
}
```

### Resume

A subscriber resuming from sleep sends:

```
ResumeV1 { collectionId, fromRevision, latestKnownTailId }
```

to its cached `primary` (or any cohort member if primary is stale). The cohort responds with one of:

- `Backfill { entries, currentRevision }` — `fromRevision` is within the replay window. Subscriber replays entries, dedupes, and is current. Single round trip.
- `CheckpointWindow { checkpoint, recentEntries }` — `fromRevision` is older than the buffer but within parent-checkpoint range (see below). Subscriber applies the checkpoint summary, then replays the recent entries.
- `OutOfWindow { currentTailId, currentRevision, currentMembership }` — `fromRevision` is older than even the parent checkpoint. Subscriber falls back to a chain read.
- `TailRotated { newTailId, newRevisionAtRotation }` — `latestKnownTailId` is stale. Subscriber re-registers under the new tail and replays from the new tree.

### Parent checkpoint summaries

A 256-revision replay buffer at one commit per second covers ≈4 minutes — long enough for a backgrounded mobile app, not for a phone in a pocket overnight. To extend recoverable range without ballooning replay-buffer memory, every parent forwarder cohort (and the tail cohort) maintains a `CheckpointSummary`:

```
CheckpointSummary {
  collectionId:        bytes
  fromRevision:        uint64
  toRevision:          uint64          // toRevision - fromRevision ≈ W_checkpoint, default 4096
  mergedDigest:        bytes           // application-defined fold of digests from each entry
  mergedDelta?:        bytes           // optional, bounded; coalesced delta if collection supports
  bracketingSigs:      thresholdSig[2] // sigs of the entries at fromRevision and toRevision
}
```

The checkpoint is *not* a replacement for the source-of-truth chain; it is a hint summary. The bracketing signatures let a subscriber verify the checkpoint endpoints are real committed revisions; the merged digest tells the application "here's what changed across this range." For KV-shaped collections this is enough to know whether to invalidate caches without a chain read. For collections needing exact intermediate state, the checkpoint is not sufficient and the subscriber must fall back to the chain.

`W_checkpoint` defaults to 16× the replay buffer (4096 revisions ≈ 1 hour at 1 cps) and is configurable per collection. Cohorts at tier `d ≥ 1` are the primary holders of checkpoints; the tail cohort holds the current rolling checkpoint, advancing it as revisions retire from the replay buffer.

### Backfill RPC

```
BackfillV1 { collectionId, fromRevision, toRevision }
BackfillReplyV1 { entries: NotificationV1[], available: { from, to } }
```

Subscribers MAY request a sub-range smaller than `[fromRevision, toRevision]`; cohorts return the intersection with their replay buffer and indicate `available` so the subscriber knows whether to fall back further.

---

## Tail rotation

Tail block ID changes when a block fills (default `block_fill_size = 64` transactions). Rotation moves the topic anchor — and hence the tree root — to a new ring coord.

### Rotation protocol

1. **Pre-announce.** While committing the block-filling transaction, the outgoing tail cohort embeds `rotationHint{ newTailId, effectiveAtRevision }` in the notification. The hint reaches every active subscriber via the existing tree.

2. **Drain.** The outgoing tail cohort continues to accept renewals and serve replays for `T_drain` (default 60 s) after rotation. New subscriptions are rejected with a `Promoted`-shaped redirect to the new `topicId`'s tree.

3. **Subscriber re-registration with jitter.** Subscribers, on receiving the rotation hint, schedule re-registration at the new `topicId` with random jitter over `T_rejoin_jitter` (default 30 s). Re-registration carries the subscriber's existing `lastRevision`; revisions are continuous across rotations, so no replay confusion.

4. **Forwarder draining.** Forwarder cohorts under the old tail observe their direct-subscriber count dropping (subscribers re-registering under the new tail) and demote naturally per the cohort-topic demotion protocol. They do not migrate state to the new tree — the new tree rebuilds via re-registration.

5. **Replay-buffer handoff to checkpoint.** As the outgoing tail cohort drains, it folds its replay buffer into a final `CheckpointSummary` covering `[lastCheckpoint.toRevision + 1, rotationRevision]` and hands it to the new tail cohort. This is the only state migration across rotations. The new tail cohort holds the old checkpoint to serve `ResumeV1` requests that span the rotation.

### Anticipatory warm-up

When a tail block reaches `block_fill_size − warm_threshold` (default 56 of 64) transactions, the outgoing tail cohort opportunistically pre-dials toward the likely-successor coord. The next `tailId` is not knowable until the filling commit, so this is best-effort: the cohort biases FRET pre-dialing toward peers whose ring position is consistent with high-probability successor coords. No state is migrated until the actual rotation.

### Rotation cost

For collections with `block_fill_size = 64` and one commit per minute, rotation happens once per ~64 minutes; the per-rotation cost (one re-registration walk per subscriber, fanned over `T_rejoin_jitter`) is negligible. For very busy collections rotating every few seconds, the re-registration storm is large but still bounded: with `T_rejoin_jitter = 30 s`, the new tail sees no more than `subscribers / T_rejoin_jitter` arrivals per second, which is well within cohort-topic's normal admission rates.

---

## Authentication and integrity

- **Notifications** carry the tail cohort's threshold signature, which *is* the commit certificate from the transaction layer. Signature verification uses the standard cohort-topic membership-snapshot path ([cohort-topic.md §Membership snapshots](cohort-topic.md#membership-snapshots-and-signature-verification)).
- **Subscribe / renew / resume RPCs** are signed by the subscriber's peer key and include `correlationId` and `timestamp`; replay protection is handled by the cohort-topic layer.
- **Rotation hints** are part of the notification payload and inherit its signature.
- **Forwarder cohorts do not re-sign.** They pass through the original threshold signature unchanged.
- **Replay-buffer entries** retain the original signature. Backfill responses are verifiable end-to-end.
- **Checkpoint summaries** are signed at their endpoints by the cohorts that produced them at those revisions; the merged digest is computed deterministically from the bracketed range. A subscriber verifies the bracketing signatures and checks the digest only against application-level expectations.

A subscriber needs no trust in any forwarder. The trust root is the tail cohort's membership, which derives from the transaction log.

---

## Per-cohort policy

Reactivity is **T3 (luxury)** at the cohort-topic layer. Concretely:

- A cohort under heavy T0 load (active transaction commits) will report willingness=false for T3, causing `UnwillingCohort` responses to subscribe requests at that cohort. Subscribers back off and retry; FRET stabilization typically rotates cohort membership before T0 load fully clears.
- Edge nodes never serve as reactivity forwarders. They register as subscribers (T3 consumer is fine; only T3 *producer* is restricted).
- Per-cohort topic budget (`topics_max` in the layer's defaults) bounds the number of collections a single cohort serves. Reactivity does not require any additional admission policy beyond this.

---

## Failure modes (push-specific)

### Notification fan-out interrupted by primary failure
The primary at a forwarder cohort begins fan-out, completes some recipients, then fails. The cohort detects via heartbeat, backups are gossiped the partial-delivery state, and the new primary completes fan-out using its own copy of the registration list and replay buffer. Recipients that already received the notification dedupe; those who hadn't get it from the new primary. No loss.

### Slow subscriber on satellite link
Bounded per-subscriber queue (above) absorbs short bursts. Sustained backlog causes oldest-revision drop; subscriber detects via revision gap on next received notification and issues a `BackfillV1`. The cohort's replay buffer covers the gap as long as the subscriber's lag stays under `W` revisions; beyond that, `CheckpointWindow`; beyond that, chain read.

### Subscriber wakes after long sleep
- `< W` revisions of lag: one `ResumeV1`, gets `Backfill`. One round trip.
- `< W_checkpoint` revisions of lag: one `ResumeV1`, gets `CheckpointWindow`. One round trip.
- Older: `ResumeV1` returns `OutOfWindow`. Subscriber reads the chain to catch up to a current revision, then issues a fresh subscribe.

### Tail rotation during subscriber outage
Subscriber wakes, sends `ResumeV1` with stale `latestKnownTailId`. The cohort it reaches (under the new tail) responds `TailRotated{ newTailId }`. Subscriber walks the new tree, re-registers, and resumes; replay covers as much as it covers.

### Cohort fully fails during steady-state operation
Standard cohort-topic recovery. Attached subscribers detect via ping failure, re-register from `d_max`. With `T_rejoin_jitter` the post-failure registration rate is bounded.

### Many subscribers, sudden interest spike
Cohort-topic's promotion machinery handles this with `cap_promote_fast`: when the load barometer is hot, the tail cohort fast-promotes after `cap_promote_fast = 32` subscribers rather than waiting for the full `cap_promote = 64`. The tree grows faster than under normal load, spreading subscribers across deeper tiers before the tail saturates.

---

## Wire formats

Reactivity reuses the cohort-topic layer's `RegisterV1`, `RenewV1`, etc., with a reactivity-specific `appPayload`:

```
interface SubscribeAppPayloadV1 {
  kind:               "reactivity"
  collectionId:       string             // base64url
  tailIdAtAttach:     string             // base64url
  lastKnownRev:       number             // 0 for fresh subscribe
  deltaMaxBytes:      number             // 0 = decline delta payloads
}
```

### Notification

```
interface NotificationV1 {
  v:            1
  collectionId: string                   // base64url
  tailId:       string                   // base64url
  revision:     number
  digest:       string                   // base64url
  delta?:       string                   // base64url, bounded
  timestamp:    number
  sig:          string                   // threshold signature, base64url
  signers:      string[]                 // PeerIds contributing
  rotationHint?: {
    newTailId:           string
    effectiveAtRevision: number
  }
}
```

### Resume

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
  result:   "backfill" | "checkpoint_window" | "out_of_window" | "tail_rotated"
  // backfill:
  entries?:           NotificationV1[]
  currentRevision?:   number
  // checkpoint_window:
  checkpoint?: {
    fromRevision:   number
    toRevision:     number
    mergedDigest:   string
    mergedDelta?:   string
    bracketingSigs: string[]            // length 2
  }
  recentEntries?:     NotificationV1[]
  // out_of_window:
  currentTailId?:     string
  currentRevision?:   number
  // tail_rotated:
  newTailId?:             string
  newRevisionAtRotation?: number
}
```

### Backfill

```
interface BackfillV1 {
  v:             1
  collectionId:  string
  fromRevision:  number
  toRevision:    number
  signature:     string
}

interface BackfillReplyV1 {
  v:            1
  entries:      NotificationV1[]
  available: {
    fromRevision: number
    toRevision:   number
  }
}
```

---

## Configuration

### Defaults

Reactivity adds the following to the cohort-topic defaults:

| Parameter | Default | Description |
|---|---|---|
| `W` | 256 | Replay buffer depth (revisions per cohort, per collection) |
| `W_checkpoint` | 4096 | Parent-checkpoint span (revisions) |
| `dedupe_window` | 64 | Sliding-window dedupe set size |
| `queue_max` | 32 | Per-subscriber bounded queue depth at a forwarder |
| `delta_max` (Core) | 4096 | Max delta payload size in bytes; Edge = 0 |
| `T_drain` | 60 s | Old-tail drain time after rotation |
| `warm_threshold` | 8 | Transactions remaining in tail before anticipatory warm-up |
| `block_fill_size` | 64 | Transactions per block (drives tail rotation) |

### Edge profile

In addition to the cohort-topic Edge overrides (TTL = 60 s, ping = 20 s, T2/T3 producer willingness off):

- Subscribers reject inbound notifications carrying `delta` (`deltaMaxBytes = 0` in subscribe payload).
- `cohortHint` is sticky-cached across reconnects so brief network flaps don't trigger re-walk.

---

## Worked scenarios

### Cold collection becomes popular

`t = 0`: collection `C` has 0 subscribers, tail block `T_0`.

`t = 1`: First subscriber `S_1` registers. `n_est = 1M`, `F = 16`, so `d_max ≈ 4`. `S_1` probes `coord_4(S_1, H(T_0 ‖ "reactivity"))`; cohort there is cold, returns `NoState`. Walk toward root: `d = 3`, `d = 2`, `d = 1`, `d = 0`. The tier-0 cohort (which *is* the tail cohort) accepts; `S_1` is registered as the first subscriber.

`t = 10..60`: `S_2 … S_64` arrive. Each probes `d_max = 4` first; their tier-4 coords differ (different peer-ID prefixes), so the probes fan across the ring. All fall through to the root, which accepts up to `cap_promote = 64`.

`t = 61`: `S_65` arrives, walks to the root, gets `Promoted(1)`. Computes `coord_1(S_65, topicId)`; the tier-1 cohort at that coord instantiates as a forwarder, registers up to the tier-0 (tail) cohort, and accepts `S_65`.

`t = 62 ..`: New subscribers fill tier-1 cohorts in their respective prefix-shards. Each fills to 64, then promotes to tier 2 in its shard. Steady-state depth at 1 M subscribers is `⌈log_16(1M / 64)⌉ = 4` tiers.

### Mobile subscriber wakes after 90 seconds

Phone app resumes. `lastRevision = 1042`. Cached `primary = P_42`. Sends `ResumeV1{from: 1043}`. `P_42`'s replay buffer has revisions 950–1100. Returns `Backfill{entries: [1043..1098], currentRevision: 1098}`. Subscriber processes 56 backfilled notifications, updates `lastRevision = 1098`, resumes. One round trip.

### Mobile subscriber wakes after 20 minutes

Phone app resumes. `lastRevision = 1042`, current revision is 2342. Replay buffer covers 2086–2342 (256 entries). `ResumeV1{from: 1043}` falls outside the buffer but inside the parent checkpoint `[800, 2085]`. Cohort returns `CheckpointWindow{ checkpoint: [800..2085], recentEntries: [2086..2342] }`. Subscriber applies the checkpoint's merged digest (collection-specific — for a KV collection, this is "these keys changed"), then dedupes against `lastRevision = 1042` for the `recentEntries`. One round trip.

### Tail rotation during steady-state load

Collection `C` has 10 000 subscribers, tree depth 3. Tail block `T_5` fills at revision 5400. The notification for revision 5400 carries `rotationHint{ newTailId: T_6, effectiveAtRevision: 5401 }`.

All 10 000 subscribers receive the hint via the existing tree within a few seconds. Each schedules re-registration with random jitter over 30 s. The new tail cohort at `coord_0(_, H(T_6 ‖ "reactivity"))` sees arrival rate ≈ 333 / s; it accepts 64 directly, fast-promotes (`cap_promote_fast = 32`, load bucket hot), and starts redirecting to tier 1. Tier-1 cohorts under `T_6` form during the same window. By `T_drain = 60 s`, the new tree mirrors the old tree's shape under a different root. Forwarder cohorts under `T_5` drain and demote naturally. Continuity is preserved by the monotonic revision sequence; subscribers experience the rotation as a brief pause followed by resumed delivery from the new tree.

### Cohort failure mid-notification

Tail cohort emits notification for revision 7800. Tier-1 forwarder `F_a` receives, begins fan-out. Mid-fanout, three of `F_a`'s 16 members crash, dropping the cohort to 13 — one below quorum. FRET stabilization promotes successors into the cohort within seconds, restoring quorum; meanwhile attached subscribers whose primary was among the crashed three see ping failures and promote backups. The backups already have the registration record and replay-buffer entries from cohort gossip. Subscribers issue `BackfillV1{from: 7800}`; the new primary serves from the buffer. No notifications are lost.

---

## Interaction with other subsystems

- **Cohort topic** ([cohort-topic.md](cohort-topic.md)) — owns addressing, walks, willingness, promotion/demotion, primary/backup sharding, membership certificates. Reactivity is one application on top.
- **Transaction log** ([transactions.md](transactions.md)) — owns canonical state. Reactivity reuses commit certificates as notification signatures.
- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — ring coordinates, cohort assembly, stabilization. Reached through the cohort-topic layer.
- **Repository** ([repository.md](repository.md)) — supplies the chain-read fallback when subscribers are out of even the parent-checkpoint window.
- **Right-is-Right** ([right-is-right.md](right-is-right.md)) — the threshold-signed notification reuses the commit certificate that Right-is-Right already requires for transaction finality.
- **Partition healing** ([partition-healing.md](partition-healing.md)) — handled at the cohort-topic layer via `cohortEpoch` refresh; reactivity reacts by re-verifying its parent-checkpoint bracketing signatures.
- **Matchmaking** ([matchmaking.md](matchmaking.md)) — sibling application on the same cohort-topic substrate; no direct interaction, but operational cost-sharing benefits flow from running both on the same cohort infrastructure.
