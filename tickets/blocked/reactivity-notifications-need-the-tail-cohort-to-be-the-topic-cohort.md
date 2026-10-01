description: Network change announcements only work when every machine belongs to every storage group, because the machines that store a collection's log and the machines that are supposed to announce its changes are chosen from different places on the network; the architecture document says they are the same group, and a decision is needed on how to make that true.
architecture: docs/reactivity.md#origination-point
files: docs/reactivity.md, docs/cohort-topic.md, packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts, packages/db-p2p/src/cohort-topic/change-bridge.ts, packages/db-core/src/reactivity/verify.ts, packages/db-core/src/reactivity/topic-anchor.ts, packages/db-core/src/cohort-topic/sig/threshold.ts, packages/db-p2p/src/libp2p-node-base.ts
----

**Blocked: architecture is contradictory.** Unblocks when a human picks how a collection's announcing group relates to its storage group (recommended default below), or accepts the small-group limit as the documented scope.

## The contradiction

`docs/reactivity.md` § Origination point says the machines that store a collection's log tail block and the machines that announce its changes are one group "since they share the same coordinate". They do not:

- The **storage group** for the tail block is the `clusterSize` machines nearest the block's ring position, which is a hash of the block id (`routingKeyForBlock`, hashed once by the key network).
- The **announcing group** is the `wantK` machines nearest `coord_0(topicId)` = `H(0x00 ‖ H(tailId ‖ "reactivity"))` (`createReactivitySelfMembershipGate` in `packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts`).

Those are unrelated ring positions. Two consequences follow, both read from code (repro: static):

1. **Nobody announces.** A commit is announced only by a machine that applied it (the storage group) *and* sits in the announcing group (the membership gate). Once the network is larger than a cohort, the two groups are usually disjoint, so most commits are never announced.
2. **Announcements would not verify anyway.** A notification's signature is the commit certificate — signed by the storage group's approving members. A subscriber checks it against the *announcing* group's membership certificate and requires at least `minSigs` signers, all members of that group (`createNotificationVerifier` in `packages/db-core/src/reactivity/verify.ts`, threshold from the host's `minSigs`, default 14 — `DEFAULT_MIN_SIGS` in `packages/db-core/src/cohort-topic/sig/threshold.ts`). Storage-group signers who are not announcing-group members cannot satisfy that, and a storage group of `clusterSize` members can never supply 14 signers unless `clusterSize` ≥ 14.

So today announcements work only when every machine is in every group, with `wantK` ≥ the machine count and `minSigs` ≤ `clusterSize`. Every real-network test runs that configuration. The supported small deployments (one to a few machines, `docs/architecture.md`) fit it once those two settings are declared; the defaults (`minSigs` 14) never verify below 14 machines. Larger networks do not work at all.

The current per-table opt-in work (`network-collection-watch-service`, `quereus-tables-opt-in-to-network-change-notification`) is built and tested inside the small-group configuration, and its fallback check (one tail read per watched table about every 30 s) means a watcher still wakes, slowly, where announcements do not arrive. That makes this a performance and scope question rather than a correctness one for those tickets, which is why they proceed.

## Proposed text (recommended default)

Add to `docs/reactivity.md` § Anchor, replacing the § Origination point paragraph:

> A collection's reactivity topic is anchored at its tail block's own ring position. `coord_0` for a reactivity topic is the tail block's routing coordinate (the coordinate the key network assigns `routingKeyForBlock(tailId)`), not `H(0x00 ‖ topicId)`. The announcing group is therefore the `wantK` machines nearest the tail block, which contains the tail's storage group whenever `wantK ≥ clusterSize`. A notification verifies against that group's membership with a threshold derived from the storage group — `minSigs` for reactivity is the commit certificate's own approval threshold, not the cohort-topic default — since the commit certificate is the signature it carries. Deeper tiers (`d ≥ 1`) keep the standard addressing below that root.

Why this one: it makes the existing claim true with no new message, no relay hop and no second signing authority; rotation still moves the root with the tail, which keeps the "no permanent hotspot" property § Anchor argues for; and the storage group is already the trust root a reader of the collection must accept.

Cost: cohort-topic addressing gains a per-application override of `coord_0` (reactivity only; matchmaking keeps its stable anchor), which the verifier, the membership gate, the subscriber's registration walk and the forwarder must all derive identically; and `minSigs` becomes per-application. Reversible until announcements ship to deployments on mixed versions; after that, a change of anchor is a protocol break.

## Alternatives rejected

- **Relay**: storage-group members that are outside the announcing group forward each commit (event plus certificate) to it. Fixes (1) with an extra hop per commit, but not (2): the signers are still not announcing-group members, so verification would have to accept the storage group's membership as a second trust root carried in every notification.
- **Re-sign**: the announcing group threshold-signs each notification itself. Fixes both, but adds a signing round per commit and a second signing authority, which `docs/transactions.md` Design Decision 12 rules out ("reactivity never re-signs").
- **Accept the limit**: document that network announcements work only where every machine is in every group, and make the plugin's documentation say so. Cheapest, and honest for today's deployments, but it caps the feature at the size where "store everything everywhere" already holds.

## If nothing is done

Small groups configured as above work. Every larger deployment gets no announcements; watchers on machines that do not store a table fall back to the watch service's periodic tail read.
