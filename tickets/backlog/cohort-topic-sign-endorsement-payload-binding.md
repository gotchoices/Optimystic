description: The /sign endorser signs the requester's opaque payload bytes blind — it never confirms the payload reflects its own view of the cohort, nor that the bytes match the request's declared `kind`. A single cohort insider can therefore collect k − x honest signatures over a falsified MembershipCertV1 (arbitrary `members`/`stabilizedAt`) or a kind-mismatched notice. Bind the endorsement to a payload the endorser independently re-derives/validates.
prereq: cohort-topic-membership-cert-trust-anchoring
files:
  - packages/db-p2p/src/cohort-topic/host.ts (handleSignRequest — endorsement policy)
  - packages/db-core/src/cohort-topic/wire/types.ts (SignRequestV1 / SignKind)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (canonical payload images the endorser would re-derive)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (FretCohortThresholdCrypto.assemble — requester side)
----

# Bind `/sign` endorsements to a payload the endorser independently validates

## Problem

`handleSignRequest` (db-p2p `host.ts`) endorses a `SignRequestV1` by Ed25519-signing the **exact**
`request.payload` bytes whenever the requester and self share the cohort + epoch around `request.coord`.
It performs **no inspection of the payload contents**:

- The endorser never re-derives or compares the payload against its *own* view of the cohort. For the
  `membership` cert path this means a single cohort insider can craft a `MembershipCertV1` signable
  image with a falsified `members` list (any superset that still contains the real signers, so it passes
  the verifier's `signers ⊆ members` check), a falsified `stabilizedAt`, or a falsified `cohortEpoch`
  *inside* the payload (the gate only checks the separate `request.cohortEpoch` field, not the bytes),
  collect `k − x` honest endorsements over it, and publish a cert that honest members never agreed to.
- The endorser never confirms the opaque bytes actually correspond to the declared `request.kind`. The
  threshold blob is kind-agnostic, so a `kind: "membership"` request can carry promotion/demotion-notice
  bytes (or vice versa) and the assembled signature verifies for whatever the bytes decode to.

This is distinct from `cohort-topic-membership-cert-trust-anchoring` (which addresses the *verifier*
trusting self-consistent certs from an *unknown* key set). The gap here is intra-cohort: even a properly
anchored, legitimate cohort produces signatures that attest only "these signers are cohort members" —
**not** "the cohort agrees the signed content is true." A quorum signature should mean the latter.

It was a documented deviation of the `cohort-topic-threshold-assembly` implementation: "the cohort +
epoch gate IS the full policy" for `membership`, and the kind-specific refinement was deferred. This
ticket tracks closing it.

## Expected behavior

- For each `SignKind`, the endorser re-derives the canonical signing image it is *willing* to attest
  from its own replicated state and endorses only when `request.payload` matches (or is an acceptable
  variant of) that image — rather than signing arbitrary bytes:
  - `membership`: re-derive the `MembershipCertV1` signable image (via `sig/payloads.ts`) from the
    endorser's own `cohortAround(coord)` snapshot at `request.cohortEpoch`; endorse iff it matches.
    Tolerance for benign cross-member ordering/membership skew needs design (strict byte-equality may
    over-refuse during churn — see the one-rotation-stale tolerance note below).
  - `promotion` / `demotion`: the hot/cold refinement the assembly ticket deferred — the endorser
    additionally requires its own replicated `directParticipants(topicId)` to be hot/cold. This needs
    a `topicId` (and any per-topic context) on `SignRequestV1`, which the current `(payload, minSigs)`
    `ICohortThresholdCrypto` port cannot carry, plus gossip **record replication** of
    `directParticipants` (still interim — `renewal.gossip.touch` is a no-op).
- At minimum (cheaper interim step), the endorser should decode the payload to the type implied by
  `kind` and reject a malformed / kind-mismatched payload before signing.

## Notes / dependencies

- Depends on gossip record replication of `directParticipants` for the promotion/demotion refinement,
  and on `SignRequestV1` (or the threshold-crypto port) carrying per-topic context.
- Consider whether one-rotation-stale epoch tolerance (the assembly ticket accepts only the current
  epoch) should be added here, since re-derivation is epoch-sensitive.
- Low impact for the single-tier-0 / k = 1 milestone (a node signs its own cert; no co-signers to
  deceive); the exposure appears with real multi-member cohorts at live tier.
