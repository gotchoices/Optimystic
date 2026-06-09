description: Parent-side recording of cold-started child cohorts — a dedicated signed child-link frame and childCohortCount bookkeeping — completing the cold-start parent registration whose transport was wired in cohort-topic-host-antidos-coldstart.
prereq: cohort-topic-followon-derivation
files:
  - packages/db-p2p/src/cohort-topic/host.ts (registerForwarderWithParent — link frame; dispatch/handler for the child-link)
  - packages/db-core/src/cohort-topic/promotion.ts (childCohortCount input to the demotion gate)
  - packages/db-core/src/cohort-topic/coldstart.ts (link/ack semantics)
  - docs/cohort-topic.md (§Cold-start instantiation, §Promotion/demotion)
----

# Cohort-topic: parent-side child-cohort link recording

`cohort-topic-host-antidos-coldstart` supplied the cold-start parent-registration **transport**: a
cold-started tier-`d` forwarder routes a `RegisterV1`-style forwarder-link frame to its tier-`(d−1)`
parent coord over `routeAndAct`, and flips from `awaiting_parent` to `serving` on the round-trip ack.
What it does **not** yet do is make the parent actually *record the child* — the interim link rides
the participant-`RegisterV1` path (so a real parent would treat it as a plain participant register),
it is unsigned (the forwarder cohort can't sign as the participant, so a live parent's
`verifyRegisterSig` gate would reject it), and `childCohortCount` is hardcoded to `0`.

This ticket completes the link.

## Requirements

- A **dedicated child-link frame** (distinct from a participant `RegisterV1`) on the register/promote
  protocol surface, carrying: `topicId`, the child cohort's served coord + tree tier `d`, the op
  tier, and a **cohort threshold signature** (the child cohort signs, not a participant peer key) so
  the parent can authenticate the link against the child cohort's `MembershipCertV1`.
- Parent-side handling: on a verified child-link, the parent records the child cohort for `topicId`
  and drives `childCohortCount` (the demotion gate + parent-involving-op accounting), and replies an
  ack the child treats as the parent-registration success.
- A matching **unlink** on child demotion (the demotion notice already targets the parent coord — see
  `cohort-topic-promote-verify-apply`), decrementing `childCohortCount`.
- Replace the `childCohortCount: () => 0` placeholder in the host's `createPromotionLifecycle` wiring
  with the real per-topic child count.

## Use cases / expected behavior

- A tier-`(d+1)` forwarder links to its tier-`d` parent → the parent's `childCohortCount` for the
  topic increments and the forwarder reaches `serving`.
- A forged/under-quorum child-link → rejected (not recorded), the forwarder stays `awaiting_parent`.
- A demoting child → the parent decrements `childCohortCount`; a parent at/over its child-driven
  demotion threshold demotes per the existing lifecycle.
- Multi-tier e2e (`13-cohort-topic-e2e-mock-tier` / `14-substrate-e2e-real-libp2p-tier`) exercises a
  real parent recording real children rather than the single-tier-0 unit path.
