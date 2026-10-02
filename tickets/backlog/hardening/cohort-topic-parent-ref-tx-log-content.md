description: Strengthen the cold-start "parent topic exists" check so a node confirms the parent topic's committed record actually names this child topic, not merely that some cohort is serving the parent.
prereq: cohort-topic-bootstrap-parent-reference
files:
  - packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts
  - packages/db-p2p/src/cohort-topic/membership-source.ts
  - docs/cohort-topic.md (§Anti-DoS, §Membership source)
----

# Cohort-topic: parent-reference tx-log content check

`cohort-topic-bootstrap-parent-reference` admits a `bootstrap: true` register whose signed
parent-reference points at a parent topic the node *locally knows exists* — i.e. it has cached a
`MembershipCertV1` / commit certificate for `coord_0(parentTopicId)`. That proves a cohort is serving
the parent topic, but it does **not** prove the parent's committed state actually anchors *this* child
topic.

A stronger committed-work check would verify, against the transaction-log commit certificate for the
parent topic, that the parent's committed record references this child `topicId` (or that the child is a
legitimate derivation of the parent under the application's anchoring rules). This closes the residual
gap where a participant references an unrelated-but-existing parent topic to satisfy the gate.

## Why it is parked

- The existence-only check is the real, available backing today; the content check needs a
  committed-state read API that maps a parent topic to its committed child references, which does not
  yet exist as a clean synchronous local lookup (admission gates cannot do network I/O).
- It also needs the application-level anchoring contract (how a child topic is derived from / declared
  by a parent's committed state) to be specified — currently only the reactivity tail-anchor and
  matchmaking anchors exist; a general parent→child committed reference is undefined.

## Use cases / expected behavior

- A cold-root T0/T1 bootstrap whose parent-reference names a parent topic whose committed record does
  **not** reference this child → denied (today: admitted if the parent merely exists).
- The check stays synchronous and local (no network round-trip in the admission path).

## Also re-closes the T0/T1 cold-start anti-DoS opening

`cohort-topic-bootstrap-coldstart-origination-regression` made a *configured* production node (a
reputation view but no committed backing) **permissive-but-logged at T0/T1** so it can still originate a
brand-new root topic (a root has no parent to reference, and no coord-keyed committed index is wired
today). That deliberately leaves a real node admitting **any** evidence-less T0/T1 cold-root
`bootstrap: true`. The committed-read API this ticket introduces is exactly the missing
`committedParentTopicReader` backing: when it lands, **`libp2p-node-base.ts` must wire it** into
`createCohortTopicHost({ committedParentTopicReader })`, which flips the host's `hasCommittedParentBacking`
to `true` and re-enables the real T0/T1 parent-reference gate with no further host change. Wiring that
reader is part of *this* work — don't land the content check without re-closing the T0/T1 gate.

## Evidence: "the parent exists" is cheap to manufacture today

(Added in the review of `membership-protocol-serves-the-certificate-for-the-coordinate-asked`.) The host creates a coord engine for any register frame *before* the engine's anti-DoS gate judges it (`dispatchRegister` → `registry.forCoord` in `packages/db-p2p/src/cohort-topic/host.ts`), and on a keyed node the gossip-cadence sweep (`pumpMembership`) publishes a membership cert for every engine, record-less ones included. So a register for topic X that the gate refuses still leaves X's tier-0 cohort serving a cert, and any node that later fetches it (for example while verifying a forged notice naming `coord_0(X)`) caches it, after which `FretMembershipSource.has(coord_0(X))` admits a T2/T3 parent reference to X. The review deliberately kept a node's *own* published certs out of that cache (`NOTE:` at `publishSink` in `createCohortTopicHost`), which would have made this a one-frame step on the deciding node itself; the fetched-cert path remains. A content check of the kind this ticket describes closes both; a narrower fix is to count a parent only when its cohort holds at least one admitted registration.
