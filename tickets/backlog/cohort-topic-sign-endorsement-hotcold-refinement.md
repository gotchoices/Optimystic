description: When a node co-signs a "this topic should be promoted/demoted" notice for its cohort, it should first confirm from its own records that the topic really is overloaded (promotion) or idle (demotion), rather than trusting the requester's word. Today it cannot, because the signing request carries no topic identity and the per-topic participant counts are not yet replicated across the cohort.
prereq: cohort-topic-sign-endorsement-payload-binding
files:
  - packages/db-p2p/src/cohort-topic/host.ts (handleSignRequest — promotion/demotion endorsement policy)
  - packages/db-core/src/cohort-topic/wire/types.ts (SignRequestV1 — needs per-topic context)
  - packages/db-core/src/cohort-topic/ports.ts (ICohortThresholdCrypto.assemble — the (payload, minSigs) port)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (FretCohortThresholdCrypto.assemble — requester side)
----

# Refine `/sign` promotion/demotion endorsement with replicated hot/cold state

## Background

`cohort-topic-sign-endorsement-payload-binding` closes the membership-cert hole: a `/sign` endorser now
re-derives the `MembershipCertV1` image from its own cohort view and refuses a falsified one, and it binds
every kind's payload-internal `cohortEpoch` + decodes the payload to the type implied by `kind`.

That leaves the **promotion / demotion** endorsement semantically thin. After the payload-binding ticket
the endorser confirms a promotion/demotion notice *decodes as the right type and carries the honest cohort
epoch* — but it still cannot confirm the **substance**: that the named topic genuinely warrants promotion
(its `directParticipants` is hot) or demotion (cold). A cohort insider can therefore still collect honest
endorsements over a promotion/demotion notice for a topic that is not actually hot/cold, because no endorser
independently checks the load claim.

## What "done" looks like

For `kind: "promotion"` / `"demotion"`, the endorser additionally consults its **own replicated**
`directParticipants(topicId)` for the notice's topic and endorses only when that local count agrees with the
notice's direction (hot enough to promote / cold enough to demote), per the promotion-lifecycle thresholds.
This is the hot/cold refinement the threshold-assembly milestone explicitly deferred.

## Why it is blocked (two missing pieces)

1. **`SignRequestV1` carries no `topicId` (nor per-topic context).** The endorser needs to know *which*
   topic the notice is about to look up its own `directParticipants`. The promotion/demotion canonical
   images do embed `topicId`, so the endorser could read it from the decoded payload — but the
   `ICohortThresholdCrypto.assemble(payload, minSigs)` port (db-core `ports.ts`; impl
   `threshold-crypto.ts`) carries only `(payload, minSigs)`, so the *requester* side has no clean seam to
   pass per-topic context, and relying solely on attacker-supplied payload bytes for the lookup key is
   fragile. Decide: read `topicId` from the decoded promotion/demotion image (cheapest), or widen the port /
   `SignRequestV1` to carry it explicitly (cleaner, but a wire + port change).

2. **`directParticipants` is not replicated across the cohort.** An endorser only knows the participants it
   personally holds records for; the cohort-wide per-topic count depends on gossip **record replication**,
   which is still interim (`renewal.gossip.touch` is a no-op — records are not yet replicated on renewal).
   Without it, an endorser's local `directParticipants` is a partial view and would over-refuse legitimate
   promotions during normal sharding.

Both must land before this refinement is meaningful. The membership path (the payload-binding ticket) does
**not** depend on either, which is why it ships first.

## Notes

- Consider whether one-rotation-stale epoch tolerance belongs here (re-derivation is epoch-sensitive); the
  assembly path accepts only the current epoch today.
- Low impact at the single-tier-0 / k = 1 milestone (a node signs its own notice; no co-signers to deceive);
  the exposure appears with real multi-member cohorts at live tier.
- This is a security-hardening refinement, not a correctness regression — promote/demotion notices are
  already threshold-verified against the cohort cert on receipt; this tightens *what a quorum signature
  attests* from "these signers are cohort members" to "the cohort agrees the topic is hot/cold."
