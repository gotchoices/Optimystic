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
