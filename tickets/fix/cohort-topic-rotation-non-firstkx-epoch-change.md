description: A cohort can change its membership in a way that updates its identity label but produces no signed hand-off, so far-away peers that can only verify it through the hand-off chain can get stuck trusting an out-of-date member list.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/publisher.ts (firstKx-based republish gate — onStabilized / firstKx)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (chainGrantsTrust — rotation chain accept path)
  - packages/db-p2p/src/cohort-topic/host.ts (firstKxChanged — the rotation trigger mirrors the publisher gate)
difficulty: medium
----

# Rotation chain has a blind spot for non-firstKx epoch changes

## Background

`cohortEpoch = H(sorted all members)`, but both the membership publisher's **republish trigger**
(`SigningMembershipCertPublisher.onStabilized` → `firstKx`) and the rotation-attestation **producer**
(`host.ts` `firstKxChanged`) key off only the first `minSigs` (`k − x`) members of the sorted set — the
"firstKx". A membership change *beyond* position `minSigs` (e.g. the 15th or 16th member under the
production `minSigs = 14`, `wantK = 16`) changes the epoch label but:

- does **not** trigger a republish (until the next periodic `T_membership_refresh`), and
- when it eventually does republish on refresh, carries **no rotation attestation** (`firstKxChanged` is
  false, so the host treats it as a non-rotation refresh).

## Why it matters

For a coord a participant **cannot directly anchor** (distant T2/T3, or any coord whose FRET/tx-log direct
anchor is absent) and that is **already trust-established**, the verifier rejects an un-anchored successor
(`fallbackTrust` → `reject`, no TOFU downgrade). So a new-epoch cert with no attestation is rejected, and
the participant stays on the cached predecessor cert.

That is usually fine — message verification only needs `signers ⊆ cert.members` with a `≥ minSigs` quorum,
and the firstKx (the stable signing core) is unchanged, so messages signed purely by the unchanged core
still verify against the stale cert. **The residual gap:** the threshold assembler collects from the
*whole* cohort, so a message's `signers` can legitimately include a post-firstKx member that swapped in.
Such a message has a signer `∉` the stale cert's members → fails verification → triggers the single
refetch → fetches the new (unattested) cert → rejected → the message is `untrusted`, even though it was
produced by the legitimate current cohort.

In production this is **masked on served coords** by the FRET direct anchor (the participant re-anchors
directly, no chain needed). It bites only coords with no direct-anchor authority that are reached purely
through the rotation chain.

## Possible directions (decide during plan)

- Make the rotation boundary "any epoch change" rather than "firstKx change": the publisher republishes and
  the host attests on **any** `cohortEpoch` change, not just a firstKx change. Costs one extra `/sign` round
  per non-firstKx churn; closes the chain gap completely.
- Or: keep the firstKx republish gate but have the producer attest whenever the *epoch* differs from the
  predecessor (decouple the rotation trigger from the republish trigger).
- Or: document this as an accepted limit of the rotation chain and rely on direct anchors closing it for all
  coords that matter (i.e. treat un-anchored coords as out of the rotation chain's guarantee).

Weigh against the `...-fret-stabilization-proof` / `...-txlog-committed-binding` direct-anchor work, which
may make the chain-only path rare enough that the simplest option (document the limit) is acceptable.
