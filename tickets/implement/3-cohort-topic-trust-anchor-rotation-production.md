description: When a cohort's membership changes, have the outgoing members co-sign the new membership list so peers can confirm the change is a legitimate hand-off rather than an impostor takeover.
prereq: cohort-topic-trust-anchor-fret-binding
files:
  - packages/db-p2p/src/cohort-topic/host.ts (membership publish: snapshotAt ~L1106, onStabilized ~L1301; makeCoordSigner ~L1045)
  - packages/db-core/src/cohort-topic/membership/publisher.ts
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts
  - docs/cohort-topic.md (§Bootstrapping trust)
difficulty: hard
----

# Produce rotation attestations on epoch change (db-p2p)

## Problem

`cohort-topic-trust-anchor-core` lets the verifier *accept* a successor cert via the attestation chain
when it carries a valid `rotationSig` (the predecessor cohort's threshold signature over the successor
payload) and a trusted predecessor is cached. Nothing **produces** that `rotationSig` yet — the db-p2p
publisher emits non-rotation certs only. Without production, the chain is verify-only: a participant
that misses a direct anchor for a rotated epoch cannot extend trust across the rotation and must
re-anchor (or TOFU). This ticket closes the loop so epoch rotations carry a verifiable hand-off.

## Design

On a stabilization that changes the first `k − x` members (the publisher already detects this —
`onStabilized` republishes only when `firstKx` changed), the **outgoing/overlapping cohort** (the
members of the *previous* epoch) threshold-signs the **new** cert's `membershipCertSigningPayload`, and
that signature is attached as `rotationSig` / `rotationSigners` / `prevEpoch` on the published cert.

Because epoch rotation is incremental, a `≥ minSigs` quorum of the *previous* members is almost always
still online and in the cohort — so collecting the predecessor signature reuses the existing `/sign`
endorsement round (`threshold-crypto.ts` `assemble` + the `/sign` protocol), just scoped to the
**previous** epoch's member/coord identity rather than the new one.

### Mechanics

- The host tracks the **last published epoch + its member set** per served coord (the publisher already
  retains `lastFirstKx`; extend to retain the full prior `cohortEpoch` + members, or surface it from the
  coord engine).
- On a first-`k − x` change, before publishing the new cert:
  1. build the new cert's `membershipCertSigningPayload` (over the *new* members/epoch);
  2. run a threshold-sign of that payload under the **predecessor** cohort identity — i.e. collect
     endorsements from members of the prior epoch (a `/sign` round whose `kind` is a new
     `"rotation"` `SignKind`, scoped by the prior `cohortEpoch`, so endorsers verify they were members
     of the epoch being rotated *from*);
  3. attach `{ prevEpoch: priorEpoch, rotationSig, rotationSigners }` to the new cert via the
     publisher's `rotation?` arg (added in the core ticket).
- First-ever publish for a coord (no prior epoch) emits **no** rotation attestation — its trust comes
  from the direct anchor / trust root, not a chain link.

### `/sign` extension

Add `"rotation"` to `SignKind` (`wire/types.ts` — done in core ticket or here, pick one and note it).
A member endorses a rotation sign-request iff it was a member of the cohort at `prevEpoch` (the request
carries the prior `cohortEpoch`); the endorsement policy mirrors the existing membership/promotion
cohort+epoch gate but checks **prior**-epoch membership. Reuse `sig/payloads.ts`
`membershipCertSigningPayload` for the signed bytes — signer and verifier must not re-canonicalize
independently.

## Edge cases & interactions

- **Predecessor quorum unavailable** — too few prior members online to reach `minSigs` (mass churn /
  partition) → cannot produce `rotationSig`; publish the new cert **without** a rotation attestation
  rather than blocking publication. Trust then falls to the direct anchor / TOFU (no worse than today).
  Log/observe this case.
- **Rapid double rotation** — epoch N → N+1 → N+2 within a refresh window: each publish attests its
  immediate predecessor; a participant cached at N that receives N+2 cannot chain (gap) and re-anchors.
  Acceptable; document. Do not attempt multi-hop attestations.
- **prevEpoch == new epoch** — a republish where the first `k − x` did *not* change must not emit a
  rotation attestation (it is not a rotation). Guard on the actual first-`k − x` change the publisher
  already computes.
- **Endorsement by non-prior-member** — a current member that was *not* in the prior epoch must refuse a
  `"rotation"` sign-request (it cannot attest a hand-off it was not party to) → the quorum is genuinely
  the outgoing cohort, which is what makes the chain link meaningful.
- **Signature image agreement** — `rotationSig` must be over the *new* cert's canonical
  `membershipCertSigningPayload` exactly; a mismatch makes db-core's chain check fail. Round-trip test
  the produced cert through the db-core verifier's chain path.
- **Self-only cohort / `n < k`** — tiny cohorts where prior == new membership: no first-`k − x` change →
  no attestation; fine.

## Key tests (db-p2p `live-tier.spec.ts` + a publisher/rotation unit test)

- legit rotation: cohort at epoch N publishes; membership changes; the new cert carries a `rotationSig`
  the db-core verifier accepts as a chain extension from the (trusted) N cert → a participant trusting N
  now trusts N+1 **without** a fresh direct anchor.
- forged rotation rejected end-to-end: a cert claiming `prevEpoch = N` whose `rotationSig` is signed by
  non-prior members → db-core chain check fails → `"untrusted"`.
- predecessor-quorum-unavailable: rotation published without attestation; verifier falls back cleanly.
- non-rotation republish emits no rotation fields.
- `yarn build` + `yarn test` green for db-p2p + db-core.

## TODO

- Track prior published epoch + member set per served coord (extend publisher state or surface from the
  coord engine).
- Add `"rotation"` `SignKind` + the prior-epoch-membership endorsement policy on the `/sign` handler.
- Collect the predecessor threshold signature over the new cert payload and attach it via the
  publisher's `rotation?` arg; guard on a real first-`k − x` change and on predecessor-quorum
  availability.
- Tests above; update `docs/cohort-topic.md` §Bootstrapping trust to document rotation-attestation
  production and the gap/partition fallbacks.
