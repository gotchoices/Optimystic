description: Optionally sign each group-state-sharing message so a recipient can prove which member sent it, instead of only checking that the sender is currently in the group.
prereq:
files: packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts, packages/db-core/src/reactivity/push-state.ts
difficulty: medium
----

# Reactivity PushState-gossip frame peer-sig envelope signing (hardening)

## Why this is backlog, not active

The reactivity PushState-gossip path (`reactivity-pushstate-gossip`, the `ReactivityPushStateGossipDriver`)
ships intra-cohort `PushStateGossipV1` frames authenticated by two defensible, already-present layers:

1. **Membership gate** — `deliver` drops any frame whose sender is not a current cohort member for the
   frame's coord (`isCohortMember`).
2. **Self-verifying entries** — every replay-ring entry is a full end-to-end-verifiable `NotificationV1`
   (it retains its original threshold signature). A backfill *serve* re-verifies entries regardless of how
   they arrived, so a poisoned ring entry cannot produce a forged delivery — it can only waste a replay
   slot until it ages out.

For a hint-only replication path, that is the correct default. This ticket captures the **optional
hardening** if/when a stronger threat model warrants it.

## What to build (when promoted)

A peer-signature envelope around the push-state-gossip frame, mirroring how the cohort-topic gossip family
authenticates its own `CohortGossipV1` (the `peer-sig`/signature slot the host's peer-key signer fills
before broadcast). Concretely:

- An envelope `{ frame, fromPeerId, sig }` (or an inline `signature` field on the wire image) where the
  broadcasting member signs the canonical frame bytes with its node key, and `deliver` verifies the
  signature against `fromPeerId` **before** the membership gate / merge.
- Reuse the cohort-topic peer-key signing seam rather than inventing a second one, so reactivity and
  cohort-topic share one envelope-auth mechanism.

## Expected behavior

- A frame whose envelope signature does not verify against its claimed sender is dropped before merge
  (in addition to the existing membership gate).
- Unsigned/legacy frames: decide an explicit policy (reject vs. accept-with-gate-only) — likely a
  capability/version negotiation so the path stays backward-compatible during rollout.
- No change to the convergence or frame-size-bound behavior; this is purely an authenticity wrapper.

## Use case that would justify promotion

A cohort where the membership view itself can be transiently wrong or manipulable (e.g. during churn /
epoch rotation) such that a non-member could momentarily pass `isCohortMember`, **and** where wasting
replay slots with junk entries (a slow-burn DoS on the replay window) is judged worth preventing at the
gossip layer rather than relying solely on serve-time re-verification.
