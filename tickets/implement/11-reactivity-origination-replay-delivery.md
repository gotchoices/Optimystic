description: Reactivity core hot path — subscriber attachment, notification origination reusing the commit cert, W=256 replay ring + sliding dedupe, and subscriber verify/deliver.
prereq: local-change-notifier-bridge, cohort-topic-core-module-fret-integration
files: docs/reactivity.md, docs/transactions.md, packages/db-core/src/transactor/change-notifier.ts, packages/db-p2p/src/cluster/cluster-repo.ts
effort: high
----

# Reactivity core: subscription, notification origination, replay buffer, dedupe, delivery

This ticket implements the reactivity **hot path** on top of the cohort-topic substrate
([cohort-topic-core-module-fret-integration](#)) and the local change-notifier bridge
([local-change-notifier-bridge](#)). It covers everything from a subscriber attaching to a
collection through to a delivered, verified, contiguous stream of notifications, plus the
replay buffer and per-revision dedupe that make recovery cheap. Recovery *beyond* the replay
window (backfill/checkpoint/resume), tail rotation, and backpressure/policy are split into the
two sibling tickets ([reactivity-backfill-resume-checkpoints](#),
[reactivity-rotation-backpressure-policy](#)); this ticket builds the substrate they extend.

Grounded in `docs/reactivity.md` §Subscription, §Notification origination, §Propagation,
§Per-revision dedupe, §Delivery, §Replay window, §Authentication and integrity, §Wire formats.

## Architecture

### Tail-anchored topic and subscriber attachment

Subscribing to collection `C` is an ordinary cohort-topic registration (`docs/reactivity.md`
§Subscription, L66–73):

- `topicId = H(currentTailId(C) ‖ "reactivity")`
- `tier = T3` (luxury)
- `appPayload = SubscribeAppPayloadV1`
- `ttl` = configured (Edge 60 s / Core 90 s, inherited from cohort-topic)

The walk-toward-root, willingness gating, `Promoted`/`UnwillingMember`/`UnwillingCohort`
replies, and TTL renewal are all the cohort-topic standard — reactivity **reuses** them, it
does not reimplement them. `topicId` derivation here (the per-emission `H(tailId ‖ "reactivity")`
helper) is shared with [reactivity-rotation-backpressure-policy](#); define it once in this
ticket as a small pure helper that the rotation ticket reuses.

Subscriber-side state (`docs/reactivity.md` L78–90):

```ts
interface ActiveSubscription {
	collectionId: Uint8Array;      // stable identity
	topicId: Uint8Array;           // current tail-anchored topic
	tailIdAtAttach: Uint8Array;    // detects tail rotation (see rotation ticket)
	primary: PeerId;
	backups: PeerId[];
	cohortHint: PeerId[];          // for fast re-attach
	cohortEpoch: Uint8Array;       // membership-drift detection
	lastRevision: number;
	lastDeliveredAt: number;       // unix ms
	attachedAt: number;            // unix ms
}
```

### Forwarder-cohort state

A reactivity forwarder cohort holds the cohort-topic registration records plus per-collection
`PushState` (`docs/reactivity.md` L98–113). The direct-subscriber list **is** the cohort-topic
`RegistrationRecord` set with `appPayload.kind == "reactivity"`; reactivity reads it, it does
not duplicate it.

```ts
interface PushState {
	collectionId: Uint8Array;
	topicId: Uint8Array;
	tailIdAtJoin: Uint8Array;
	parentCohort: CohortRef;       // tier-(d-1)
	childCohorts: CohortRef[];     // tier-(d+1)
	replayBuffer: RevisionEntry[]; // ring, capacity W (default 256)
	parentCheckpoint?: CheckpointSummary; // owned by sibling ticket; field reserved here
	lastRevision: number;
	pendingDedupe: Set<string>;    // sliding window of `${revision}:${sigDigest}`
	perSubscriberQueue: Map<string /*PeerId*/, BoundedQueue>; // owned by rotation/backpressure ticket; field reserved here
}

interface RevisionEntry {
	revision: number;
	payload: NotificationV1;       // full signed notification
	receivedAt: number;            // unix ms
}
```

`PushState` is gossiped within the cohort (via the cohort-topic gossip channel) so any member
can serve a backfill if the primary is unavailable. Define the full `PushState` shape here;
the `parentCheckpoint` and `perSubscriberQueue` fields are populated by the sibling tickets but
the struct and its gossip codec live here so all three tickets share one definition.

### Notification origination

The tail cohort's primary for the collection (the cohort-topic primary at
`coord_0(_, topicId)`) is the notification origin and, by construction, is the transaction-layer
tail-cluster. When the commit's threshold signature is assembled, the primary emits a
`NotificationV1` (`docs/reactivity.md` §Notification origination L117–144):

```ts
interface NotificationV1 {
	v: 1;
	collectionId: string;          // base64url
	tailId: string;                // base64url
	revision: number;
	digest: string;                // base64url, commit digest from tx layer
	delta?: string;                // base64url, bounded, opt-in per collection
	timestamp: number;             // unix ms
	sig: string;                   // base64url; = commit cert threshold sig, NOT re-signed
	signers: string[];             // PeerIds contributing
	rotationHint?: { newTailId: string; effectiveAtRevision: number }; // rotation ticket fills
}
```

The `sig` is **bit-for-bit** the commit certificate's threshold signature (`signers ≥ minSigs
= k − x`). Reactivity never re-signs. The bridge ([local-change-notifier-bridge](#)) supplies
the `CollectionChangeEvent{collectionId, blockIds, actionId, rev}` and the pass-through commit
cert extracted from `cluster-repo.ts`; this ticket consumes those to build `NotificationV1`.
The `delta` field is optional, bounded by `delta_max` (Core 4 KB / Edge 0); whether to include
it is per-collection config (the rotation/policy ticket owns the Edge/Core `delta_max` plumbing,
but origination must respect a `delta_max` of 0 by omitting `delta`).

### Propagation and forwarding

The tail primary delivers the signed notification to every direct subscriber (via each
subscriber's primary assignment in the registration record) and to every `childCohorts` entry
(addressed to that child's primary). A receiving forwarder primary (`docs/reactivity.md` L155–162):

1. Verifies the threshold sig against the tail cohort's `MembershipCertV1`
   ([cohort-topic.md §Membership snapshots](../../docs/cohort-topic.md)).
2. Runs the dedupe check (below).
3. Appends to the replay buffer.
4. Forwards the **unmodified** notification to its own direct subscribers and child cohorts.

Forwarders never re-sign; a compromised forwarder can drop/delay but not forge.

### Per-revision dedupe (sliding-window set)

A scalar `lastRevision` is insufficient under partition healing (the same revision may
legitimately arrive from multiple parents during merge). Each forwarder keeps a sliding
`pendingDedupe` set of `(revision, sigDigest)` for the last `dedupe_window` revisions (default
64). A notification is forwarded if (`docs/reactivity.md` L168–173):

- it is for the *highest revision* seen in the window (normal case), OR
- it is for an earlier revision, `(revision, sigDigest)` is not already in the set, and it
  passes verification (recovery: a retransmit closing a gap).

Notifications already in the set are dropped silently. The set is gossiped within the cohort so
all members agree on what has been seen.

### Replay window

Each forwarder and the tail cohort maintain a per-collection ring buffer of the last `W`
notifications (default 256, `docs/reactivity.md` §Replay window L206–216). Entries are gossiped
across the cohort so any member can serve a replay if the primary is unavailable. This buffer is
the substrate the backfill/resume ticket reads from; this ticket owns its construction, ring
semantics, gossip replication, and the "any member can serve" property.

### Delivery and subscriber verification

A subscriber receiving a notification (`docs/reactivity.md` §Delivery L195–202):

1. Verifies `sig` against the cached `MembershipCertV1` for the tail cohort, with **one
   fetch-and-retry** fallback for a stale membership cache.
2. Checks `revision == lastRevision + 1`. If not, requests a backfill for the gap
   `[lastRevision + 1, revision]` (the `BackfillV1` request shape lands in the sibling ticket;
   this ticket only needs to *detect* the gap and call the backfill hook the sibling provides —
   define a small `requestBackfill(from, to)` seam here).
3. Updates `lastRevision` once revisions are contiguous.
4. Surfaces the notification to the application layer.

Subscribers dedupe by `(collectionId, revision)`; duplicates from forwarder retries are
discarded.

### Authentication

- Subscribe/renew RPCs are signed by the subscriber's peer key with `correlationId` and
  `timestamp` (unix ms); replay protection is the cohort-topic layer's job.
- Notification sig verification uses the standard cohort-topic membership-snapshot path.

### Wire formats / codecs

All messages JSON, length-prefixed UTF-8, byte fields base64url, timestamps unix ms — matching
the cohort-topic wire conventions ([cohort-topic-wire-formats](#)). This ticket defines:
`SubscribeAppPayloadV1` (`docs/reactivity.md` L341–347, the `RegisterV1.appPayload` extension),
`NotificationV1` (L353–367). The `BackfillV1`/`ResumeV1` codecs belong to the sibling tickets.

```ts
interface SubscribeAppPayloadV1 {
	kind: "reactivity";
	collectionId: string;   // base64url
	tailIdAtAttach: string; // base64url
	lastKnownRev: number;   // 0 for fresh subscribe
	deltaMaxBytes: number;  // 0 = decline delta payloads
}
```

### Simulator-dependent parameter

`W` (replay buffer depth, default 256) and `dedupe_window` (default 64) are **provisional**
until validated by [simulator-reactivity-replay](#) and folded into `docs/reactivity.md` by
[fold-simulator-findings-into-design-docs](#) (a transitive prereq via the cohort-topic core
module). Build `W` and `dedupe_window` as configuration values sourced from a single defaults
table, never hard-coded at call sites, so the fold-back can change them without touching the hot
path. If the simulator concludes `W` must be adaptive per commit-rate, surface a hook but keep
the static default behavior here.

## TODO

### Phase 1 — Wire types and shared helpers
- Implement `SubscribeAppPayloadV1` and `NotificationV1` codecs (JSON, base64url bytes, unix-ms
  timestamps) with round-trip and malformed/oversized rejection, reusing the cohort-topic codec
  conventions.
- Implement the shared `reactivityTopicId(tailId) = H(tailId ‖ "reactivity")` pure helper
  (consumed here and by the rotation ticket).
- Define the `PushState` and `RevisionEntry` structs and their cohort-gossip codec (reserve
  `parentCheckpoint` / `perSubscriberQueue` fields for sibling tickets).

### Phase 2 — Subscriber attachment
- Implement `ActiveSubscription` and the subscribe flow as a cohort-topic `RegisterV1` with the
  reactivity `appPayload`; wire TTL renewal through the cohort-topic ping/renew protocol.
- Sign subscribe/renew RPCs with the subscriber peer key, including `correlationId` + `timestamp`.

### Phase 3 — Origination and propagation
- Consume the local-change-notifier bridge output (`CollectionChangeEvent` + pass-through commit
  cert) at the tail primary to emit `NotificationV1` reusing the threshold sig unchanged.
- Implement forwarder receive → verify → dedupe → append-to-buffer → forward, never re-signing.
- Honor `delta_max == 0` by omitting `delta` at origination.

### Phase 4 — Replay buffer and dedupe
- Implement the `W`-entry ring buffer with cohort gossip so any member can serve a replay.
- Implement the sliding `pendingDedupe` window with the highest-revision / recovery-retransmit
  rules and intra-cohort gossip of the set.

### Phase 5 — Delivery and verification
- Implement subscriber-side verify (against cached `MembershipCertV1`, one fetch-and-retry),
  revision-contiguity check, gap detection calling the `requestBackfill` seam, `(collectionId,
  revision)` dedupe, and surfacing to the app layer.

### Phase 6 — Config and docs
- Add `W`, `dedupe_window`, `delta_max` (and the inherited TTLs) to a single reactivity defaults
  table; mark `W` / `dedupe_window` as simulator-validated-pending.
- Update `docs/reactivity.md`: confirm wire formats (§Wire formats) match the implemented JSON
  serialization (base64url bytes, unix-ms timestamps); reference this ticket from the
  §Notification origination and §Delivery sections; note that backfill/resume/rotation are
  delivered by the sibling tickets.
- Reference (do not duplicate) the superseded backlog ticket
  `optimystic-replica-persist-change-notification` — its intent (waking consumers on commit) is
  subsumed by networked notification origination here.

## Done when
- `yarn build` and `yarn test` are green for `db-core` and `db-p2p`.
- New tests pass: a notification verifies and delivers contiguously; a duplicate (same
  `(revision, sigDigest)`) is dropped; a revision gap triggers a backfill request via the seam;
  any cohort member (not just the primary) serves a replay from the buffer; a stale
  `MembershipCertV1` triggers exactly one fetch-and-retry then verifies.
- `docs/reactivity.md` wire formats and the §Notification origination / §Delivery cross-references
  reflect the implementation.
