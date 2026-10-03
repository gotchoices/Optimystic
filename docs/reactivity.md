# Reactivity

Push-based change notifications for Optimystic collections, layered on the cohort-topic substrate ([cohort-topic.md](cohort-topic.md)). Reactivity is the **push-tree application** of the cohort-topic layer: one topic per collection, rooted at the collection's current log tail block (the root moves to the new tail block when the log starts one, the tiers below it stay), used to fan out signed notifications to subscribers. See [transactions.md](transactions.md) for the transaction log that drives notifications and [fret.md](../../Fret/docs/fret.md) for the underlying ring overlay.

---

## Overview

Reactivity gives clients a push-based signal when a collection's state changes, without forcing them to poll the chain. A subscriber registers on the collection's topic tree; when the collection commits a transaction, the tail cohort emits a signed notification that fans out through the tree to every active subscriber. The subscriber decides whether to read the new state, fetch a delta, or ignore.

The system is **hint-only**. The transaction log remains the sole authority for collection state. Notifications can be delayed, duplicated, or (rarely) lost without compromising correctness; they exist purely to avoid wasted bandwidth and battery on idle clients.

All addressing, walk semantics, willingness, promotion, demotion, and primary/backup sharding are inherited from the cohort-topic layer. This document specifies only the parts unique to push notification:

- **Root rotation with the collection's tail block**: the announcing group is the tail block's storage group and changes with it, while the topic and the tiers below the root stay fixed.
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

## Anchor: one topic per collection, a root that follows the tail

A collection has one reactivity topic for its whole life. The tree's root is placed at the collection's current log tail block, so the root moves when the log starts a new block; the tiers below the root are addressed by the topic and never move.

```
topicId(C)        = H(utf8(C.collectionId) ‖ "reactivity")        (stable for the collection's life)
coord_0           = H(tailId)                                       (the root: the tail block's storage group; moves on rotation)
coord_d(P)        = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)          (d ≥ 1; never moves)
```

`collectionId` is the UTF-8 of the id exactly as blocks carry it (`reactivityCollectionIdBytes` in `packages/db-p2p/src/reactivity/topic-bytes.ts`), the same bytes a notification names its collection by, so origination and every subscriber derive one topic (`reactivityCollectionTopicId` in `packages/db-core/src/reactivity/topic-anchor.ts`). The root (announcing) group is the tail block's storage group — the `clusterSize` serving peers nearest `H(tailId)` — rather than a cohort of `wantK` peers around a hash of the topic; the tail's routing key travels as the topic's `rootKey` ([cohort-topic.md §Root placement at a routing key](cohort-topic.md#root-placement-at-a-routing-key)), and `coord_0` is the routing coordinate the key network assigns `routingKeyForBlock(tailId)` (the raw utf8 of the id; see §Origination point).

When the tail rotates (the current tail block fills and a new tail block is born) only the root moves, to the new tail's storage group: a rotation is "same topic, the root moved". The cohort-topic layer keeps the topic and moves its root ([cohort-topic.md §Root placement at a routing key](cohort-topic.md#root-placement-at-a-routing-key), *The root can move*). A rotation re-links at most `F` tier-1 child cohorts to the new root (deferred; see §Rotation cost) and moves the root's direct subscribers, which register again under the new root key; nothing below the root re-registers (see [Tail rotation](#tail-rotation)).

### What stays fixed, and what that costs

The tiers below the root sit at fixed positions for the collection's life: `coord_d(P, topicId)` depends on the subscriber and the topic, not on the tail. That is a weaker form of the "no permanent target" argument the rotating anchor used to make — a tier-1 cohort of a popular collection is a long-lived position an attacker can find. It is accepted because that load is spread over `F` tier-1 cohorts by the subscriber-prefix sharding and bounded by the cohort-topic intake caps (`cap_promote`, the per-peer register rate, the topic budget; [cohort-topic.md §Anti-flood properties](cohort-topic.md#anti-flood-properties)), and because the root, which carries every notification, still rotates with the tail block, so the one position that handles every commit is never long-lived. What rotating the whole tree cost — every subscriber re-registering every `block_fill_size` commits, so that a busy collection's tree was permanently rebuilding — is what this gives up re-rotating the lower tiers to avoid.

---

## Subscription

Subscribing to collection `C` is a normal cohort-topic registration with:

- `topicId` = `H(collectionId ‖ "reactivity")` — the collection's topic (§Anchor)
- `rootKey` = `routingKeyForBlock(currentTailId(C))` — the walk's root step goes to the tail's storage group (§Origination point); the subscription follows the tail as the log moves
- `tier` = `T3` (luxury)
- `appPayload` = `SubscribeAppPayloadV1` (see [Wire formats](#wire-formats))
- `ttl` = configured TTL (Edge default 60 s, Core default 90 s)

The walk-toward-root from `d_max`, the willingness-driven member selection, the `Promoted`/`UnwillingMember`/`UnwillingCohort` reply set, and the TTL renewal protocol are all the cohort-topic standard.

### Subscriber-side state

```
ActiveSubscription {
  collectionId:    bytes                    // stable, for identifying the subscription
  topicId:         bytes                    // the collection's topic (stable)
  tail:            bytes                    // the latest tail block followed: the topic's current root key
  primary:         PeerId
  backups:         PeerId[]
  cohortHint:      PeerId[]                 // for fast re-attach
  cohortEpoch:     bytes                    // for membership-drift detection
  lastRevision:    revision
  lastDeliveredAt: timestamp
  attachedAt:      timestamp
}
```

`tail` is what detects a rotation: a notification announced at another tail (its `tailId` differs, or its `rotationHint` names a successor), a recover reply redirecting from a draining root, and the watch service's tail read finding another block all compare against it, and `ReactivitySubscriptionManager.followTail` in `packages/db-p2p/src/reactivity/subscription-manager.ts` replaces it. The register payload's `tailIdAtAttach` is the tail at that registration (§Wire formats). The cohort-topic-level `cohortEpoch` detects cohort membership churn within a topic.

### The node's watch service

On a running node an application does not build any of this itself. A node created with `cohortTopic.enabled` carries `reactivityWatch` (`ReactivityCollectionWatch` in `packages/db-p2p/src/reactivity/collection-watch.ts`, typed on `OptimysticNodeAttachments` in `packages/db-p2p/src/optimystic-node.ts`), and one call starts a watch:

```ts
const handle = node.reactivityWatch.watch({
  collectionId: 'app/users',                      // exactly as blocks carry it
  readTail: (knownTailId) => /* { tailId, revision } of the committed log, or undefined */,
  onChange: () => { /* coarse: no payload */ },
});
await handle.close();
```

`watch` returns at once and never fails for network reasons; everything else runs in the background:

- **Open the watch, then read.** A commit that the caller's read did not see wakes the watcher. The service cannot know what a caller has read, so the first committed tail it reads for a collection wakes that collection's watchers once, whether or not anything changed: a commit landing between the caller's read and that first tail read would otherwise be reported by nothing.
- **One subscription per collection per node.** Every watch of a collection shares one subscription — one `ReactivitySubscriptionManager` and one handler in the node's `ReactivitySubscriberRegistry`, both for the subscription's whole life; the subscription closes with its last handle.
- **Attach.** The service reads the tail, registers the manager's handler under the collection's topic, then registers with the cohort under the tail as the root key. A registration under a topic nobody has registered under before is normally deferred by the cohort (its members have not yet exchanged the willingness that admits one), and the retry is the next tick, so a first attach measured about 30 s on a three-node Core mesh. The watcher is still woken in the meantime, by the tick below.
- **The tick.** At the renewal cadence (TTL / 3: 30 s Core, 20 s Edge) the service renews the registration, reads the tail again, wakes the watchers if the revision is above the last one they were woken for, and has the manager follow the tail if the block is a different one: a registration at the root registers again under the new root key, one below the root sends nothing and only updates the root key a later re-walk would use (`moveRoot`). This is what bounds every failure the push path cannot rule out — a lost notification, a failed registration, a tail rotation nobody announced, a commit that was never announced at all — to one tick of delay. It costs one tail read per watched collection per tick.
- **Recovery.** A gap is backfilled over the recover RPC. When the cohort cannot serve the gap, the watchers are woken anyway and the next tail read moves the manager's contiguity head to the revision it read, so one unservable gap does not turn every later notification into another backfill request.

`Collection.readCommittedTail` in `packages/db-core/src/collection/collection.ts` is the `readTail` a host needs: it reads the header and tail block without opening a collection handle. The service hands `readTail` the tail block id its previous read found; passed on as `readCommittedTail`'s third argument, it makes the read one request instead of two while the log stays on that block.

**Collection ids on the wire.** A collection id is a path such as `app/users`, which is not base64url, so a notification names its collection by the base64url of the id's UTF-8 bytes (`reactivityCollectionIdBytes` in `packages/db-p2p/src/reactivity/topic-bytes.ts`). Origination (`liveOriginationContext` in `packages/db-p2p/src/reactivity/origination-manager.ts`) and the watch service call that one function; the `topic-bytes-encoding` spec pins that they agree and that the result passes `validateNotificationV1`.

### Forwarder-cohort state (per root served)

A reactivity forwarder cohort holds the cohort-topic-standard registration records plus notification state per **root**: one `PushState` for each log tail block this node has served as a collection's root, kept under that tail (the notification's `tailId`, the base64url of `reactivityTailBytes(tail)`), as are the ingest serialization and the rotation drain gate beside it (`ReactivityForwarderHost` in `packages/db-p2p/src/reactivity/forwarder-host.ts`). A topic has one root per tail block over the collection's life, and a machine serving both the outgoing root (during its drain window) and the new one keeps their replay rings, dedupe sets and gates apart by that key. Once a root fans out to child cohorts (backlog `feat-reactivity-notifications-reach-child-cohorts`), a tier-`d ≥ 1` forwarder's state is per served coordinate and outlives rotations, since its position does not move. Lookups that start from a collection rather than a tail (`pushStateForCollection`) pick the served root with the highest `lastRevision`.

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

**Only for a root someone subscribed to.** A node builds this state for a root on the first notification it handles there while the root has at least one direct subscriber, and not before (child cohorts will count too, once a cohort can have children; `hasDemand` in `packages/db-p2p/src/reactivity/forwarder-host.ts`). A collection whose announcements the node originates but nobody watches — an index tree, the Quereus plugin's schema tree, a table not tagged for network change notification — therefore costs no replay ring, no dedupe window and no push-state gossip frame per round, so enabling the feature for one table leaves every other table as it was. The check reads the root's subscribers the way a fan-out does (on a running node, a lookup of the root-placed cohort engine at the tail's root coordinate, then a scan of that engine's registration records for the topic), once for each notification at a root that has no state yet; a "nobody subscribed" answer is not remembered, so the first notification after a registration lands builds the state. Once built, the state stays until a tail rotation's drain window closes, even after its last subscriber leaves (the `NOTE:` at `served` in the same file names the remedy if that ever shows in memory).

**What a late subscriber gets.** A subscriber attaches with the collection's current revision as its starting point. A commit that lands between that read and the registration reaching the cohort is buffered nowhere, so the subscriber's next notification shows a gap; the backfill finds nothing to serve and escalates, and the watch service ([§The node's watch service](#the-nodes-watch-service)) answers an unservable gap by waking its watchers, while its tick re-reads the tail regardless. The watcher therefore wakes; it does not learn the missed revision from the cohort, which whole-table invalidation does not need. Cohort members other than the primary learn of the subscriber when its registration record reaches them over cohort gossip, so they build state a little later; until then a backfill reaching one of them declines and the recover transport tries the next member.

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
>
> The manager's `emit` seam is now bound to live fan-out (`12.33-reactivity-notification-transport`): the
> node assembly installs the hook and routes each built `NotificationV1` into `ReactivityForwarderHost.ingest`,
> so origination travels over the notify protocol to subscribers. Every party derives the tree's root
> coordinate from `reactivityTailBytes(tailId) = utf8(tailId)` — the tail's routing key (`routingKeyForBlock`),
> never a pre-hashed digest — through `reactivityRootCoord` in `packages/db-core/src/reactivity/topic-anchor.ts`;
> `topic-bytes-encoding.spec.ts` pins that this equals the key network's `hashKey(routingKeyForBlock(tail))`,
> the cross-implementation contract the whole placement rests on.

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
  sig:          thresholdSig                // = commit cert; signers ≥ ceil(|root group| × superMajorityThreshold)
  signers:      PeerId[]
  rotationHint?: { newTailId, effectiveAtRevision }   // see Tail rotation
}
```

The `sig` field is bit-for-bit the same threshold signature the transaction layer produces. A subscriber cryptographically threshold-verifies it against the root group's membership — the tail block's storage group, the same trust root it must already accept to trust the collection at all — over `b64urlToBytes(digest)`, the exact `utf8(commitHash + ":approve")` image each group member signed. So notifications introduce **no new signing authority** beyond the commit certificate, yet are not trusted blindly: the verify runs against real Ed25519 (see [Authentication and integrity](#authentication-and-integrity)).

### Notification kinds: commit vs. invalidation

A notification announces one of two committed changes, distinguished by an optional typed marker:

- a **commit** (the marker is absent) — the subscriber refreshes to the new revision;
- an **invalidation** (`invalidation: true`, plus `invalidatedActionId`) — a durable reversal of a previously-committed action proven invalid by dispute (`docs/right-is-right.md` §Durable Invalidation, §Client Notification). An invalidation is a committed collection change like any other, so it rides this same path and reuses the **invalidation's** own commit cert as `sig`, verified by the subscriber exactly like a commit notification (a forwarder can drop it but cannot forge one — it lacks the root group's threshold signature).

The marker is a **hint, not a gate** — the same contract the `delta` field already carries. It lets an invalidation-aware client *react* (drop derived results and resubmit through the optimistic loop) rather than merely refresh, and lets it coalesce the several notifications one dispute's cascade can emit by `invalidatedActionId`. A subscriber that ignores the marker still converges: it re-reads the authoritative reverted state, and the durable `committed-invalidated` status is always available on a pull (`NetworkTransactor.getStatus`). Correctness never depends on the push arriving. The marker round-trips through the wire codec (`NotificationV1.invalidation` / `invalidatedActionId`); `buildNotificationV1` sets it from the `CollectionChangeEvent`.

### Origination point

**Root at the tail's storage group.** A collection's reactivity tree is rooted at its log tail block's own ring position: `coord_0` for a reactivity topic is the routing coordinate the key network assigns `routingKeyForBlock(tailId)`, not `H(0x00 ‖ topicId)`. The root (announcing) group is the tail block's storage group, chosen by the same rule the key network uses for storage — `findCluster`'s network-scoped selection, with reactivity's root `wantK` equal to `clusterSize` — so the machines that apply a commit are exactly the machines that announce it. Every party that derives the root group — the origination gate, the notification verifier, the subscriber's registration walk and the forwarder — uses that one rule.

**Threshold from the verifier's side.** A notification carries the commit certificate as its signature. A verifier accepts it when its signers are members of the root group it derived itself and number at least `ceil(|root group| × superMajorityThreshold)` — the same threshold the commit certificate is captured under (`captureCommitCert`). The threshold is never read from the notification. The cohort-topic default `minSigs` (14) does not apply to the reactivity root.

> **Implemented.** The key network exposes its storage rule in coordinate form (`servingCohortAt` in
> `packages/db-p2p/src/libp2p-key-network.ts`, the same assembly `findCluster` builds a block's cohort with),
> and the node binds it as the cohort-topic host's `rootGroup` together with the consensus
> `superMajorityThreshold` (`createLibp2pNodeBase` in `packages/db-p2p/src/libp2p-node-base.ts`). The
> origination gate is `selfAppliedTail` in `packages/db-p2p/src/cohort-topic/change-bridge.ts`: a change event
> originates iff it names a tail and that tail is among the blocks this node applied — the node is then in
> the tail's storage group as the commit's coordinator chose it, with no ring read of its own. That excludes a
> read-driven promotion (no tail) and the sweep commit that lands a collection's data blocks, or the old
> tail's `nextId` rewrite on a rollover, on another group: that group holds a certificate for the same action
> but did not apply the tail. The verifier (`createNotificationVerifier` in
> `packages/db-core/src/reactivity/verify.ts`) derives the root coordinate from the notification's tail and
> verifies under a `RootPlacement` built from the node's own ratio; the subscriber's register names the tail
> as `rootKey` (`ReactivitySubscriptionManager.register`), so the walk's root step dials the storage group;
> the push-state gossip gate and the recover transport read the root group of the tail each push state joined
> under. The mock-tier harness models a tail's storage group as the `wantK` members nearest its root
> coordinate (`setupRootPlacedTopic` in `packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts`).
>
> **What still only the coordinator announces.** In a storage group of three or fewer, only the member that
> coordinated a commit retains a full certificate (the `NOTE:` at `captureCommitCert` in
> `packages/db-p2p/src/cluster/cluster-repo.ts`), so one member originates per commit. A group of one
> (`clusterSize: 1`, the Quereus plugin's node) never produces a certificate and never announces; the watch
> service's tail check is what wakes a watcher of such a collection.
>
> **Two views of the group.** The certificate's signers come from the coordinator's `findCluster`; the
> membership a verifier checks them against comes from the root node's own view. Under churn the two can
> differ: a signer outside the published group makes the notification untrusted, and the watch service's
> tail check (about 30 s) still wakes the watcher. `superMajorityThreshold` is likewise each verifier's own
> value; consensus already requires one value per deployment, and reactivity adds no check of its own.
>
> **Reversibility and cost.** Reversible until announcements ship to deployments on mixed versions; after that
> any anchor change is a protocol break — a subscriber on an older build registers and verifies at the old
> coordinate and does not interoperate with a root on this one. The root group already handles every commit;
> it now also serves its direct subscribers.

### Delta payloads

The `delta` field is optional and bounded by `delta_max` (default: 4 KB at Core profile, 0 at Edge profile — Edge subscribers reject any inbound `delta` and re-read the chain instead, since paying for the delta wire bytes when CPU is the bottleneck is the wrong tradeoff). Whether to include a delta is a per-collection configuration; collections whose typical delta is larger than `delta_max` simply omit it.

---

## Propagation

> **Implemented** (`12.31-reactivity-forwarder-host`). The receive→forward→fan-out orchestration is the
> db-p2p `ReactivityForwarderHost` (`packages/db-p2p/src/reactivity/forwarder-host.ts`): `ingest(topicId, n)`
> lazily instantiates the per-collection `PushState` + forwarder behind the Edge policy gate
> (`mayServeAsReactivityForwarder`), and only for a topic with a subscriber (§Forwarder-cohort state),
> serializes ingests per topic so the replay ring + dedupe never
> interleave, runs the db-core forwarder receive path, and on `"forward"` fans the **unmodified** frame out
> to every direct subscriber (through `PushState.perSubscriberQueue`) and child cohort. `onInbound` drives
> both the subscriber and forwarder roles for an inbound dial. It is **encoding-agnostic** over the
> subscriber-id space and depends only on the `ReactivityNotifyTransport` interface, so it is unit-testable
> with a fake transport; the libp2p node assembly that supplies a concrete transport and routes inbound
> frames by topic is `reactivity-notification-transport`. Spec: `forwarder-host.spec.ts`.
>
> **Now live** (`12.33-reactivity-notification-transport`). The node assembly (`libp2p-node-base.ts`,
> `cohortTopic`-enabled block) composes the notify transport + forwarder host + push-state-gossip driver and
> binds origination's `emit` seam to `ReactivityForwarderHost.ingest`, so a committed change on a tail-cohort
> member fans out over the real `/optimystic/reactivity/1.0.0/notify` protocol to remote subscribers, and
> inbound frames route by topic to `onInbound` (forwarder role) and the node-level
> `ReactivitySubscriberRegistry` (subscriber role). The subscriber-id / dial-target space is the canonical
> peer-id string (the transport dials with `peerIdFromString`); `directSubscribers` maps cohort member bytes
> with `bytesToPeerIdString`, never base64url. Specs: `node-wiring.spec.ts`, `topic-bytes-encoding.spec.ts`,
> and the env-gated real-socket delivery in `substrate-real-libp2p.integration.spec.ts`.

The root group member that applied the commit delivers the signed notification to:

- Every direct subscriber (via each subscriber's primary assignment as held in the cohort-topic registration record).
- Every entry in `childCohorts`, addressed to that child's primary.

A receiving forwarder cohort's primary:

1. Verifies the threshold signature against the root group's `MembershipCertV1` ([cohort-topic.md §Membership snapshots](cohort-topic.md#membership-snapshots-and-signature-verification)), under the root placement threshold (§Origination point).
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

1. Verifies `sig` against the cached `MembershipCertV1` for the root group — the tail's storage group — at `ceil(|group| × superMajorityThreshold)` (with one fetch-and-retry fallback for stale-cache cases).
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
>
> **Cross-rotation resume** (`12.51-reactivity-rotation-resume-handoff-and-redirect-codec`, extended to the
> stacked checkpoint chain by `reactivity-rotation-inherited-window-bridge`). When a cohort took over as the
> new tail across a rotation it holds the outgoing tail's handoff in `PushState.inheritedCheckpoint` (§Tail
> rotation step 5). `classifyResume`/`serveResume` consult it (via the optional `inherited` param /
> `ResumeServingDeps.inheritedCheckpoint`) when the rolling checkpoint misses: a resume whose `fromRevision`
> falls below both the ring and the rolling checkpoint but inside the inherited window is served as
> `CheckpointWindow` instead of falling to `OutOfWindow`. The rolling checkpoint wins when both cover
> `fromRevision`.
>
> **Stacked checkpoint chain ⇒ the full cross-rotation range recovers in one reply.** The `CheckpointWindow`
> reply carries an ordered, contiguous **chain** of `CheckpointSummary`s (`checkpoints`, low→high), not a
> single summary. The serving cohort builds the **shortest** gap-free chain that both covers `fromRevision`
> and abuts the ring's low edge (`resumeCheckpointChain`): the rolling checkpoint alone (steady state), the
> inherited handoff alone (right after a rotation, while it still abuts the ring), or the two-link
> `[inherited, rolling]` **bridge** once the new tail has evicted post-rotation revisions into its *own*
> rolling checkpoint sitting between the inherited window and the ring. So a cross-rotation resume recovers
> the full stacked `W + W_checkpoint` range in one round trip regardless of where the new tail's rolling
> checkpoint has formed — there is no rotation-specific shortfall. The subscriber verifies **every** link's
> bracketing endpoints before applying anything (a single forged link rejects the whole reply, no partial
> advance), then applies each link's merged digest and rebaselines through the chain. Because each link keeps
> its **own already-correct** merged digest and is applied independently, nothing is ever re-folded across
> windows — a per-collection `fold` override composes identically to the default fold. A peer predating the
> chain field fails the reply closed and chain-reads (safe). Only a genuinely unbridgeable gap (the inherited
> window's high edge sits below the rolling checkpoint's low edge — the new tail evicted past the handoff
> seam, so the request is > `W + W_checkpoint` behind) falls to `OutOfWindow`.

A subscriber resuming from sleep sends:

```
ResumeV1 { v, collectionId, fromRevision, latestKnownTailId, subscriberCoord, timestamp, signature }
```

to its cached `primary` (or any cohort member if primary is stale). The cohort responds with one of:

- `Backfill { entries, currentRevision }` — `fromRevision` is within the replay window. Subscriber replays entries, dedupes, and is current. Single round trip.
- `CheckpointWindow { checkpoints, recentEntries }` — `fromRevision` is older than the buffer but within parent-checkpoint range (see below). The reply carries an ordered, contiguous **chain** of checkpoint summaries (`checkpoints`, low→high); the subscriber verifies every link's bracketing endpoints, applies each link's merged digest, advances its contiguity head past the whole chain, then replays the recent entries. The chain is a single link in steady state. A cohort that took over as the new tail across a rotation answers from its **inherited handoff checkpoint** when the rolling one misses — either as a single inherited link (it abuts the live ring) or as the two-link `[inherited, rolling]` **bridge** once the new tail's own rolling checkpoint has formed between the inherited window and the ring (§Tail rotation step 5) — so the full cross-rotation range recovers in one reply. The rolling checkpoint wins when both cover `fromRevision`.
- `OutOfWindow { currentTailId, currentRevision }` — `fromRevision` is older than even the parent checkpoint (and, on a new tail, older than the inherited handoff checkpoint too). Subscriber falls back to a chain read, then a fresh subscribe.
- `TailRotated { newTailId, newRevisionAtRotation }` — `latestKnownTailId` is stale. Subscriber follows the new tail and replays from the new root. This is classified **first**: a stale tail means the root moved, so the lag-against-windows classification is moot. (The rotation *lifecycle* is owned by [reactivity-rotation-backpressure-policy]; this resume path only *detects* the stale tail.)

**Resume-on-rotation → keep the simple full walk (resolved, `11.5`).** On `TailRotated` the subscriber follows the new tail; a registration at the root re-registers via the ordinary walk from `d_max`. The Edge **sticky `cohortHint` cache** already shortcuts the *common* case — a brief flap with no rotation resumes against the cached primary in one round trip (the cache is invalidated only on an actual `TailRotated`, so a stale-root primary is never reused). A pre-dial toward the pre-announced successor coord (from the `rotationHint`) is **deferred to the rotation ticket**: it requires rotation-side announce state (the successor coord is not knowable until the filling commit), so it belongs with the rotation lifecycle rather than the resume classifier.

**Resume reaching a *draining outgoing* tail → `kind: "rotated"` redirect (`12.52-reactivity-rotation-recover-redirect-drain`).** The four classifications above answer a resume reaching the cohort that still *originates* the requested tail, or — for a resume whose `latestKnownTailId` is stale — the **new** tail (which replies `TailRotated`, or serves from its inherited handoff checkpoint). A subscriber that instead reaches the **old, rotated** cohort *while it is still draining* is not lagging — its root moved — but that cohort's served `PushState.tailIdAtJoin` still names the old tail, so `serveResume` would classify it as an ordinary `Backfill`/`CheckpointWindow` and **never tell it to move** (it would catch up to `rotationRevision`, then go silent forever — the old tail originates nothing further). So the old cohort **records that it rotated** (`ReactivityForwarderHost.markRotated` starts a `TailDrainGate` keyed by the old tail) and, while draining, its **recover** serve returns the drain `RotationRedirectV1` as a `kind: "rotated"` reply — emitted *ahead of* the windows classification for a resume whose `latestKnownTailId` anchors the old tail. The outbound transport raises that reply as a terminal `RotationRedirectError` (it does **not** fall through to the next cohort member — the dialed member answered authoritatively); the subscriber honors it through the **same** jittered `onRotation` re-registration seam a delivered pre-announce uses, so the notify-driven and recover-driven rotation paths converge on one `RotationNotice`. After `T_drain` the cohort evicts the old tail's `PushState` (`rotationRedirectFor`), so a member with no served state declines (a zero-length reply, which the transport reads as "no result") and the transport tries the next cohort member; only when every candidate declines does recovery reject, and the subscriber re-walks / chain-reads. See §Tail rotation step 2.

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
> `reactivity-recover-wire-signing`; live libp2p transport by `reactivity-recover-rpc-transport`; **node
> wiring live** by `reactivity-recover-node-wiring`). `serveBackfill` (cohort side) and
> `createBackfillRequester` (subscriber side, the `requestBackfill` seam ↔ RPC) live in
> `packages/db-core/src/reactivity/backfill.ts`; db-p2p's `ReactivitySubscriptionManager` wires the
> requester to the subscriber's gap-detection seam when a backfill transport is supplied. The request is
> peer-key-signed over `backfillSigningPayload` and the live transport
> (`Libp2pReactivityRecoverTransport` / the recover protocol handler in
> `packages/db-p2p/src/reactivity/recover-transport.ts`) carries it over libp2p. The transport is now
> **registered + exposed on the running node** (`libp2p-node-base.ts`, `cohortTopic` block): the recover
> request-reply handler serves from the forwarder host's live `PushState`s, so a remote subscriber's
> backfill/resume is answered over a real socket by any cohort member that holds the gossiped state.

```
BackfillV1 { v, collectionId, fromRevision, toRevision, timestamp, signature }
BackfillReplyV1 { v, entries: NotificationV1[], available: { fromRevision, toRevision } }
```

Subscribers MAY request a sub-range smaller than `[fromRevision, toRevision]`; cohorts return the intersection with their replay buffer and indicate `available` so the subscriber knows whether to fall back further. When `available.fromRevision` exceeds the requested low edge, the subscriber's lag has fallen past the ring — it escalates to a checkpoint resume or a chain read.

**Backfill reaching a *draining outgoing* tail → `kind: "rotated"` redirect (best-effort, `12.52`).** Like a resume (§Resume), a backfill reaching the **old, rotated** cohort while it is still draining is answered with the drain `RotationRedirectV1` (`kind: "rotated"`) instead of stale entries, so an active subscriber that detected its gap against the old tail is moved to the new root. This is a **secondary** path — the primary mechanism for an active subscriber is notify-driven rotation detection (§Tail rotation). Because the backfill request carries only a `collectionId`, the redirect is keyed by the collection's *current served* tail: once the new tail's `PushState` coexists, `pushStateForCollection` resolves the **new** tail (highest `lastRevision`) and the backfill is served normally — so the redirect is emitted only while the node serves **solely** the old draining tail. The subscriber honors it via the same terminal `RotationRedirectError` → `onRotation` seam the resume path uses, off the detached gap seam (it never faults the commit/delivery path).

---

## Tail rotation

> **Implemented** (`11.5-reactivity-rotation-backpressure-policy`). The rotation lifecycle is
> `packages/db-core/src/reactivity/rotation.ts`. **Pre-announce**: `buildRotationHint(newTailId,
> fillingRevision)` builds the `rotationHint{ newTailId, effectiveAtRevision = fillingRevision + 1 }`, fired
> on the block-filling commit detected by `BlockFillTracker` (which also fires anticipatory **warm-up** at
> `block_fill_size − warm_threshold`); origination carries it through unchanged (`OriginationContext.rotationHint`).
> **Detection**: `detectRotation(followed, n)` flags a rotation when the delivered `tailId` differs from the
> tail the subscriber last followed at a revision above any it has seen, *or* the `rotationHint.newTailId`
> differs from that tail; a differing `tailId` at a revision already seen is a late delivery from a tail the
> subscriber has moved past, since the old and the new root deliver independently (db-p2p's
> `ReactivitySubscriptionManager` invalidates the sticky cohort-hint cache and surfaces a `RotationNotice` once
> per successor tail, and only for a notification that verified). **Drain**:
> `TailDrainGate` serves renewals/replays for `T_drain` while bouncing new subscriptions with a
> `Promoted`-shaped `RotationRedirectV1` naming the new tail (its `newTopicId` is the collection's unchanged
> topic); after `T_drain` it reports `drained`.
> The **live recover wiring** (`12.52-reactivity-rotation-recover-redirect-drain`) drives the gate from the
> running node's recover serve: the old cohort's `ReactivityForwarderHost.markRotated` records the rotation
> (idempotent; advances to a later successor on a chained OLD→A→B), `rotationRedirectFor` returns the redirect
> as a `kind: "rotated"` recover reply while draining and then evicts the gate **and** the old tail's served
> `PushState`, the outbound `Libp2pReactivityRecoverTransport` raises a terminal `RotationRedirectError`, and
> the subscriber honors it through the same jittered `onRotation` re-registration seam a pre-announce uses.
> **Jittered re-registration**: `planReRegistration` / `planReRegistrationWave` carry the new tail and
> stagger the follow over `T_rejoin_jitter` via the cohort-topic `RejoinJitter` (the wave form hard-bounds the
> new tail's inbound to `cap_promote_fast` per window), carrying the subscriber's `lastRevision` (revisions
> continuous across rotation). **Handoff**: `buildRotationHandoffCheckpoint` folds the outgoing tail's replay
> buffer into a final `CheckpointSummary` over `[lastCheckpoint.toRevision + 1, rotationRevision]` and
> `applyRotationHandoff` lands it on the new tail's `PushState.inheritedCheckpoint`. Tiers below the root do
> not drain on a rotation: only the old root stops receiving commits and releases its state after `T_drain`. The `ResumeReplyV1.TailRotated` variant + `latestKnownTailId`-staleness
> classification live in the backfill/resume ticket; this ticket produces the handoff + rotation condition.
> Specs: `rotation.spec.ts`, db-p2p `managers.spec.ts` (rotation detection, rotationHint emission).
>
> **Live-node rotation is observe-on-tail-id-change** (`12.54-reactivity-rotation-host-wiring-e2e`, the
> capstone composition). On a running node the pre-announce `rotationHint{ newTailId }` **cannot** be built:
> block ids are random (`TransactorSource.generateId() → randomBytes(32)`; deterministic derivation is the
> blocked backlog `6.5-block-id-derivation`), so at the filling commit the host does not know the successor
> tail id. The authoritative, observable signal on the host is therefore a commit naming a tail other than the
> one this node last announced at — a *hard* rotation: `ReactivityOriginationManager.observeTailCommit`
> remembers per collection the tail this node last applied a commit for and, when an event names a different
> tail, fires `markRotated(oldTail, { newTailId, effectiveAtRevision: event.rev }, now)` (`oldTail` is
> `reactivityTailBytes(tail)`, the bytes the forwarder host keys that root's state by). The change bridge hands
> it **every** commit event that names a tail, not only the ones this node announces: the old tail's group and
> the new tail's are mostly different machines once the network is wider than one group, and a machine only
> in the old group never applies a commit naming the new tail. What it applies is the rollover's rewrite of
> the old tail block's `nextId`, whose event names the new tail — so that machine marks the rotation, drains
> and releases the old root too. A same-tail event this node did not apply (a data-block sweep landing on a
> member of the tail's group) leaves the remembered tail in place, and an event at or below the remembered
> revision that names another tail — an older commit's sweep landing after the rollover — is ignored, so a late
> event can never mark the live root rotated back to a tail the log left. **A subscriber registered at the old
> root is not sent the new root's notifications**, so on a live node a delivered `tailId` never names a later
> tail than the one it last followed (that detection, `detectRotation` → `RotationNotice`, fires only where a
> successor can be pre-announced). It can name an *earlier* one: the old root's last notifications and the new
> root's first are sent by different machines, so one announced at the old tail can arrive after the
> subscriber followed the new one, and `detectRotation` tells it apart by revision rather than following it
> back.
> A live subscriber moves in one of two ways. The watch service's tick (§Subscription) reads the collection's
> tail and, finding a different tail block, has the manager follow it — a registration at the root registers
> again under the new root key, one below the root only updates its root key — with no added jitter, since each subscription's tick started when its watch opened and
> subscribers are already spread over the tick interval. And a subscriber that sends a recover request to
> the old cohort inside its drain window is redirected (`kind:"rotated"`), which surfaces a `RotationNotice`
> that the scheduler turns into the same move. Until one of those happens — up to one tick — a root-direct
> subscriber hears nothing from the network and the tick's revision check is what wakes it. A subscriber
> below the root is in the same position before and after the move, for another reason: no root fans out to
> child cohorts yet (backlog `feat-reactivity-notifications-reach-child-cohorts`), so it hears nothing from
> any root and the tick wakes it. The pre-announce + anticipatory warm-up remain
> exercised in the **mock-tier harness** (`mesh-tail-rotation.spec.ts`) and the design simulator (both can
> synthesize the successor id) and are documented as gated on `6.5`; warm-up on a live node is **signal-only**
> (logged, never fabricating a successor coord). The node composition binds origination's `markRotated` → the
> forwarder host, the recover serve's `rotationFor` → `ReactivityForwarderHost.rotationRedirectFor`, and
> constructs + exposes an unref'd-timer `RotationReRegistrationScheduler` (`node.reactivityRotation`). One
> scheduler serves every subscription on the node; each manager's `onRotation` schedules through it and its
> `reRegister(plan)` is the watch service's move (`ReactivityCollectionWatch.reRegister`). Specs:
> db-p2p `mesh-tail-rotation.spec.ts` (redirect-driven re-registration with no gap; cross-rotation resume from
> the inherited checkpoint), `node-wiring.spec.ts` (scheduler exposed + torn down), `managers.spec.ts`
> (`observeTailCommit` marks the old tail in the reactivity tail encoding, including on a machine that only
> rewrote the old tail, keeps its baseline through a sweep, and ignores a late older commit), `change-bridge.spec.ts` (the observer sees
> events the origination gate drops), `collection-watch.spec.ts` (a follow re-registers only a registration at the root, a failed move,
> a close during a move).

- **Decided, not built: the outgoing root does not tell its direct subscribers.** A machine in the old tail's
  group could, at the rollover commit, send its direct subscribers a notification under the old tail carrying
  `rotationHint{ newTailId }`, so they learn of the move at once instead of at their next tail check. The move
  it would trigger still waits on the subscriber's re-registration jitter (`T_rejoin_jitter`, 30 s uniform) and
  on the new root deferring a first registration (backlog
  `feat-a-new-topic-admits-its-first-registration-without-a-second-ask`, about 30 s measured) — the same order
  as the tail check it would replace — so it would save about one notification's latency per log block, at
  the cost of a second notification path that runs only on old-group machines holding a certificate for the
  rollover commit (in a group of three or fewer, only the coordinator does). Revisit if the cold-start deferral
  is removed and the root's direct subscribers on busy collections show the tail check as their dominant wake
  latency.

The tail block changes when a block fills (`block_fill_size`, the log's `EntriesPerBlock` of 32 entries). Rotation moves the tree's root — and only the root — to the new tail block's ring coordinate; the topic and the tiers below the root stay.

### Rotation protocol

1. **Pre-announce.** While committing the block-filling transaction, the outgoing tail cohort embeds `rotationHint{ newTailId, effectiveAtRevision }` in the notification. The hint reaches every active subscriber via the existing tree.

2. **Drain.** The outgoing tail cohort continues to accept renewals and serve replays for `T_drain` (default 60 s) after rotation. New subscriptions are rejected with a `Promoted`-shaped redirect (`RotationRedirectV1 { v, result: "rotated", newTailId, newTopicId, effectiveAtRevision }`) to the new root: `newTailId` is the new root key a receiver acts on, and `newTopicId` carries the collection's unchanged topic (the field predates the stable topic). The redirect is serialized by `validateRotationRedirectV1` and **rides the recover reply envelope as `kind: "rotated"`** (`RecoverReplyV1`, §Wire formats) — the recover request-reply protocol is the only reactivity surface a subscriber reaches a serving cohort on, since a fresh subscribe rides generic cohort-topic `service.register` whose walk understands only tier-`Promoted`, never a topic redirect. A peer predating the `"rotated"` kind fails the reply closed and chain-reads (safe), so the redirect is an optimization, never a correctness dependency.

   The same redirect also moves an **already-attached** subscriber that reaches the outgoing cohort over recover (`12.52-reactivity-rotation-recover-redirect-drain`). On the running node the old cohort *records that it rotated* — `ReactivityForwarderHost.markRotated(oldTail, { newTailId, effectiveAtRevision }, now)` starts a `TailDrainGate` keyed by the old tail, the key the root's served state is kept under — driven by origination seeing a commit that names a later tail (`ReactivityOriginationManager.observeTailCommit`, fed every tail-bearing commit, so a machine only in the old tail's group drains and releases too). While `rotationRedirectFor(oldTail, now)` reports the gate is draining, the recover serve returns the `kind: "rotated"` redirect for a `ResumeV1` whose `latestKnownTailId` anchors the old tail (and, on a node that serves only the draining tail, for an underflowing `BackfillV1`) **instead of** serving stale `backfill`/`checkpoint_window` data. Without this the old cohort's `serveResume` — whose `PushState.tailIdAtJoin` still names the old tail — would classify the request as an ordinary lag, feed it up to `rotationRevision`, and then go silent forever (the old tail originates nothing further), stranding the subscriber. After `T_drain` the gate's drain window closes: the gate **and** the served `PushState` are evicted (the forwarder demotes naturally) — by `rotationRedirectFor` when a recover request asks about that tail, or by the next `markRotated` for any collection, which sweeps every closed window so the tails of collections nobody recovers against do not accumulate — so a member that no longer serves the tail declines the next recover request and the transport tries the next cohort member; only when every candidate declines does recovery reject, and the subscriber re-walks/chain-reads onto the new root.

3. **Subscriber follow with jitter.** Subscribers, on receiving the rotation hint, schedule a follow of the new tail with random jitter over `T_rejoin_jitter` (default 30 s). Only a registration at the root re-registers (under the new root key, on the same topic; the service displaces the old record, which expires by TTL at the old root); a registration below the root updates the root key its next re-walk names (`moveRoot`) and sends nothing. The follow carries the subscriber's existing `lastRevision`; revisions are continuous across rotations, so no replay confusion.

   The db-p2p **host scheduler** that performs this is `RotationReRegistrationScheduler` (`reactivity/rotation-rereg-scheduler.ts`, `12.53-reactivity-rotation-rereg-scheduler`). The `ReactivitySubscriptionManager` surfaces a `RotationNotice{ newTailId, preAnnounced, plan }` once per successor (both the notify-driven pre-announce and the recover-driven `RotationRedirectError` converge on it); the scheduler consumes a notice, arms a one-shot timer for `max(0, plan.fireAt − now())`, and on fire invokes an injected `reRegister(plan)` that has the subscription follow the new tail. It injects `setTimer` + `now` for deterministic tests (defaulting to an **unref'd** `setTimeout`/`Date.now`, mirroring the push-state-gossip driver's unref'd timer so an idle re-registration never pins a process), de-dupes by successor tail (`plan.newTailId`, base64url — not by topic, which every successor shares) so a redirect+pre-announce pair for the same successor moves once, and isolates+logs a failed `reRegister` (no retry this pass). A chained OLD→A→B before A's timer fires arms two independent timers (both may fire — self-corrected by the manager's `rotationHandledFor`); `cancel(newTailId?)` / `stop()` tear pending timers down. On a node the injected `reRegister` is `ReactivityCollectionWatch.reRegister`, and a move that fails is retried by that service's next tick. **Where the stagger lives:** `plan.fireAt` is drawn by the *manager's* `rejoinJitter` via the single-subscriber planner `planReRegistration` → `scheduleRejoin`, a **uniform** offset over `T_rejoin_jitter` (default 30 s). Each subscriber jitters independently, so the load-bearing knob on this path is the **window** (not a `capPromote`); the new root sees ≈ `root-direct subscribers / T_rejoin_jitter` arrivals/s, and that burst is absorbed on the *receiving* side by the new tail cohort's `cap_promote_fast` fast-promotion (see §Rotation cost and the Worked scenario) — a cohort-topic promotion mechanism, independent of the jitter's `capPromote`. (`RejoinJitter.capPromote` is consulted only by the *wave* planner `scheduleWave` / `planReRegistrationWave`, which the production manager does not use; were the composing site to adopt the wave planner it would then need `createRejoinJitter({ capPromote: DEFAULT_CAP_PROMOTE_FAST })` = 32, since the default cap is the cohort-failure `cap_promote = 64`.) The node composition that binds the scheduler to each manager's `onRotation` observer is the watch service (§Subscription).

4. **Only the old root drains.** Tier-`d ≥ 1` cohorts sit at positions the rotation does not move and keep their subscribers; nothing under them demotes or re-forms. The old root stops receiving commits (the log has left its tail block) and releases its state after `T_drain` (step 2).

5. **Replay-buffer handoff to checkpoint.** As the outgoing tail cohort drains, it folds its replay buffer into a final `CheckpointSummary` covering `[lastCheckpoint.toRevision + 1, rotationRevision]` and hands it to the new tail cohort (`buildRotationHandoffCheckpoint` → `applyRotationHandoff`, landing on `PushState.inheritedCheckpoint`). This is the only state migration across rotations. The new tail cohort holds the old checkpoint to serve `ResumeV1` requests that span the rotation: `classifyResume`/`serveResume` consult the inherited checkpoint after the rolling one misses (§Resume), so a cross-rotation resume is answered as `CheckpointWindow` rather than `OutOfWindow`. The reply carries an ordered checkpoint chain, so the new tail serves the inherited handoff alone (while it still abuts the new ring) **or** the two-link `[inherited, rolling]` bridge once the new tail's own rolling checkpoint has formed between the inherited window and the ring — recovering the full cross-rotation range in one round trip regardless (see §Resume).

### Anticipatory warm-up

When a tail block reaches `block_fill_size − warm_threshold` (default 56 of 64) transactions, the outgoing tail cohort opportunistically pre-dials toward the likely-successor coord. The next `tailId` is not knowable until the filling commit, so this is best-effort: the cohort biases FRET pre-dialing toward peers whose ring position is consistent with high-probability successor coords. No state is migrated until the actual rotation.

### Rotation cost

Rotation happens every `block_fill_size` = 32 log entries. Per rotation the re-registrations are the root's direct subscribers only — at most `cap_promote` = 64, since the root promotes past that — rather than every subscriber: at 10 commits/s that is at most about 20 re-registrations per second against the new root instead of about 3,000 for 10,000 subscribers, each one register walk fanned over `T_rejoin_jitter` (derived from the defaults, not measured). A subscriber below the root re-registers nothing; it keeps its registration and only its next re-walk names the new root. **The other half of the decision — a rotation re-links at most `F` tier-1 child cohorts to the new root — is deferred** to backlog `feat-reactivity-notifications-reach-child-cohorts`: no root fans out to child cohorts yet, so a subscriber below the root hears nothing from any root and is woken by the watch service's tail check, before and after this change.

---

## Authentication and integrity

- **Notifications** carry the root group's threshold signature, which *is* the commit certificate from the transaction layer. Signature verification uses the standard cohort-topic membership-snapshot path ([cohort-topic.md §Membership snapshots](cohort-topic.md#membership-snapshots-and-signature-verification)) under the root placement rule: the verifier derives the root coordinate from the notification's tail and requires `ceil(|root group| × superMajorityThreshold)` signers, its own ratio, never the cohort-topic `minSigs` and never a value off the wire (§Origination point).
- **Subscribe / renew RPCs** are signed by the subscriber's peer key and include `correlationId` and `timestamp`; replay protection is handled by the cohort-topic layer (they ride a real `RegisterV1`/`RenewV1` envelope).
- **Recover RPCs (`BackfillV1` / `ResumeV1`)** are signed by the subscriber's peer key over a canonical signing payload (`backfillSigningPayload` / `resumeSigningPayload` — an explicitly-ordered, type-tagged JSON array, mirroring the cohort-topic `registerSigningPayload`). The serving handler verifies the signature against the **dialing peer** (the dialer's peer id *is* the signer — no signer-id field on the wire) and runs a node-level `CorrelationReplayGuard` keyed on the **signature bytes** + the request `timestamp` (the signature is a unique, authenticated token, so no separate `correlationId` is needed). A captured request cannot be replayed with a forged-fresh timestamp — the forged value invalidates the signature.
  - **Subscriber-side signing is synchronous.** The subscription manager's `signBackfill` / `signResume` seam is `(unsigned) => string` (the db-core backfill driver builds the unsigned image internally, so a pre-signed value is impossible), but libp2p's `PrivateKey.sign` is async. The seam is fed by `createRecoverRequestSigners(privateKey)` (db-p2p `recover-transport.ts`), which signs with the synchronous `signPeerSig` (`cohort-topic/peer-sig.ts`) — `@noble/curves/ed25519` over the node's raw Ed25519 seed, the mirror of the synchronous `verifyPeerSig`. noble's RFC8032 signatures are byte-identical to libp2p's async signer for the same key + payload, so the serving handler's verify accepts them. These signers + the `Libp2pReactivityRecoverTransport` are composed into the running node by the recover node wiring (`reactivity-recover-node-wiring`): `libp2p-node-base.ts`'s `cohortTopic`-enabled block registers the recover request-reply handler (`registerRecoverHandler`) against the forwarder host's live `PushState`s, constructs the outbound transport over the production dialer, and exposes the transport + signers + a node-level sticky cohort-hint cache (`reactivityRecover` / `reactivityRecoverSigners` / `reactivityCohortHintCache`) for the subscribe factory that constructs managers (the deferred Quereus `Database.watch` bridge).
- **What the threshold signature covers.** `sig` is the commit certificate, signed over the commit-vote payload the `digest` carries — and nothing else. `collectionId`, `tailId`, `revision`, `timestamp` and `rotationHint` are **not** authenticated by it. Inbound notifications are routed by `collectionId` to the collection's subscribers, so a forwarder can make a genuine notification wake another collection's watchers, skew a `revision`, or attach a false `rotationHint`; each costs a watcher a wake and a backfill or tail read, which the hint-only contract accepts (the log is the authority, and the watch service's tail check settles what the collection's revision and tail actually are). A notification cannot be forged outright: `sig` must verify against the root group derived from its `tailId`.
- **Forwarder cohorts do not re-sign.** They pass through the original threshold signature unchanged.
- **Replay-buffer entries** retain the original signature. Backfill responses are verifiable end-to-end.
- **Checkpoint summaries** carry their two endpoints as the **full** bracketing notifications (each retaining its original threshold signature), so a subscriber verifies them with the same end-to-end notification verifier it uses for live notifications — proving both endpoints are real committed revisions. The merged digest is computed deterministically from the bracketed range and is a **hint only** (checked against application-level expectations, never trusted as authority). A forged or tampered endpoint fails verification and the subscriber falls back to the chain — a checkpoint never advances state on its own.

A subscriber needs no trust in any forwarder. The trust root is the root group's membership — the tail block's storage group, which derives from the transaction log — and a subscriber distant from that group checks the membership certificate it fetches against the group's own commit record rather than trusting it on first use. The verifier's placement names the tail (`RootPlacement.rootKey`, the bytes the root coordinate is derived from), and the node's `CommitLogTrustAnchor` in `packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts` asks every member of the tail's storage group for the tail block's latest certified commit proof (`BlockCommitProof`, verified offline by `certifyClaim` in `packages/db-p2p/src/cluster/certified-claims.ts` against the claimed block, revision and action) and compares the certificate's signers with the committing cohort that proof names: every signer in it anchors the certificate, none rejects it as a forgery, and a partial overlap — membership churned between the tail's last commit and the certificate — leaves it undecided for the attestation chain or the next commit to settle. The highest certified revision wins, two certified actions at one revision are an equivocation and anchor nothing, and one anchoring set is kept per tail for the renewal cadence. The host asks its FRET anchor first, so a node inside the group judges from its own snapshot and never queries. Two limits remain. A certified proof says the listed cohort signed, not that it is the tail's legitimate cohort (`feat-cluster-membership-threshold-cert-anchoring`); the proof is fetched from the group this node's own key network names for the tail, the group its reads and writes of that block already go to, so the anchor ties reactivity trust to the trust the node already places in the collection's data and no further. And a transient failure to anchor — no group member answered inside its budget, a tail revision with no retained proof — still admits a self-consistent certificate on first use, where it stays cached until a verify-miss refetches it (the `NOTE:` at `composeTrustAnchors` in `packages/db-p2p/src/cohort-topic/host.ts`).

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
Subscriber wakes, sends `ResumeV1` with stale `latestKnownTailId`. The cohort it reaches (under the new tail) responds `TailRotated{ newTailId }`. Subscriber follows the new tail (a registration at the root registers again under it) and resumes against the new root. That resume is classified against the new tail's stacked windows *plus* the inherited handoff checkpoint it holds, served as an ordered checkpoint chain (the inherited handoff alone, or the `[inherited, rolling]` bridge), so a cross-rotation resume within `W + W_checkpoint` recovers in one round trip — no rotation-specific shortfall (§Resume, §Tail rotation step 5).

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
> The codecs below are implemented by `11.5-reactivity-backfill-resume-checkpoints`, same
> conventions: `ResumeV1` and `ResumeReplyV1` in `packages/db-core/src/reactivity/resume.ts`,
> `BackfillV1` and `BackfillReplyV1` in `packages/db-core/src/reactivity/backfill.ts`.
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
  checkpoints?: {                          // ordered low→high, contiguous chain (1 link steady state, 2 for the cross-rotation bridge)
    collectionId:      string
    fromRevision:      number
    toRevision:        number
    mergedDigest:      string
    mergedDelta?:      string
    bracketingEntries: NotificationV1[]   // length 2 — the FULL endpoint notifications (verifiable)
  }[]
  recentEntries?:     NotificationV1[]
  // out_of_window:
  currentTailId?:     string
  currentRevision?:   number
  // tail_rotated:
  newTailId?:             string
  newRevisionAtRotation?: number
}
```

> The `checkpoints` carried in a `checkpoint_window` reply are an ordered, contiguous chain of
> `CheckpointSummary`s (§Parent checkpoint summaries) — each `checkpoints[i].fromRevision ===
> checkpoints[i-1].toRevision + 1`, validated on decode. Each link's endpoints are the **full** bracketing
> notifications, not bare signatures, so the subscriber can verify every link end-to-end. The chain is a
> single link in steady state and the two-link `[inherited, rolling]` bridge for a cross-rotation resume
> (§Resume, §Tail rotation step 5). The codecs are `encodeResumeV1` / `decodeResumeV1` and
> `encodeResumeReplyV1` / `decodeResumeReplyV1` in `packages/db-core/src/reactivity/resume.ts` (JSON, byte fields base64url, unix-ms timestamps,
> per-message structural validation on decode).

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
are `encodeRecoverRequestV1` / `decodeRecoverRequestV1` and `encodeRecoverReplyV1` /
`decodeRecoverReplyV1` in `packages/db-core/src/reactivity/recover.ts`.

```
interface RecoverRequestV1 { v: 1, kind: "backfill" | "resume", backfill?: BackfillV1, resume?: ResumeV1 }
interface RecoverReplyV1   { v: 1, kind: "backfill" | "resume" | "rotated", backfillReply?: BackfillReplyV1, resumeReply?: ResumeReplyV1, rotated?: RotationRedirectV1 }
```

A subscriber only ever *asks* for `backfill`/`resume`, so the **request** discriminant stays narrow; a **reply** may additionally be `kind: "rotated"`, carrying the drain-window `RotationRedirectV1` a still-draining outgoing tail hands back (§Tail rotation step 2, §Resume, §Backfill RPC). The db-p2p outbound transport raises a `kind: "rotated"` reply as a terminal `RotationRedirectError`; a peer predating the kind fails the decode closed (fail-safe — it treats the reply as malformed and chain-reads).

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
| `block_fill_size` | 32 | Entries per log block (`EntriesPerBlock`; drives tail rotation) |

> **Implemented** (`11.5-reactivity-rotation-backpressure-policy`). The consolidated defaults table is
> `packages/db-core/src/reactivity/config.ts` (`DEFAULT_REACTIVITY_CONFIG` + the per-parameter constants);
> every reactivity tunable is sourced from it so the simulator fold-back can revise a value without
> touching protocol code. This ticket owns `queue_max` / `delta_max` / `T_drain` / `warm_threshold` /
> `block_fill_size`; `T_rejoin_jitter` (`T_REJOIN_JITTER_MS`), TTL, and ping are inherited from the
> cohort-topic defaults. `T_drain` and `queue_max` are flagged
> **simulator-validated-pending** (`block_fill_size` is the log's `EntriesPerBlock`, not a tunable): `resolveQueueMax` is the adaptive hook (parallel to `resolveW`) for the
> simulator's "should `queue_max` scale with cohort size/tier?" finding, defaulting to the static
> `queue_max = 32` until a cohort size is wired through. Spec: `config.spec.ts`.

### Operating envelope

> **Operating envelope (measured).** The validity-envelope finder (`packages/substrate-simulator`,
> `boundary.ts` + `boundary-reactivity.ts`) measures, per reactivity claim, the **edge** at which it
> flips pass→fail along a monotone-in-harm axis and the **margin** to the design's operating point —
> re-derived from the committed simulator (`findBoundary` per axis, deterministic from `(seed, config)`).
> Both reactivity claims sit **inside** their envelope.
>
> - **`revision-continuity` vs commit rate `cps`** (§Replay window, §Resume; justifies `W` and the
>   adaptive-`W` recommendation). A reconnecting subscriber must resume from inside the recovery window
>   for a 60 s reconnect gap. Holds for **`cps < 72.5`** against the **layered** window
>   `W + W_checkpoint = 256 + 4096 = 4352` (margin **+62.5** to the nominal 10 cps, ≈ 7.25×). At the
>   edge the layered window covers ≈ 60 s — exactly the reconnect gap — and just past it the resume
>   classifies `OutOfWindow`.
>   - **Layered-bound consistency.** This `cps*` is stated against the **layered** `W + W_checkpoint`
>     bound that §Parent checkpoint summaries is authoritative on (the windows stack), and the simulator
>     path **agrees**: `classifyResume` cuts over to `OutOfWindow` at `lag ≥ W + W_checkpoint`
>     (`reactivity.ts`), so the measured edge (`cps* · 60 ≈ 4351` revisions, just under 4352) is the
>     layered edge. The far more conservative **replay-only** edge (single `W = 256` buffer) is
>     `cps ≈ 4.27` — *below* the nominal 10 cps — so a fixed `W = 256` alone cannot cover the 60 s
>     recovery floor at the nominal rate. That gap is exactly the **adaptive-`W`** finding above: the
>     stacked checkpoint window carries continuity to ≈ 72.5 cps; the single replay buffer does not, so
>     hot collections need `W = ⌈min_coverage_seconds × cps⌉`.
> - **tail-rotation drain (`completes-within-drain`) vs `T_rejoin_jitter / T_drain` ratio** (§Tail
>   rotation; justifies `T_drain`). The re-registration wave must land before the old tail stops
>   forwarding. Holds for ratio **`< 1.0`** (margin **+0.5** to the shipped ratio
>   `30 s / 60 s = 0.5`, i.e. 2× slack). At the shipped ratio the wave drains via fast-promote fan-out
>   (the new root fills to `cap_promote_fast = 32` and the tree spreads — `viaPromotionFanout`), so the
>   pass is a real margin, not the tautology that arrivals in `[0, T_rejoin_jitter)` always precede
>   `T_drain`. Just past ratio 1.0 the wave's last arrival (≈ 60,105 ms) outlasts the `T_drain = 60 s`
>   forwarding window. `T_drain = 60 s` is what buys the 2× margin against a wider rejoin spread.
>   (2,000 subscribers.)

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

`t = 1`: First subscriber `S_1` registers. `n_est = 1M`, `F = 16`, so `d_max ≈ 4`. `S_1` probes `coord_4(S_1, H(T_0 ‖ "reactivity"))`; cohort there is cold, returns `NoState`. Walk toward root: `d = 3`, `d = 2`, `d = 1`, then the root step to `T_0`'s storage group at `H(T_0)` (the root is placed at the tail's routing key, §Origination point). That group — the tail cohort — accepts; `S_1` is registered as the first subscriber.

`t = 10..60`: `S_2 … S_64` arrive. Each probes `d_max = 4` first; their tier-4 coords differ (different peer-ID prefixes), so the probes fan across the ring. All fall through to the root, which accepts up to `cap_promote = 64`.

`t = 61`: `S_65` arrives, walks to the root, gets `Promoted(1)`. Computes `coord_1(S_65, topicId)`; the tier-1 cohort at that coord instantiates as a forwarder, registers up to the tier-0 (tail) cohort, and accepts `S_65`.

`t = 62 ..`: New subscribers fill tier-1 cohorts in their respective prefix-shards. Each fills to 64, then promotes to tier 2 in its shard. Steady-state depth at 1 M subscribers is `⌈log_16(1M / 64)⌉ = 4` tiers.

### Mobile subscriber wakes after 90 seconds

Phone app resumes. `lastRevision = 1042`. Cached `primary = P_42`. Sends `ResumeV1{from: 1043}`. `P_42`'s replay buffer has revisions 950–1100. Returns `Backfill{entries: [1043..1098], currentRevision: 1098}`. Subscriber processes 56 backfilled notifications, updates `lastRevision = 1098`, resumes. One round trip. **Measured: lag 55 < `W = 256` → `Backfill`, 1 RPC, ≈ 100 ms** (`classifyResume`/`traceResume`).

### Mobile subscriber wakes after 20 minutes

Phone app resumes. `lastRevision = 1042`, current revision is 2342. Replay buffer covers 2086–2342 (256 entries). `ResumeV1{from: 1043}` falls outside the buffer but inside the parent checkpoint `[800, 2085]`. Cohort returns `CheckpointWindow{ checkpoints: [[800..2085]], recentEntries: [2086..2342] }` (a single-link chain in steady state). Subscriber applies the checkpoint's merged digest (collection-specific — for a KV collection, this is "these keys changed"), then dedupes against `lastRevision = 1042` for the `recentEntries`. One round trip. **Measured: lag 1,299 falls in `[W, W + W_checkpoint) = [256, 4352)` → `CheckpointWindow`, 1 RPC, ≈ 100 ms.** (The `from = 1043` lands inside the layered checkpoint `[800, 2085]` sitting immediately below the replay ring `2086–2342`, illustrating the stacked-window semantics: `W` covers the head, the checkpoint the next `W_checkpoint` below it.)

### Tail rotation during steady-state load

Collection `C` has 10 000 subscribers, tree depth 3: at most `cap_promote` = 64 of them registered at the root, the rest in tier-1 to tier-3 cohorts under it. Tail block `T_5` fills at revision 5400. Where a successor is knowable (the mock tier), the notification for revision 5400 carries `rotationHint{ newTailId: T_6, effectiveAtRevision: 5401 }`; on a live node the root's direct subscribers learn of the move from their next tail check or a recover redirect.

The root moves to `T_6`'s storage group at `H(T_6)`; the topic does not change. The ≤ 64 root-direct subscribers follow with random jitter over 30 s — about two re-registrations per second against the new root, which accepts them directly. Tiers 1–3 stay exactly where they are: their coordinates are a function of the topic, every registration below the root keeps its place, and only the root key a later re-walk would name moves (`moveRoot`). Nothing under the old root drains; the old root serves recover requests with a redirect for `T_drain = 60 s` and then releases its state. Continuity is preserved by the monotonic revision sequence. Re-linking the tier-1 cohorts to the new root, so notifications reach the tiers below it again, is deferred to backlog `feat-reactivity-notifications-reach-child-cohorts`; until then subscribers below the root are woken by the watch service's tail check.

> **Measured (validated by simulator, for the previous design).** The simulator's `TailRotationScenario` measured the whole-tree re-registration wave the earlier rotating-anchor design produced, in which every subscriber re-registered on every rotation; this design no longer produces that wave, so the figures below bound a cost that is now at most `cap_promote` re-registrations per rotation. `TailRotationScenario` (`simulateRotationBurst`) drove a
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
> delivery, **verified end-to-end against the root group's `MembershipCertV1` with real Ed25519
> collected-multisig crypto** (no pass-crypto stub) under the root placement rule. The harness *models* the
> notification transport (the application protocol that would dial each subscriber's primary / child
> cohort), a tail's storage group (the `wantK` members nearest its root coordinate, so the root is placed
> and verified exactly as on a node) and, like the matchmaking mock tier, the **single-tier-0 reach**. The suites cover
> the reactivity surface at scale; the real-libp2p wakeup of a watch is covered in §Real-libp2p e2e
> coverage, and a `Database.watch` consumer's by ticket
> `quereus-tables-opt-in-to-network-change-notification`.

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
| §Tail rotation — only the root moves (tiers below keep their registrations) | `mesh-tail-rotation.spec.ts` *tiers below the root survive a rotation* |
| §Worked — tail rotation during steady load (10k burst, peak = 32) | **`[unimplemented:mock-tier]`** — the at-scale burst magnitude is the design simulator's (`TailRotationScenario`, measured for the previous whole-tree wave); the mock tier asserts the `cap_promote_fast` bound holds on a real wave of root-direct subscribers |
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

> **Substrate AND notification socket delivery confirmed over real sockets.**
> [`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`](../packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts)
> (env-gated) stands up 3–16 production `cohortTopic`-enabled libp2p nodes over real TCP. The **reactivity
> origination wiring** is confirmed real: the production node installs the cohort-topic origination bridge
> (`blockChangeNotifier` is the decorating notifier, not the bare `StorageRepo`), and on every node the root
> group at a tail's root coordinate (`servingCohortAt`) is the cohort `findCluster` stores the tail with —
> the one placement rule of §Origination point. The notification **verify** path is likewise real (the
> group's threshold-signed `MembershipCertV1` is fetched over the real `/membership` protocol and verified
> with real Ed25519 collected-multisig under the root placement rule — see cohort-topic §Validation; the
> digest-preimage half is `cohort-topic/reactivity-real-crypto.spec.ts`).
>
> **Notification socket delivery is now wired and exercised** (`12.33-reactivity-notification-transport`): a
> commit on a real tail-cohort member fires a `NotificationV1` that reaches a remote subscriber over the real
> `/optimystic/reactivity/1.0.0/notify` socket — the subscriber is constructed against the remote node's
> `ReactivitySubscriberRegistry`, receives the frame, and verifies it end-to-end with real Ed25519 against the
> root group's membership. `libp2p-node-base.ts` now installs the origination manager's `emit` →
> `ReactivityForwarderHost.ingest`, registers the notify + push-state-gossip protocol handlers, and routes
> inbound frames to the registry. **No real-network observation here contradicts the simulator** — the design
> (anchor derivation, cert reuse, verify, socket fan-out) is confirmed on real libp2p.
>
> **Recover (resume/backfill) socket delivery is now wired and exercised** (`reactivity-recover-node-wiring`):
> a remote subscriber that slept past the live tail's last delivered revision sends one `ResumeV1` over the real
> `/optimystic/reactivity/1.0.0/recover` request-reply socket to a real tail-cohort member and is brought current
> (the backfill variant) — the recovery analogue of the notification socket-delivery test. `libp2p-node-base.ts`
> registers the recover serve handler (`registerRecoverHandler`) against the forwarder host's live `PushState`s,
> verifying the request's peer-key signature against the dialing peer and gating it through a node-level
> `CorrelationReplayGuard`. The subscriber's request is signed with the node's real recover signers
> (`createRecoverRequestSigners`) and carried by the production dialer. (The test pins the recover transport to
> the origin for determinism; the sticky-primary → cohort-walk target selection is unit-covered by
> `reactivity/recover-transport.spec.ts`.)
>
> **The watch service is exercised with nothing faked** (`network-collection-watch-service`): on three real
> nodes a watch opened through one node's `reactivityWatch` wakes after another node commits a row through
> its own `NetworkTransactor`. The commit certificate comes from real cluster consensus, the registration from
> the real register walk, and the membership certificate from the cohort's own publication — the three things
> the cases above hand-build. The case passes only on a wake with no tail read between the commit and the
> wake, so the fallback tick cannot be what passed it. It also runs the real collection id (`app/watched-rows`)
> through the wire, which the earlier cases avoided by inventing ids that were already base64url. The mesh is
> configured so every machine is in every cohort (`clusterSize` = `cohortTopic.wantK` = 3, `minSigs` 2).
>
> **The same watch on a mesh wider than one storage group** is the reproduction of the defect root placement
> fixes (`reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`): six machines with
> `clusterSize` 3 and the production cohort-topic defaults (`wantK` 16, `minSigs` 14, neither of which governs
> a root). A watch opened on a machine outside the tail's storage group registers with the group through
> the walk's root step, a commit coordinated by a group member is announced by it, and the watcher is woken
> by a frame its subscriber registry received, with no tail read in between. Before root placement the
> announcing group was a FRET cohort disjoint from the storage group on a ring this wide, so no commit was
> announced and none would have verified.
>
> **The real-libp2p `Database.watch` wakeup is exercised too** (`quereus-tables-opt-in-to-network-change-notification`):
> [`packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts`](../packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts)
> runs the same three-node, every-machine-in-every-cohort mesh with a Quereus `Database` on each node, over the
> node handed to the plugin. A table declared `with tags ("optimystic.network_watch" = true)` on the watching
> node wakes its `Database.watch` after another node inserts a row. The watcher's storage listener is replaced
> with an inert one, so the wake cannot come from local storage, and as above the case passes only on a wake
> with no tail read on the watcher between the insert and the wake. An untagged sibling table on the same
> watcher stays asleep after an insert into it.
>
> **Still deferred (tagged, not faked):** the tail-rotation-specific *redirect* on socket delivery
> (`12.5-reactivity-tail-rotation-transport`).

---

## Interaction with other subsystems

- **Cohort topic** ([cohort-topic.md](cohort-topic.md)) — owns addressing, walks, willingness, promotion/demotion, primary/backup sharding, membership certificates. Reactivity is one application on top.
- **Transaction log** ([transactions.md](transactions.md)) — owns canonical state. Reactivity reuses commit certificates as notification signatures.
- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — ring coordinates, cohort assembly, stabilization. Reached through the cohort-topic layer.
- **Repository** ([repository.md](repository.md)) — supplies the chain-read fallback when subscribers are out of even the parent-checkpoint window.
- **Right-is-Right** ([right-is-right.md](right-is-right.md)) — the threshold-signed notification reuses the commit certificate that Right-is-Right already requires for transaction finality.
- **Partition healing** ([partition-healing.md](partition-healing.md)) — handled at the cohort-topic layer via `cohortEpoch` refresh; reactivity reacts by re-verifying its parent-checkpoint bracketing signatures.
- **Matchmaking** ([matchmaking.md](matchmaking.md)) — sibling application on the same cohort-topic substrate; no direct interaction, but operational cost-sharing benefits flow from running both on the same cohort infrastructure.
