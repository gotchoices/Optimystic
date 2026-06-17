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

> **Implemented** (`11-reactivity-origination-replay-delivery`,
> `12.1-reactivity-digest-commit-hash-alignment`). Origination is the pure assembler
> `buildNotificationV1(event, commitCert, ctx)` in `packages/db-core/src/reactivity/notification.ts`,
> reusing `commitCert.thresholdSig` **bit-for-bit** (never re-signed). The db-p2p
> `ReactivityOriginationManager` installs it on `CohortTopicService.onLocalCommit`, fed by the
> local-change-notifier bridge (`local-change-notifier-bridge`). The `digest` field carries the
> commit-vote **signed payload** `commitCert.signedPayload` = `utf8(commitHash + ":approve")`, base64url —
> the exact bytes each cohort member signed to produce its chunk of `thresholdSig`. A subscriber's
> *cryptographic* threshold-verify recomputes the cohort check over `b64urlToBytes(digest)`, reproducing
> that signed image, so it succeeds against **real** Ed25519 (no pass-crypto stub). The cluster↔reactivity
> seam is **closed**. This networked origination **subsumes** the superseded backlog ticket
> `optimystic-replica-persist-change-notification` (waking consumers on commit).

When the tail cohort commits a transaction, the commit machinery in the transaction layer ([transactions.md](transactions.md)) already produces a threshold-signed commit certificate. Reactivity reuses that certificate without additional cohort signing:

```
NotificationV1 {
  v:            1
  collectionId: bytes
  tailId:       bytes
  revision:     uint64
  digest:       bytes                       // commit-vote signed payload utf8(commitHash + ":approve"); the exact bytes sig was computed over
  delta?:       bytes                       // optional, bounded; opt-in per collection
  timestamp:    int64
  sig:          thresholdSig                // = commit cert; signers ≥ minSigs = k − x
  signers:      PeerId[]
  rotationHint?: { newTailId, effectiveAtRevision }   // see Tail rotation
}
```

The `sig` field is bit-for-bit the same threshold signature the transaction layer produces. A subscriber cryptographically threshold-verifies it against the tail cohort's membership — the same trust root it must already accept to trust the collection at all — over `b64urlToBytes(digest)`, the exact `utf8(commitHash + ":approve")` image each cohort member signed. So notifications introduce **no new signing authority** beyond the commit certificate, yet are not trusted blindly: the verify runs against real Ed25519 (see [Authentication and integrity](#authentication-and-integrity)).

### Origination point

The tail cohort's primary for the collection (the cohort-topic primary at `coord_0(_, topicId)`) is the notification origin. It is by definition the tail cohort because `topicId` is derived from `tailId`. When this cohort is also serving as the transaction-layer tail-cluster — which it is, since they share the same coordinate — origination is a side-effect of commit: as soon as the threshold signature on the commit is assembled, the primary emits the notification.

### Delta payloads

The `delta` field is optional and bounded by `delta_max` (default: 4 KB at Core profile, 0 at Edge profile — Edge subscribers reject any inbound `delta` and re-read the chain instead, since paying for the delta wire bytes when CPU is the bottleneck is the wrong tradeoff). Whether to include a delta is a per-collection configuration; collections whose typical delta is larger than `delta_max` simply omit it.

---

## Propagation

> **Implemented** (`12.31-reactivity-forwarder-host`). The receive→forward→fan-out orchestration is the
> db-p2p `ReactivityForwarderHost` (`packages/db-p2p/src/reactivity/forwarder-host.ts`): `ingest(topicId, n)`
> lazily instantiates the per-collection `PushState` + forwarder behind the Edge policy gate
> (`instantiateForwarderPushState`), serializes ingests per topic so the replay ring + dedupe never
> interleave, runs the db-core forwarder receive path, and on `"forward"` fans the **unmodified** frame out
> to every direct subscriber (through `PushState.perSubscriberQueue`) and child cohort. `onInbound` drives
> both the subscriber and forwarder roles for an inbound dial. It is **encoding-agnostic** over the
> subscriber-id space and depends only on the `ReactivityNotifyTransport` interface, so it is unit-testable
> with a fake transport; the libp2p node assembly that supplies a concrete transport and routes inbound
> frames by topic is `reactivity-notification-transport`. Spec: `forwarder-host.spec.ts`. Building block —
> not yet on the live commit→notify path (that wiring lands with the node-assembly ticket).

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

> **Implemented** (`11.5-reactivity-rotation-backpressure-policy`). The per-subscriber drop-oldest queue is
> `BoundedQueue` and its per-subscriber map `SubscriberBackpressure` in
> `packages/db-core/src/reactivity/backpressure.ts`, wired into `PushState.perSubscriberQueue`
> (`push-state.ts`) with `PushState.enqueueForSubscribers(subscriberIds, n)` doing the fan-out. Each
> subscriber gets its own bounded queue (depth `queue_max`, default 32); a full queue drops its **oldest**
> entry and bumps a monotone `dropped` counter, so a slow subscriber's drops never touch a fast peer's
> queue (the isolation property). The map is **primary-local fan-out state — never gossiped** (absent from
> `PushStateGossipV1`); a `cohortEpoch` handoff rebuilds it empty and the replay buffer + backfill path
> recover the few notifications dropped at handoff. Spec: `backpressure.spec.ts` (drop-oldest + counter,
> slow-subscriber isolation while fast subscribers stay contiguous).

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

> **Implemented** (`11-reactivity-origination-replay-delivery`). The subscriber-side path is
> `createReactivitySubscriber` (`packages/db-core/src/reactivity/subscriber.ts`): verify (via
> `createNotificationVerifier` over the cohort-topic `MembershipVerifier`, which owns the **one
> fetch-and-retry** on a stale cache), the `revision == lastRevision + 1` contiguity check, gap → the
> `requestBackfill(from, to)` seam (the `BackfillV1` transport lands in
> `reactivity-backfill-resume-checkpoints`), `(collectionId, revision)` dedupe, and surfacing. A fresh
> subscribe (`lastKnownRev == 0`) adopts the first verified notification as its baseline. The forwarder
> receive path (verify → dedupe → buffer → forward), the `W`-entry replay ring, and the sliding
> `(revision, sigDigest)` dedupe window — all gossip-replicated so any cohort member can serve a replay —
> are also implemented here. **Backfill/resume/checkpoints**, **tail rotation**, and **backpressure** are
> delivered by the sibling tickets (`reactivity-backfill-resume-checkpoints`,
> `reactivity-rotation-backpressure-policy`); the `parentCheckpoint` / `perSubscriberQueue` `PushState`
> fields are reserved for them.

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

> **Implemented** (`11.5-reactivity-backfill-resume-checkpoints`). The classifier + server are
> `classifyResume` / `serveResume` in `packages/db-core/src/reactivity/resume.ts` (pure over a
> `PushState` snapshot — replay ring + rolling checkpoint + current tail). The subscriber-side apply is
> `applyResumeReply` (backfill / checkpoint-window entries re-enter through the delivery path so they are
> verified, contiguity-checked, and deduped; a verified checkpoint advances the contiguity head via
> `ReactivitySubscriber.rebaseline` before replaying `recentEntries`; an untrusted checkpoint or
> out-of-window escalates to a chain read; a stale tail escalates to re-registration). db-p2p's
> `ReactivitySubscriptionManager.resume()` drives the RPC and keeps the Edge `StickyCohortHintCache`.

A subscriber resuming from sleep sends:

```
ResumeV1 { v, collectionId, fromRevision, latestKnownTailId, subscriberCoord, timestamp, signature }
```

to its cached `primary` (or any cohort member if primary is stale). The cohort responds with one of:

- `Backfill { entries, currentRevision }` — `fromRevision` is within the replay window. Subscriber replays entries, dedupes, and is current. Single round trip.
- `CheckpointWindow { checkpoint, recentEntries }` — `fromRevision` is older than the buffer but within parent-checkpoint range (see below). Subscriber verifies the checkpoint's bracketing endpoints, applies the merged digest, advances its contiguity head past the summarized range, then replays the recent entries.
- `OutOfWindow { currentTailId, currentRevision }` — `fromRevision` is older than even the parent checkpoint. Subscriber falls back to a chain read, then a fresh subscribe.
- `TailRotated { newTailId, newRevisionAtRotation }` — `latestKnownTailId` is stale. Subscriber re-registers under the new tail and replays from the new tree. This is classified **first**: a stale tail means the whole tree migrated, so the lag-against-windows classification is moot. (The rotation *lifecycle* is owned by [reactivity-rotation-backpressure-policy]; this resume path only *detects* the stale tail.)

**Resume-on-rotation → keep the simple full walk (resolved, `11.5`).** On `TailRotated` the subscriber re-registers under the new tail via the ordinary walk from `d_max`. The Edge **sticky `cohortHint` cache** already shortcuts the *common* case — a brief flap with no rotation resumes against the cached primary in one round trip (the cache is invalidated only on an actual `TailRotated`, so a stale-tree primary is never reused). A pre-dial toward the pre-announced successor coord (from the `rotationHint`) is **deferred to the rotation ticket**: it requires rotation-side announce state (the successor coord is not knowable until the filling commit), so it belongs with the rotation lifecycle rather than the resume classifier.

### Parent checkpoint summaries

> **Implemented** (`11.5-reactivity-backfill-resume-checkpoints`). The rolling checkpoint is
> `RollingCheckpoint` in `packages/db-core/src/reactivity/checkpoint.ts`, fed by replay-ring eviction —
> `PushState` wires `createReplayBuffer(..., onEvict)` to `RollingCheckpoint.retire`, so a revision leaving
> the `W`-deep ring rolls into the `W_checkpoint`-span summary sitting immediately below it. `PushState.parentCheckpoint`
> exposes the current `CheckpointSummary` (re-derived from the live rolling checkpoint). `W_checkpoint` is
> sourced from the shared defaults table (`config.ts` `W_CHECKPOINT_DEFAULT = 4096`) and scales adaptively
> via `resolveWCheckpoint` (a fixed `16×` multiple of the resolved `W`).

A 256-revision replay buffer at one commit per second covers ≈4 minutes — long enough for a backgrounded mobile app, not for a phone in a pocket overnight. To extend recoverable range without ballooning replay-buffer memory, every parent forwarder cohort (and the tail cohort) maintains a `CheckpointSummary`:

```
CheckpointSummary {
  collectionId:        bytes
  fromRevision:        uint64
  toRevision:          uint64               // toRevision - fromRevision ≈ W_checkpoint, default 4096
  mergedDigest:        bytes                // system-level deterministic fold of per-revision digests (per-collection override)
  mergedDelta?:        bytes                // optional, bounded; coalesced delta — omitted when it would exceed delta_max
  bracketingEntries:   NotificationV1[2]    // the FULL endpoint notifications at fromRevision and toRevision
}
```

The checkpoint is *not* a replacement for the source-of-truth chain; it is a hint summary. The two **bracketing endpoints** are carried as the full endpoint notifications (not bare signatures): a bare threshold signature is not independently verifiable — to prove an endpoint is a real committed revision a subscriber needs the signed payload (the commit digest) and the signers, both of which the full `NotificationV1` carries. `verifyCheckpointEndpoints` runs the standard notification verifier over both endpoints (proving they are real committed revisions) and confirms their revisions equal `fromRevision`/`toRevision`; a forged or tampered endpoint is rejected. The merged digest tells the application "here's what changed across this range." For KV-shaped collections this is enough to know whether to invalidate caches without a chain read. For collections needing exact intermediate state, the checkpoint is not sufficient and the subscriber must fall back to the chain.

**Resolved design questions** (`docs/reactivity.md` open questions, decided in `11.5`):

- **`mergedDigest` semantics → system-level deterministic fold, per-collection override.** `NotificationV1.digest`
  carries the commit-vote signed payload `utf8(commitHash + ":approve")` (see [transactions.md](transactions.md)
  and §Notification origination) — per-revision deterministic and identical across cohort members. The default
  `mergedDigest` is a deterministic running hash `accᵢ = H(accᵢ₋₁ ‖ digestᵢ)` over the per-revision digests in
  revision order, so every member folds to identical bytes (gossip converges). A collection MAY override the
  fold (e.g. a KV collection folding changed-key sets). The merged digest is **not** cryptographically verified —
  it is a hint; the cryptographic anchor is the bracketing endpoints.
- **`mergedDelta` vs `delta_max` → omit when oversize, never split.** Per-revision deltas are coalesced (default:
  ordered concatenation) only when the coalesced result fits within `delta_max`; otherwise `mergedDelta` is
  omitted entirely (the subscriber relies on `mergedDigest` + the resume's `recentEntries`, or chain-reads). A
  checkpoint is a bounded hint — no multi-frame splitting.

`W_checkpoint` defaults to 16× the replay buffer (4096 revisions ≈ 1 hour at 1 cps) and is configurable per collection. Cohorts at tier `d ≥ 1` are the primary holders of checkpoints; the tail cohort holds the current rolling checkpoint, advancing it as revisions retire from the replay buffer.

**Checkpoint span is *layered below* the replay window — this is the authoritative resume semantics.** The checkpoint always covers the `W_checkpoint` revisions immediately under the ring's low edge: `[ringLow − W_checkpoint, ringLow − 1]`, where `ringLow` is the oldest revision still in the replay buffer. The two windows therefore stack rather than overlap, and the **total recoverable range from a single round trip is `W + W_checkpoint`** (≈ 256 + 4096 = 4352 revisions ≈ 72 min at 1 cps), not `W_checkpoint`. A resume is classified by lag against the *stacked* bounds: `lag < W` → `Backfill`; `W ≤ lag < W + W_checkpoint` → `CheckpointWindow`; `lag ≥ W + W_checkpoint` → `OutOfWindow`. (§Failure modes and §Worked scenarios below use these same stacked bounds. The design simulator implements this layered span end-to-end: `RollingCheckpoint` covers `[ringLow − W_checkpoint, ringLow − 1]`, and `classifyResume` cuts over to `OutOfWindow` at `lag ≥ W + W_checkpoint`, agreeing with these stacked bounds.)

### Backfill RPC

> **Implemented** (`11.5-reactivity-backfill-resume-checkpoints`; wire signing + envelope by
> `reactivity-recover-wire-signing`; live libp2p transport by `reactivity-recover-rpc-transport`).
> `serveBackfill` (cohort side) and `createBackfillRequester` (subscriber side, the `requestBackfill`
> seam ↔ RPC) live in `packages/db-core/src/reactivity/backfill.ts`; db-p2p's
> `ReactivitySubscriptionManager` wires the requester to the subscriber's gap-detection seam when a
> backfill transport is supplied. The request is peer-key-signed over `backfillSigningPayload` and the
> live transport (`Libp2pReactivityRecoverTransport` / the recover protocol handler in
> `packages/db-p2p/src/reactivity/recover-transport.ts`) carries it over libp2p.

```
BackfillV1 { v, collectionId, fromRevision, toRevision, timestamp, signature }
BackfillReplyV1 { v, entries: NotificationV1[], available: { fromRevision, toRevision } }
```

Subscribers MAY request a sub-range smaller than `[fromRevision, toRevision]`; cohorts return the intersection with their replay buffer and indicate `available` so the subscriber knows whether to fall back further. When `available.fromRevision` exceeds the requested low edge, the subscriber's lag has fallen past the ring — it escalates to a checkpoint resume or a chain read.

---

## Tail rotation

> **Implemented** (`11.5-reactivity-rotation-backpressure-policy`). The rotation lifecycle is
> `packages/db-core/src/reactivity/rotation.ts`. **Pre-announce**: `buildRotationHint(newTailId,
> fillingRevision)` builds the `rotationHint{ newTailId, effectiveAtRevision = fillingRevision + 1 }`, fired
> on the block-filling commit detected by `BlockFillTracker` (which also fires anticipatory **warm-up** at
> `block_fill_size − warm_threshold`); origination carries it through unchanged (`OriginationContext.rotationHint`).
> **Detection**: `detectRotation(tailIdAtAttach, n)` flags a rotation when the delivered `tailId` *or* the
> `rotationHint.newTailId` differs from `tailIdAtAttach` (db-p2p's `ReactivitySubscriptionManager` invalidates
> the sticky cohort-hint cache and surfaces a `RotationNotice` once per successor tail). **Drain**:
> `TailDrainGate` serves renewals/replays for `T_drain` while bouncing new subscriptions with a
> `Promoted`-shaped `RotationRedirectV1` to the new tree's `topicId`; after `T_drain` it reports `drained`.
> **Jittered re-registration**: `planReRegistration` / `planReRegistrationWave` derive the new `topicId` and
> stagger the move over `T_rejoin_jitter` via the cohort-topic `RejoinJitter` (the wave form hard-bounds the
> new tail's inbound to `cap_promote_fast` per window), carrying the subscriber's `lastRevision` (revisions
> continuous across rotation). **Handoff**: `buildRotationHandoffCheckpoint` folds the outgoing tail's replay
> buffer into a final `CheckpointSummary` over `[lastCheckpoint.toRevision + 1, rotationRevision]` and
> `applyRotationHandoff` lands it on the new tail's `PushState.inheritedCheckpoint`. Forwarder draining is
> emergent (cohort-topic demotion). The `ResumeReplyV1.TailRotated` variant + `latestKnownTailId`-staleness
> classification live in the backfill/resume ticket; this ticket produces the handoff + rotation condition.
> Specs: `rotation.spec.ts`, db-p2p `managers.spec.ts` (rotation detection, rotationHint emission).

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
- **Subscribe / renew RPCs** are signed by the subscriber's peer key and include `correlationId` and `timestamp`; replay protection is handled by the cohort-topic layer (they ride a real `RegisterV1`/`RenewV1` envelope).
- **Recover RPCs (`BackfillV1` / `ResumeV1`)** are signed by the subscriber's peer key over a canonical signing payload (`backfillSigningPayload` / `resumeSigningPayload` — an explicitly-ordered, type-tagged JSON array, mirroring the cohort-topic `registerSigningPayload`). The serving handler verifies the signature against the **dialing peer** (the dialer's peer id *is* the signer — no signer-id field on the wire) and runs a node-level `CorrelationReplayGuard` keyed on the **signature bytes** + the request `timestamp` (the signature is a unique, authenticated token, so no separate `correlationId` is needed). A captured request cannot be replayed with a forged-fresh timestamp — the forged value invalidates the signature.
  - **Subscriber-side signing is synchronous.** The subscription manager's `signBackfill` / `signResume` seam is `(unsigned) => string` (the db-core backfill driver builds the unsigned image internally, so a pre-signed value is impossible), but libp2p's `PrivateKey.sign` is async. The seam is fed by `createRecoverRequestSigners(privateKey)` (db-p2p `recover-transport.ts`), which signs with the synchronous `signPeerSig` (`cohort-topic/peer-sig.ts`) — `@noble/curves/ed25519` over the node's raw Ed25519 seed, the mirror of the synchronous `verifyPeerSig`. noble's RFC8032 signatures are byte-identical to libp2p's async signer for the same key + payload, so the serving handler's verify accepts them. Composing these signers + the `Libp2pReactivityRecoverTransport` into the running node rides the reactivity notification-transport node wiring (`reactivity-notification-transport`).
- **Rotation hints** are part of the notification payload and inherit its signature.
- **Forwarder cohorts do not re-sign.** They pass through the original threshold signature unchanged.
- **Replay-buffer entries** retain the original signature. Backfill responses are verifiable end-to-end.
- **Checkpoint summaries** carry their two endpoints as the **full** bracketing notifications (each retaining its original threshold signature), so a subscriber verifies them with the same end-to-end notification verifier it uses for live notifications — proving both endpoints are real committed revisions. The merged digest is computed deterministically from the bracketed range and is a **hint only** (checked against application-level expectations, never trusted as authority). A forged or tampered endpoint fails verification and the subscriber falls back to the chain — a checkpoint never advances state on its own.

A subscriber needs no trust in any forwarder. The trust root is the tail cohort's membership, which derives from the transaction log.

---

## Per-cohort policy

> **Implemented** (`11.5-reactivity-rotation-backpressure-policy`). The reactivity producer-side policy is
> `packages/db-core/src/reactivity/policy.ts`. `mayServeAsReactivityForwarder(profile)` is
> `profile.willingTiers.has(Tier.T3)` — `false` on every Edge node (Edge's willing set is `{T0, T1}`) and on
> a Core node an operator narrowed off T3. `instantiateForwarderPushState(profile, init)` is the explicit
> gate at the point a node decides whether to become a forwarder: it returns `undefined` for a
> subscriber-only node (the Edge node stays a pure T3 *consumer*, never instantiates a `PushState`), and
> `requireForwarderPushState` throws `ReactivityForwarderForbiddenError` for call sites that treat an Edge
> forwarder attempt as a programming error. `reactivityNodePolicy(profile)` bundles forwarder eligibility
> with the **authoritative** `delta_max` plumbing (Core 4096 / Edge 0, from `config.ts` `deltaMaxForProfile`)
> the origination ticket only consumed. The cohort-topic willingness check already declines T3 admission on
> Edge; this gate makes the reactivity decision explicit and testable. Spec: `policy.spec.ts`.

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
Lag is measured against the *stacked* windows (§Parent checkpoint summaries): the checkpoint sits below the replay buffer, so the bounds add.
- `lag < W` (< 256): one `ResumeV1`, gets `Backfill`. One round trip.
- `W ≤ lag < W + W_checkpoint` (256 … 4351): one `ResumeV1`, gets `CheckpointWindow`. One round trip.
- `lag ≥ W + W_checkpoint` (≥ 4352): `ResumeV1` returns `OutOfWindow`. Subscriber reads the chain to catch up to a current revision, then issues a fresh subscribe.

(The simulator's `classifyResume` cuts over to `OutOfWindow` at `lag ≥ W + W_checkpoint = 4352`, matching the layered bound above — guarded by the `classifyResume cutover aligns with RollingCheckpoint.covers` test.)

### Tail rotation during subscriber outage
Subscriber wakes, sends `ResumeV1` with stale `latestKnownTailId`. The cohort it reaches (under the new tail) responds `TailRotated{ newTailId }`. Subscriber walks the new tree, re-registers, and resumes; replay covers as much as it covers.

### Cohort fully fails during steady-state operation
Standard cohort-topic recovery. Attached subscribers detect via ping failure, re-register from `d_max`. With `T_rejoin_jitter` the post-failure registration rate is bounded.

### Many subscribers, sudden interest spike
Cohort-topic's promotion machinery handles this with `cap_promote_fast`: when the load barometer is hot, the tail cohort fast-promotes after `cap_promote_fast = 32` subscribers rather than waiting for the full `cap_promote = 64`. The tree grows faster than under normal load, spreading subscribers across deeper tiers before the tail saturates.

---

## Wire formats

> **Implemented** (`11-reactivity-origination-replay-delivery`). `SubscribeAppPayloadV1` and
> `NotificationV1` are implemented in `packages/db-core/src/reactivity/wire.ts` exactly as written below:
> JSON, byte fields **base64url** (no padding), **unix-ms** timestamps, per-message structural validation
> on decode, byte-fidelity round-trips. `SubscribeAppPayloadV1` is the opaque `RegisterV1.appPayload`
> (the cohort-topic envelope frames it and carries the `correlationId` + `timestamp` + peer-key
> signature, so the payload itself carries no signature); `NotificationV1` is a length-prefixed frame.
> The `ResumeV1` / `ResumeReplyV1` / `BackfillV1` / `BackfillReplyV1` codecs below are implemented in
> `resume.ts` / `backfill.ts` by `11.5-reactivity-backfill-resume-checkpoints`, same conventions.
> `reactivity-recover-wire-signing` added the `timestamp` freshness field on `BackfillV1`, the canonical
> `backfillSigningPayload` / `resumeSigningPayload` helpers, and the `RecoverRequestV1` / `RecoverReplyV1`
> envelope (`recover.ts`) that the live recover transport frames over the wire.

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
    collectionId:      string
    fromRevision:      number
    toRevision:        number
    mergedDigest:      string
    mergedDelta?:      string
    bracketingEntries: NotificationV1[]   // length 2 — the FULL endpoint notifications (verifiable)
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

> The `checkpoint` carried in a `checkpoint_window` reply is exactly the `CheckpointSummary`
> (§Parent checkpoint summaries) — its endpoints are the **full** bracketing notifications, not bare
> signatures, so the subscriber can verify them end-to-end. The codecs are `encode/decodeResumeV1` and
> `encode/decodeResumeReplyV1` in `packages/db-core/src/reactivity/resume.ts` (JSON, byte fields
> base64url, unix-ms timestamps, per-message structural validation on decode).

### Backfill

```
interface BackfillV1 {
  v:             1
  collectionId:  string
  fromRevision:  number
  toRevision:    number
  timestamp:     number               // unix-ms, bound into backfillSigningPayload (freshness)
  signature:     string               // peer-key sig over backfillSigningPayload(unsigned)
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

### Recover envelope

The backfill and resume exchanges share one libp2p **request-reply** protocol
(`/optimystic/reactivity/1.0.0/recover`); a discriminated wrapper makes the kind authoritative (a
`kind: "backfill"` frame MUST carry a `backfill` body and no `resume` body, and vice-versa). The codecs
are `encode/decodeRecoverRequestV1` / `encode/decodeRecoverReplyV1` in
`packages/db-core/src/reactivity/recover.ts`.

```
interface RecoverRequestV1 { v: 1, kind: "backfill" | "resume", backfill?: BackfillV1, resume?: ResumeV1 }
interface RecoverReplyV1   { v: 1, kind: "backfill" | "resume", backfillReply?: BackfillReplyV1, resumeReply?: ResumeReplyV1 }
```

---

## Configuration

### Defaults

> **Defaults validated by simulator.** `W`, `W_checkpoint`, their ratio, and the *adaptive-`W`*
> question are measured by the design simulator (`packages/substrate-simulator`, `reactivity.ts` →
> `measureCoverage` / `assessAdaptiveW`, and `sweep.ts` `W`/`W_checkpoint` rows). Findings:
>
> - **`W = 256`, `W_checkpoint = 4096`, ratio `16×` — confirmed.** Measured one-round-trip coverage
>   (`coverageSeconds`): at **1 cps**, `W` covers **256 s (≈ 4.3 min)** and `W_checkpoint` **4,096 s
>   (≈ 68 min ≈ 1 hr)**; combined recoverable range `W + W_checkpoint` = **4,352 s (≈ 72 min)**. The
>   `16×` ratio is the gap between a backgrounded-app window (minutes) and an overnight-sleep window
>   (~1 hr) without ballooning per-cohort replay memory. Kept as written.
> - **`W` SHOULD be adaptive per measured cps — REVISED guidance (default value unchanged).** With a
>   60 s recovery floor, fixed `W = 256` is comfortable at 1 cps (256 s, above floor) but **drops
>   below the floor at ≥ 10 cps**: `assessAdaptiveW` flags `belowFloor` and recommends `W ≈ 600` at
>   10 cps and **`W ≈ 6,000` at 100 cps** (where fixed `W = 256` covers only **2.56 s**). The
>   recommendation: keep `W = 256` as the *Edge/low-rate default* but make `W` adaptive on hot
>   collections — `W = ⌈min_coverage_seconds × cps⌉` clamped to a per-cohort memory budget. Downstream
>   `reactivity-backfill-resume-checkpoints` should treat `W` as a per-collection computed value, not
>   a hard constant. `W_checkpoint` scales the same way and may stay a fixed 16× multiple of the
>   resolved `W`.
> - **Tail-rotation burst stays inside `cap_promote_fast`** — peak new-tail root = 32, drains in
>   29,995 ms ≤ `T_drain = 60 s` (see §Worked scenarios). Confirmed.
>
> (Scenarios/sweep: `scenarios.ts` TailRotation, `sweep.ts` `W`/`W_checkpoint` coverage rows,
> `reactivity.ts` `assessAdaptiveW`.)

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

> **Implemented** (`11.5-reactivity-rotation-backpressure-policy`). The consolidated defaults table is
> `packages/db-core/src/reactivity/config.ts` (`DEFAULT_REACTIVITY_CONFIG` + the per-parameter constants);
> every reactivity tunable is sourced from it so the simulator fold-back can revise a value without
> touching protocol code. This ticket owns `queue_max` / `delta_max` / `T_drain` / `warm_threshold` /
> `block_fill_size`; `T_rejoin_jitter` (`T_REJOIN_JITTER_MS`), TTL, and ping are inherited from the
> cohort-topic defaults. `T_drain`, `queue_max`, and `block_fill_size` are flagged
> **simulator-validated-pending**: `resolveQueueMax` is the adaptive hook (parallel to `resolveW`) for the
> simulator's "should `queue_max` scale with cohort size/tier?" finding, defaulting to the static
> `queue_max = 32` until a cohort size is wired through. Spec: `config.spec.ts`.

### Edge profile

In addition to the cohort-topic Edge overrides (TTL = 60 s, ping = 20 s, T2/T3 producer willingness off):

- Subscribers reject inbound notifications carrying `delta` (`deltaMaxBytes = 0` in subscribe payload).
- `cohortHint` is sticky-cached across reconnects so brief network flaps don't trigger re-walk.

---

## Worked scenarios

> **Simulator scenarios.** The tail-rotation scenario below is executed by the simulator's scenario
> runner (`packages/substrate-simulator`, `scenarios.ts` → `TailRotationScenario`, on top of
> `reactivity.ts`'s `simulateRotationBurst` + `CohortPushState`): it validates the re-registration
> wave stays within `cap_promote_fast` at the new tail, completes inside `T_drain`, and that the
> monotonic revision stream stays gap-free. The parameter-sensitivity sweep (`sweep.ts`) quantifies
> the `W` / `W_checkpoint` recovery-coverage tradeoff.
>
> **Measured resume RPC counts + latency** (`reactivity.ts` `traceResume`, `DEFAULT_RESUME_COST`:
> `roundTripMs = 100`, `chainReadMs = 400`, `reResolveRoundTrips = 2`, at `DEFAULT_HOP_MS = 50`):
> a `Backfill` (lag < `W`) and a `CheckpointWindow` (`W ≤ lag < W + W_checkpoint`) each cost
> **1 RPC ≈ 100 ms**; an `OutOfWindow` resume costs **2 RPCs ≈ 500 ms** (resume + chain read); a
> `TailRotated` resume costs **3 RPCs ≈ 300 ms** (stale redirect + 2 re-resolve round trips). The
> 90 s and 20 min wakes below are both single-RPC; only an overnight-plus sleep crosses into the
> 2-RPC chain-read fallback.

### Cold collection becomes popular

`t = 0`: collection `C` has 0 subscribers, tail block `T_0`.

`t = 1`: First subscriber `S_1` registers. `n_est = 1M`, `F = 16`, so `d_max ≈ 4`. `S_1` probes `coord_4(S_1, H(T_0 ‖ "reactivity"))`; cohort there is cold, returns `NoState`. Walk toward root: `d = 3`, `d = 2`, `d = 1`, `d = 0`. The tier-0 cohort (which *is* the tail cohort) accepts; `S_1` is registered as the first subscriber.

`t = 10..60`: `S_2 … S_64` arrive. Each probes `d_max = 4` first; their tier-4 coords differ (different peer-ID prefixes), so the probes fan across the ring. All fall through to the root, which accepts up to `cap_promote = 64`.

`t = 61`: `S_65` arrives, walks to the root, gets `Promoted(1)`. Computes `coord_1(S_65, topicId)`; the tier-1 cohort at that coord instantiates as a forwarder, registers up to the tier-0 (tail) cohort, and accepts `S_65`.

`t = 62 ..`: New subscribers fill tier-1 cohorts in their respective prefix-shards. Each fills to 64, then promotes to tier 2 in its shard. Steady-state depth at 1 M subscribers is `⌈log_16(1M / 64)⌉ = 4` tiers.

### Mobile subscriber wakes after 90 seconds

Phone app resumes. `lastRevision = 1042`. Cached `primary = P_42`. Sends `ResumeV1{from: 1043}`. `P_42`'s replay buffer has revisions 950–1100. Returns `Backfill{entries: [1043..1098], currentRevision: 1098}`. Subscriber processes 56 backfilled notifications, updates `lastRevision = 1098`, resumes. One round trip. **Measured: lag 55 < `W = 256` → `Backfill`, 1 RPC, ≈ 100 ms** (`classifyResume`/`traceResume`).

### Mobile subscriber wakes after 20 minutes

Phone app resumes. `lastRevision = 1042`, current revision is 2342. Replay buffer covers 2086–2342 (256 entries). `ResumeV1{from: 1043}` falls outside the buffer but inside the parent checkpoint `[800, 2085]`. Cohort returns `CheckpointWindow{ checkpoint: [800..2085], recentEntries: [2086..2342] }`. Subscriber applies the checkpoint's merged digest (collection-specific — for a KV collection, this is "these keys changed"), then dedupes against `lastRevision = 1042` for the `recentEntries`. One round trip. **Measured: lag 1,299 falls in `[W, W + W_checkpoint) = [256, 4352)` → `CheckpointWindow`, 1 RPC, ≈ 100 ms.** (The `from = 1043` lands inside the layered checkpoint `[800, 2085]` sitting immediately below the replay ring `2086–2342`, illustrating the stacked-window semantics: `W` covers the head, the checkpoint the next `W_checkpoint` below it.)

### Tail rotation during steady-state load

Collection `C` has 10 000 subscribers, tree depth 3. Tail block `T_5` fills at revision 5400. The notification for revision 5400 carries `rotationHint{ newTailId: T_6, effectiveAtRevision: 5401 }`.

All 10 000 subscribers receive the hint via the existing tree within a few seconds. Each schedules re-registration with random jitter over 30 s. The new tail cohort at `coord_0(_, H(T_6 ‖ "reactivity"))` sees arrival rate ≈ 333 / s; it accepts 64 directly, fast-promotes (`cap_promote_fast = 32`, load bucket hot), and starts redirecting to tier 1. Tier-1 cohorts under `T_6` form during the same window. By `T_drain = 60 s`, the new tree mirrors the old tree's shape under a different root. Forwarder cohorts under `T_5` drain and demote naturally. Continuity is preserved by the monotonic revision sequence; subscribers experience the rotation as a brief pause followed by resumed delivery from the new tree.

> **Measured (validated by simulator).** `TailRotationScenario` (`simulateRotationBurst`) drove a
> 2,000-subscriber re-registration wave jittered over `T_rejoin_jitter = 30 s`: the new tail's
> tier-0 cohort held a **peak of exactly `cap_promote_fast = 32`** direct subscribers (then
> fast-promoted, fanning the rest to tier 1), the **last re-registration landed at 29,995 ms,
> comfortably inside `T_drain = 60 s`**, and a 1,000-revision stream pushed through the replay
> pipeline stayed **monotone and gap-free** (`CohortPushState`). The doc's "333/s" figure for 10,000
> subscribers is the same `subscribers / T_rejoin_jitter` rate the simulator confirms stays within
> the fast-promote bound; scaling the burst changes the tree depth absorbed, not the root cap.

### Cohort failure mid-notification

Tail cohort emits notification for revision 7800. Tier-1 forwarder `F_a` receives, begins fan-out. Mid-fanout, three of `F_a`'s 16 members crash, dropping the cohort to 13 — one below quorum. FRET stabilization promotes successors into the cohort within seconds, restoring quorum; meanwhile attached subscribers whose primary was among the crashed three see ping failures and promote backups. The backups already have the registration record and replay-buffer entries from cohort gossip. Subscribers issue `BackfillV1{from: 7800}`; the new primary serves from the buffer. No notifications are lost.

---

## Mock-tier e2e coverage

> **Implemented** (`reactivity-e2e-mock-tier`). The reactivity hot path + recovery + rotation/backpressure
> run end-to-end over the in-process mock mesh in `packages/db-p2p/src/testing/reactivity-mesh-harness.ts`
> (layered on the cohort-topic mesh harness): real commits flow through the real
> `local-change-notifier-bridge` → real origination (commit cert reused **unchanged**) → real forwarder
> receive path (verify → dedupe → `W`-ring + rolling checkpoint) → the real `ReactivitySubscriptionManager`
> delivery, **verified end-to-end against the tail cohort's `MembershipCertV1` with real Ed25519
> collected-multisig crypto** (no pass-crypto stub). The harness *models* only the notification transport
> (the application protocol that would dial each subscriber's primary / child cohort) and, like the
> matchmaking mock tier, the **single-tier-0 reach**. This **supersedes the intent** of the superseded
> backlog stub [`optimystic-network-reactive-watch-integration-test`] — that stub asked for a single
> networked reactive-watch test; the suites here generalize it to the full reactivity surface at scale. The
> residual *real-libp2p socket* wakeup of a `Database.watch` consumer (the stub's Quereus-bridge concern) is
> the `substrate-e2e-real-libp2p-tier` ticket's, not duplicated here.

Each §Worked scenario / §Failure mode maps to a named test (or a tagged-unimplemented expectation):

| Doc scenario / failure mode | Mock-tier test |
|---|---|
| §Worked — cold collection becomes popular | `mesh-cold-to-hot.spec.ts` *cold collection gains subscribers …* (delivery to every subscriber, contiguous + verified) |
| §Delivery / §Authentication — verify, dedupe, baseline | `mesh-cold-to-hot.spec.ts` *drops an untrusted notification* / *duplicate re-delivery deduped* / *late subscriber adopts baseline* |
| §Worked — tree forms / depth tracks subscriber count | `mesh-cold-to-hot.spec.ts` *[mock-tier] promotion machinery fires …* — **`[unimplemented:mock-tier]`** for the multi-tier *serving* fan-out + quantitative depth regime (cohort-topic follow-ons + simulator) |
| §Worked — mobile wakes after 90 s (`lag < W`) | `mesh-mobile-resume.spec.ts` *lag < W → one Backfill* |
| §Worked — mobile wakes after 20 min (`W ≤ lag < W+W_checkpoint`) | `mesh-mobile-resume.spec.ts` *W ≤ lag < W+W_checkpoint → CheckpointWindow* |
| §Failure — wakes after long sleep (`lag ≥ W+W_checkpoint`) | `mesh-mobile-resume.spec.ts` *lag ≥ W+W_checkpoint → OutOfWindow → chain read* |
| §Failure — tail rotation during outage (stale `latestKnownTailId`) | `mesh-mobile-resume.spec.ts` *stale latestKnownTailId → TailRotated* |
| §Tail rotation — pre-announce + jittered re-registration | `mesh-tail-rotation.spec.ts` *filling commit pre-announces …* / *wave within cap_promote_fast* |
| §Tail rotation — handoff + continuity (no gap) | `mesh-tail-rotation.spec.ts` *delivered stream is continuous across the handoff* |
| §Tail rotation — old-tail drain (serve renewals/replays, bounce new subs) | `mesh-tail-rotation.spec.ts` *drain gate serves renewals/replays and bounces new subscriptions* |
| §Worked — tail rotation during steady load (10k burst, peak = 32) | **`[unimplemented:mock-tier]`** — the at-scale burst magnitude is the design simulator's (`TailRotationScenario`); the mock tier asserts the `cap_promote_fast` bound holds on a real wave |
| §Failure — fan-out interrupted / §Interaction — partition healing | `mesh-partition-healing.spec.ts` *heals via backfill with no loss* / *duplicate deduped* / *sliding dedupe drops exact retransmit* / *forged retransmit rejected* |
| §Failure — slow subscriber on satellite link / §Slow-subscriber backpressure | `mesh-slow-subscriber.spec.ts` *drops-oldest and backfills without stalling fast subscribers* |
| §Per-cohort policy — Edge never forwards | `mesh-slow-subscriber.spec.ts` *Edge subscriber receives but never forwards* |
| §Failure — cohort fully fails / cohort failure mid-notification | **`[unimplemented:mock-tier]`** — cohort crash-failover + backup-promotion is the cohort-topic layer's recovery (`cohort-topic-scale-lifecycle.spec.ts`); reactivity's no-loss-on-failover is exercised via the partition-heal backfill above |

**Window / burst magnitudes are the simulator's.** `W = 256`, `W_checkpoint = 4096`, the `16×` ratio, and
the rotation-burst bound are validated quantitatively by the design simulator (§Configuration / §Worked
scenarios). The mock-tier resume suite drives the **classifier behavior at the stacked boundaries** with
scaled-down `W`/`W_checkpoint` (so it needs a few dozen commits, not thousands) — the variant each lag
produces, not the production magnitudes. Production config is imported from `config.ts`; the mesh suites
never hard-code drifting numbers.

## Real-libp2p e2e coverage

> **Substrate confirmed over real sockets; notification delivery transport deferred.**
> [`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`](../packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts)
> (env-gated) stands up 3–16 production `cohortTopic`-enabled libp2p nodes over real TCP. The **reactivity
> origination wiring** is confirmed real: the production node installs the cohort-topic origination bridge
> (`blockChangeNotifier` is the decorating notifier, not the bare `StorageRepo`), and the real
> `selfIsCohortMember` gate over real FRET agrees node-for-node with `assembleCohort(coord_0(H(tailId ‖
> "reactivity")), wantK)` — the §Anchor membership decision that gates every origination. The notification
> **verify** path is likewise real (the cohort's threshold-signed `MembershipCertV1` is fetched over the real
> `/membership` protocol and verified with real Ed25519 collected-multisig — see cohort-topic §Validation;
> the digest-preimage half is `cohort-topic/reactivity-real-crypto.spec.ts`).
>
> **What is NOT yet real (tagged `it.skip`, not faked):** the notification **socket delivery** itself — a
> commit on a real cohort member firing a `NotificationV1` that reaches a remote subscriber over a real
> socket. Production registers no emit transport / subscriber-delivery protocol (the origination bridge fires
> `onLocalCommit`, but `libp2p-node-base.ts` leaves "the origination manager + emit transport" to a sibling
> ticket). Tracked by `12.5-reactivity-tail-rotation-transport` and the residual backlog
> `optimystic-network-reactive-watch-integration-test` (the real-libp2p `Database.watch` wakeup). **No
> real-network observation here contradicts the simulator** — the design (anchor derivation, cert reuse,
> verify) is confirmed on real libp2p as far as the wired surface reaches.

---

## Interaction with other subsystems

- **Cohort topic** ([cohort-topic.md](cohort-topic.md)) — owns addressing, walks, willingness, promotion/demotion, primary/backup sharding, membership certificates. Reactivity is one application on top.
- **Transaction log** ([transactions.md](transactions.md)) — owns canonical state. Reactivity reuses commit certificates as notification signatures.
- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — ring coordinates, cohort assembly, stabilization. Reached through the cohort-topic layer.
- **Repository** ([repository.md](repository.md)) — supplies the chain-read fallback when subscribers are out of even the parent-checkpoint window.
- **Right-is-Right** ([right-is-right.md](right-is-right.md)) — the threshold-signed notification reuses the commit certificate that Right-is-Right already requires for transaction finality.
- **Partition healing** ([partition-healing.md](partition-healing.md)) — handled at the cohort-topic layer via `cohortEpoch` refresh; reactivity reacts by re-verifying its parent-checkpoint bracketing signatures.
- **Matchmaking** ([matchmaking.md](matchmaking.md)) — sibling application on the same cohort-topic substrate; no direct interaction, but operational cost-sharing benefits flow from running both on the same cohort infrastructure.
