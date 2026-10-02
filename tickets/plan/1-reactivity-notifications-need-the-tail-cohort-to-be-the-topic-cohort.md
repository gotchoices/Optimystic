description: Network change announcements only work when every machine belongs to every storage group, because the machines that store a collection's log and the machines that are supposed to announce its changes are chosen from different places on the network; the architecture document says they are the same group, and a decision is needed on how to make that true — including how the announcement tree survives the log moving to a new block every 32 commits at large scale.
architecture: docs/reactivity.md#origination-point
files: docs/reactivity.md, docs/cohort-topic.md, packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts, packages/db-p2p/src/cohort-topic/change-bridge.ts, packages/db-core/src/reactivity/verify.ts, packages/db-core/src/reactivity/topic-anchor.ts, packages/db-core/src/cohort-topic/addressing.ts, packages/db-core/src/cohort-topic/sig/threshold.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts
----

**Blocked: architecture is contradictory.** Unblocks when a human accepts (or edits) the proposed text below, or accepts the small-group limit as the documented scope. The proposed text was revised with the maintainer after a scaling review (1 machine → very large networks); the maintainer agreed with its direction and is to confirm the wording.

## The contradiction

`docs/reactivity.md` § Origination point says the machines that store a collection's log tail block and the machines that announce its changes are one group "since they share the same coordinate". They do not:

- The **storage group** for the tail block is the `clusterSize` machines nearest the block's ring position, which is a hash of the block id (`routingKeyForBlock`, hashed once by the key network), chosen by `findCluster` in `packages/db-p2p/src/libp2p-key-network.ts` — which admits only peers that serve this network.
- The **announcing group** is the `wantK` machines nearest `coord_0(topicId)` = `H(0x00 ‖ H(tailId ‖ "reactivity"))`, chosen by raw FRET `assembleCohort` (`createReactivitySelfMembershipGate` in `packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts`), which does not filter by network.

Those are unrelated ring positions, picked by two different selection rules. Two consequences follow, both read from code (repro: static):

1. **Nobody announces.** A commit is announced only by a machine that applied it (the storage group) *and* sits in the announcing group (the membership gate). Once the network is larger than a cohort, the two groups are usually disjoint, so most commits are never announced.
2. **Announcements would not verify anyway.** A notification's signature is the commit certificate — signed by the storage group's approving members. A subscriber checks it against the *announcing* group's membership and requires at least `minSigs` signers, all members of that group (`createNotificationVerifier` in `packages/db-core/src/reactivity/verify.ts`, threshold from the host's `minSigs`, default 14 — `DEFAULT_MIN_SIGS` in `packages/db-core/src/cohort-topic/sig/threshold.ts`). Storage-group signers who are not announcing-group members cannot satisfy that, and a storage group of `clusterSize` members can never supply 14 signers unless `clusterSize` ≥ 14.

So today announcements work only when every machine is in every group, with `wantK` ≥ the machine count and `minSigs` ≤ `clusterSize`. Every real-network test runs that configuration.

The per-table opt-in work (`network-collection-watch-service`, `quereus-tables-opt-in-to-network-change-notification`) is built and tested inside the small-group configuration, and its fallback check (one tail read per watched table about every 30 s) means a watcher still wakes, slowly, where announcements do not arrive. That makes this a performance and scope question rather than a correctness one.

## A second problem the anchor decision has to settle: rotation cost at scale

Every tier's address includes `topicId` (`coord_d(P, topicId) = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)`), and `topicId` changes whenever the log tail fills — every 32 commits. So each rotation moves the **whole** subscription tree, and every subscriber re-registers. The cost is commit rate × subscriber count: at 10 commits/s and 10,000 subscribers, about 3,000 registrations per second network-wide, against a new root that admits `cap_promote_fast` = 32 per window. On a live node the successor tail cannot be announced in advance (block ids are random; deterministic ids are backlog `6.5-block-id-derivation`), so subscribers learn of each rotation only from the watch service's 30 s tail check. On a busy collection they spend nearly all their time registered under a topic nobody announces to, and network watch degrades to 30 s polling.

## Proposed text (recommended default)

Replace `docs/reactivity.md` § Anchor's addressing block and § Origination point with:

> **Root at the tail's storage group.** A collection's reactivity tree is rooted at its log tail block's own ring position: `coord_0` for a reactivity topic is the routing coordinate the key network assigns `routingKeyForBlock(tailId)`, not `H(0x00 ‖ topicId)`. The root (announcing) group is the tail block's storage group, chosen by the same rule the key network uses for storage — `findCluster`'s network-scoped selection, with reactivity's root `wantK` equal to `clusterSize` — so the machines that apply a commit are exactly the machines that announce it. Every party that derives the root group — the origination gate, the notification verifier, the subscriber's registration walk and the forwarder — uses that one rule.
>
> **Threshold from the verifier's side.** A notification carries the commit certificate as its signature. A verifier accepts it when its signers are members of the root group it derived itself and number at least `ceil(|root group| × superMajorityThreshold)` — the same threshold the commit certificate is captured under (`captureCommitCert`). The threshold is never read from the notification. The cohort-topic default `minSigs` (14) does not apply to the reactivity root.
>
> **Tiers below the root do not rotate.** Tiers `d ≥ 1` are addressed by a stable collection anchor, `collectionTopicId = H(collectionId ‖ "reactivity")`: `coord_d(P) = H(d ‖ prefix(H(P), d·log₂F) ‖ collectionTopicId)`. Only the root moves when the tail rotates. A rotation therefore re-links at most `F` tier-1 child cohorts (and the root's own direct subscribers) to the new root, not every subscriber in the tree. A notification still names its `tailId`, and its signature still verifies against the root group of that tail.

Why this one: it makes the existing claim true with no new message, no relay hop and no second signing authority (Design Decision 12 — reactivity never re-signs); the root still moves around the ring with the tail, so no machine holds root duty for a collection permanently; the storage group is already the trust root a reader of the collection must accept; and rotation cost becomes independent of subscriber count.

Costs, stated plainly:

- **Per-application addressing.** Cohort-topic gains a per-application override of `coord_0` and of the topic id used for `d ≥ 1` (reactivity only; matchmaking keeps its stable anchor), and `minSigs` becomes per-application. All four derivers listed above must change together.
- **Fixed first-tier positions.** Tier-1 cohorts of a collection sit at fixed coordinates for the collection's life. Load there is spread over `F` cohorts and bounded by the cohort-topic intake caps, but it is a weaker form of the "no permanent target" argument § Anchor makes for rotation. The root, which carries every notification, still rotates.
- **Root load lands on write-busy machines.** The root group already handles every commit to the collection; it now also serves its direct subscribers and up to `F` child links. Bounded by the tree, but worth saying in the doc.
- **Reversibility.** Reversible until announcements ship to deployments on mixed versions; after that, any change of anchor is a protocol break.

## Not covered here (separate tickets)

- **Distant subscribers verify root membership on trust-on-first-use.** `packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts` can vouch for a group's membership only near ring positions this node's own routing table covers, and returns `"unknown"` for T0/T1 pending a transaction-log anchor. In a large network nearly every subscriber is far from the tail, so it falls back to trust-on-first-use. Tracked in backlog `feat-reactivity-root-membership-anchored-by-the-commit-log`, which this decision makes coherent.
- **A one-machine founder never announces.** A solo cohort produces no commit certificate, and the node the Quereus plugin builds runs `clusterSize: 1`, so a group founded on that node keeps announcing nothing after a second machine joins. Same one-to-two rough edge as the repair table in `docs/internals.md`; not part of this decision.

## Alternatives rejected

- **Keep `wantK` at the cohort-topic default (16) with `wantK ≥ clusterSize`** (this ticket's earlier proposal): any majority-sized subset of the larger announcing group could sign a notification, not just the storage group. Harm is bounded — a notification only prompts a re-read — but there is no reason to admit it.
- **Keep deeper tiers keyed by `topicId`** (the earlier proposal): leaves rotation cost proportional to subscriber count, which caps the feature at modest commit rates.
- **Relay**: storage-group members outside the announcing group forward each commit (event plus certificate) to it. Fixes "nobody announces" with an extra hop per commit, but not verification: the signers are still not announcing-group members, so verification would have to accept the storage group's membership as a second trust root carried in every notification.
- **Re-sign**: the announcing group threshold-signs each notification itself. Fixes both, but adds a signing round per commit and a second signing authority, which `docs/transactions.md` Design Decision 12 rules out.
- **Stable anchor for the whole tree, root included**: no rotation cost at all, but the root is then a permanent per-collection target and is not the storage group, so the verification problem returns.
- **Accept the limit**: document that network announcements work only where every machine is in every group. Cheapest and honest for today's deployments, but caps the feature at the size where "store everything everywhere" already holds.

## If nothing is done

Small groups configured as above work. Every larger deployment gets no announcements; watchers on machines that do not store a table fall back to the watch service's periodic tail read.
