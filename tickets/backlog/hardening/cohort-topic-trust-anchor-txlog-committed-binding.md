description: For the cohorts that handle committed transaction work, verify their membership against what the transaction log actually recorded, instead of falling back to trusting it on faith.
prereq: cohort-topic-trust-anchor-core, cohort-topic-parent-ref-tx-log-content
files:
  - packages/db-core/src/cohort-topic/membership/source.ts (committed-tier routing)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (IMembershipTrustAnchor)
  - packages/db-p2p/src/cohort-topic/membership-source.ts
  - docs/cohort-topic.md (§Membership source, §Bootstrapping trust)
----

# Anchor T0/T1 membership to the transaction-log commit certificate

## Why

`docs/cohort-topic.md` §Membership source: T0/T1 cohorts serve committed work (transaction commits,
chain serving) and their membership is anchored in the transaction log's **commit certificate** — the
verifier *reads* it from there (it never writes the log). The trust-anchor framework
(`cohort-topic-trust-anchor-core`) routes the direct anchor by tier so a committed-tier anchor can plug
in alongside the FRET-ring anchor (which deliberately returns `"unknown"` for T0/T1).

Today T0/T1 membership has no coord-keyed committed backing, so the direct anchor is `"unknown"` for
committed tiers and the gate falls back to interim TOFU there. This ticket binds the committed-tier
direct anchor to the tx-log commit certificate so a forged T0/T1 cert is rejected against committed
state.

## Blocked on (the reason this is backlog)

Per the §Membership source note (docs L461-470): **no coord-keyed committed-membership index exists**.
The tx-log commit certificate is keyed by *action*, not by `coord_0`, so there is no committed lookup
from a cohort coord to its committed member set. The follow-on `cohort-topic-parent-ref-tx-log-content`
is the prereq that introduces the dedicated committed backing (and the stronger "the parent's committed
record names *this* child" check). The committed-tier trust anchor depends on that index existing.

## Requirements / expectations

- A committed-tier (`IMembershipTrustAnchor` for T0/T1) `directAnchor(cert, tier)` reads the committed
  membership for `cert.cohortCoord` from the tx-log commit certificate and returns:
  - `"anchored"` when the cert's keyset matches the committed membership,
  - `"rejected"` when it contradicts it,
  - `"unknown"` only when the committed state for that coord is genuinely not yet known locally
    (fail-closed semantics consistent with the parent-reference gate's fail-closed-when-unknown rule).
- Composes with the FRET-ring anchor by tier (T0/T1 → committed source/anchor; T2/T3 → FRET); the
  tier→source routing in `membership/source.ts` is the existing seam.
- Honours the freshness logic (one-refetch-retry, stale tolerance) — anchoring is an additional gate.

## Notes

- This closes the T0/T1 half of the trust-anchoring vulnerability; the FRET-ring + chain work closes the
  FRET-covered T2/T3 half, and `cohort-topic-trust-anchor-fret-stabilization-proof` closes distant
  first-sight T2/T3.
- The commit certificate is already the membership source for these tiers, so this is primarily a
  read-and-compare against committed state once the coord-keyed index exists — no new crypto.
