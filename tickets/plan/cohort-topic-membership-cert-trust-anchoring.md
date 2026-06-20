description: MembershipCertV1 verification currently trusts any self-consistent cert (quorum-signed over its own members) with no anchoring to a trust root — implement the §Bootstrapping trust chain-to-genesis attestation chain so a forged-but-internally-consistent cert from an unrelated key set is rejected.
prereq: cohort-topic-core-module-fret-integration
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts (certIsSelfConsistent / loadFrom)
  - packages/db-core/src/cohort-topic/sig/threshold.ts
  - docs/cohort-topic.md (§Bootstrapping trust)
difficulty: hard
----

# Anchor MembershipCertV1 trust to a chain of attestations (chain-to-genesis)

## Problem

`createMembershipVerifier` (db-core) accepts a refetched `MembershipCertV1` if it is **self-consistent**:
its own threshold signature is a valid `≥ minSigs` quorum over its own `members`
(`CachingMembershipVerifier.certIsSelfConsistent`). That is the entirety of the trust check today.

Self-consistency proves the cert is internally well-formed, **not** that the attesting key set is the
legitimate cohort for that coord. An adversary who controls any `k − x` keys can mint a cert over a
coord they do not own, sign it with their own keys, list those keys as `members`, and it passes
`certIsSelfConsistent` — and therefore passes `verifyMessage` for any message its keys signed. There
is no binding from the cert's key set back to a network-rooted trust anchor.

This was a known, documented limitation of the
`cohort-topic-gossip-membership-certs` implementation (the per-message verifier was scoped to the
self-consistency check); `docs/cohort-topic.md` §Bootstrapping trust describes the intended design but
it is not implemented.

## Expected behavior (per docs/cohort-topic.md §Bootstrapping trust)

- A participant's initial trust roots are the cohorts responsible for genesis-block-related topics,
  validated against the genesis block hash known out-of-band.
- From there, membership certificates form a **chain of attestations**: each accepted cert must be
  reachable from a trust root by a verifiable chain (a prior trusted cohort attesting the successor
  membership, e.g. across epoch rotations), rather than being trusted purely on its own signature.
- T0/T1 cohorts are additionally anchored in the transaction-log commit certificate (already the
  membership source for those tiers); T2/T3 anchoring derives from FRET stabilization advertisements.
  The trust-anchor check should compose with, not replace, the existing tier→source routing.

## Notes / use cases

- The verifier must still honour the one-refetch-retry and stale-cert tolerance already implemented;
  anchoring is an *additional* gate, not a replacement for the freshness logic.
- Epoch rotation is the common legitimate case where a new cert's key set differs from the last
  trusted one — the attestation chain is what distinguishes a legitimate rotation from a forgery.
- Depends on FRET integration (`cohort-topic-core-module-fret-integration`) landing the real
  threshold-crypto and membership-source bindings, since the chain is verified against FRET/tx-log
  attestations rather than the in-memory mocks used today.
