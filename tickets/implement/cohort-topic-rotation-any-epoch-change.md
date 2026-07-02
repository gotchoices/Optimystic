description: When a cohort swaps a non-core member, its identity label changes but it publishes no signed hand-off, so distant peers that can only verify it through the hand-off chain can get stuck trusting an out-of-date member list. Fix: publish and sign a hand-off on any identity change, not just changes to the core signing members.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/publisher.ts (republish gate — SigningMembershipCertPublisher.onStabilized / lastFirstKx / firstKx)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (unchanged; context for the accept path)
  - packages/db-p2p/src/cohort-topic/host.ts (rotation trigger — firstKx / firstKxChanged / publishMembership, ~L1387-1456)
  - packages/db-core/test/cohort-topic/membership.spec.ts (publisher unit tests — add the epoch-change cases here)
difficulty: medium
----

# Publish + attest a membership hand-off on *any* epoch change

## What's wrong (confirmed by reproduction)

A cohort's identity label is `cohortEpoch = H(sorted all members)`. Two independent gates decide what
happens when membership changes, and **both** currently key off only the first `minSigs` (`k − x`) members
of the sorted set — the "firstKx", the stable signing core:

- **Republish gate** — `SigningMembershipCertPublisher.onStabilized`
  (`packages/db-core/src/cohort-topic/membership/publisher.ts`) compares `lastFirstKx` to the new snapshot's
  firstKx and returns `undefined` (no republish) when they match.
- **Rotation-attestation trigger** — `host.ts` `firstKxChanged`
  (`packages/db-p2p/src/cohort-topic/host.ts`, ~L1392/L1443) attaches a rotation attestation
  (`prevEpoch`/`rotationSig`/`rotationSigners`) to a fresh cert only when the firstKx changed.

So a membership change **beyond position `minSigs`** — e.g. the 15th/16th member under the production
`minSigs = 14`, `wantK = 16` — changes the epoch label but:

- does **not** trigger a prompt republish (it waits for the next periodic `T_membership_refresh`, 5 min), and
- when it eventually does republish on refresh, carries **no rotation attestation** (`firstKxChanged` is
  false → the host publishes it as a plain non-rotation refresh).

**Reproduced** at the db-core publisher level: a snapshot whose only member change is beyond firstKx (so the
caller-supplied `cohortEpoch` differs) returns `undefined` from `onStabilized` and serves no new cert. (The
existing test `republishes when the first k − x members change, not when only the tail changes` asserts this
same non-republish, but with a *constant* epoch, so it never exposed the epoch-label divergence. A temporary
repro that set a distinct epoch per member set confirmed the new-epoch cert is not served; it has been
removed — the permanent test is a TODO below.)

## Why it matters

For a coord a participant **cannot directly anchor** (distant T2/T3, or any coord whose FRET/tx-log direct
anchor is absent) and that is **already trust-established**, the verifier
(`packages/db-core/src/cohort-topic/membership/verifier.ts`, `fallbackTrust` → `reject`) rejects an
un-anchored successor with no rotation attestation — no trust-on-first-use downgrade. So the participant
stays on the cached predecessor cert.

That is usually harmless — message verification only needs `signers ⊆ cert.members` with a `≥ minSigs`
quorum, and the firstKx (the signing core) is unchanged, so messages signed purely by the unchanged core
still verify against the stale cert. **The residual gap:** the threshold assembler collects from the *whole*
cohort, so a message's `signers` can legitimately include a post-firstKx member that swapped in. Such a
message has a signer `∉` the stale cert's members → fails verification → triggers the single refetch →
fetches the new (unattested) cert → rejected → the message is `untrusted`, even though the legitimate current
cohort produced it.

In production this is **masked on served coords** by the FRET direct anchor (`FretTrustAnchor` is already
wired into the verifier in `host.ts`; the participant re-anchors directly, no chain needed). It bites only
coords with no direct-anchor authority that are reached purely through the rotation chain.

## Chosen fix (Option A — make the rotation boundary "any epoch change")

Decouple both gates from firstKx and key them on the **full cohort identity (`cohortEpoch`)** instead. Any
member change — head or tail — rotates the epoch, so:

- the publisher republishes promptly on **any** epoch change, and
- the host attaches a rotation attestation on **any** epoch change,

which closes the chain gap completely: an un-anchored successor for an already-trusted coord always carries a
valid attestation and inherits trust via the chain.

**Tradeoff (documented, accepted):** a non-firstKx churn now costs **one extra `/sign` round** (the rotation
attestation) and one prompt republish it previously deferred to the 5-min refresh. Both are gated on an
actual epoch change (not per tick), and post-firstKx churn is comparatively rare, so the added `/sign`/publish
traffic is bounded by real churn rate. This is the simplest option that gives the rotation chain full
coverage rather than relying on direct anchors to mask the gap on every coord that matters.

### Why not the alternatives

- **Decouple only the attestation trigger (keep the firstKx republish gate).** The successor still isn't
  *served* until the 5-min refresh, so the untrusted-message window stays open up to `T_membership_refresh`.
  Narrower, not closed. Option A closes it for one extra round.
- **Document the limit and rely on direct anchors.** The FRET direct anchor already masks this on served
  T2/T3 coords, and the backlog `...-fret-stabilization-proof` / `...-txlog-committed-binding` work will
  extend direct anchoring further. But that leaves the chain-only path (un-anchored, chain-reached coords)
  permanently gapped, and the fix here is small and low-risk, so closing it outright is preferred over
  encoding a standing caveat.

### Shape of the change

`publisher.ts` — replace the firstKx republish key with a full-epoch key:

```
class SigningMembershipCertPublisher {
  // was: lastFirstKx: string[] | undefined   (base64url of the first minSigs members)
  private lastEpoch: string | undefined;      // base64url of the last published snapshot.cohortEpoch

  async onStabilized(snapshot, now, rotation?) {
    const epoch = bytesToB64url(snapshot.cohortEpoch);
    if (this.lastEpoch !== undefined && this.lastEpoch === epoch) {
      return undefined; // identity unchanged — no republish needed
    }
    return this.publish(snapshot, now, rotation);
  }

  // publish(): set this.lastEpoch = bytesToB64url(snapshot.cohortEpoch) (drop the firstKx slice + firstKx()/sameOrder helpers if now unused)
}
```

Note the sentinel flips from `lastFirstKx === undefined` to `lastEpoch === undefined` — same first-publish
semantics (the first call always publishes). `tick()` is unchanged (it already keys on elapsed time, not
membership).

`host.ts` — replace `firstKxChanged` with an epoch comparison; `CohortIdentity` already carries `epochKey`:

```
// remove firstKx() + firstKxChanged(); sameStringOrder stays (still used at ~L1752)
const epochChanged = (a: CohortIdentity, b: CohortIdentity): boolean => a.epochKey !== b.epochKey;
...
const rotating = predecessor !== undefined && epochChanged(predecessor, current);
```

`produceRotation` needs no change: it already scopes the `/sign` round to `predecessor.epoch` (as `prevEpoch`)
and `predecessor.memberStrs` (the outgoing cohort). For a tail-only change the signing core is unchanged, so
the predecessor quorum is at least as reachable as for a firstKx rotation.

## Considerations / tripwires (record, don't file)

- **Endorser two-deep epoch history.** The `/sign` `"rotation"` endorsement gate
  (`priorCohortMembersAt` → `RotationState.membersAt`) only remembers the current + immediately-prior
  observed epoch. This bound is **orthogonal** to this change: `RotationState.observe` already shifts on
  every assembly-observed epoch change (any member change rotates the epoch), so rapid churn could exhaust
  the window today regardless of whether we attest. Option A does not shorten it. If rapid multi-step churn
  ever makes rotation attestations frequently unproducible (predecessor epoch aged out of the window), that
  is a *separate* concern about history depth, not this ticket. Leave a `NOTE:` at the `epochChanged` site
  pointing at `RotationState` so a future reader meets it there.
- **Publish/`/sign` traffic under churn.** Prompt republish + attestation on every epoch change raises
  publish and `/sign` volume proportional to churn. Bounded and gated (never per-tick), acceptable at the
  expected churn rate. `NOTE:` at the publisher republish gate: if a high-churn cohort ever shows excess
  `/sign` load, reconsider batching or a short debounce.

## TODO

- [ ] `publisher.ts`: switch `SigningMembershipCertPublisher` from a firstKx republish key (`lastFirstKx`) to
  a full-epoch key (`lastEpoch`, base64url of `snapshot.cohortEpoch`); republish on any epoch change. Remove
  the now-unused `firstKx()` / `sameOrder()` helpers if nothing else references them. Update the class + file
  header doc comments (they currently describe the "first `k − x` change forces a fresh publish" rule).
- [ ] `host.ts`: replace `firstKx` / `firstKxChanged` with `epochChanged` (compare `CohortIdentity.epochKey`);
  update `publishMembership`'s `rotating` computation. Keep `sameStringOrder` (still used at ~L1752). Update
  the surrounding comments (the "mirrors the publisher's own republish gate" note stays accurate — both now
  key on the epoch).
- [ ] Add a `NOTE:` at the `epochChanged` site re: the endorser two-deep history bound, and a `NOTE:` at the
  publisher republish gate re: `/sign` traffic under high churn (per the tripwires above).
- [ ] `packages/db-core/test/cohort-topic/membership.spec.ts`: add publisher unit tests using a **distinct
  epoch per member set** (the existing `snapshot()` helper uses a constant `EPOCH`, which masks this):
  - a tail-only (post-firstKx) member change **now republishes** (regression test for this fix);
  - the republished tail-change cert can carry a rotation attestation (assert the `rotation` arg is attached
    on a non-firstKx change, mirroring the existing `attaches a rotation attestation` test but with an
    unchanged firstKx);
  - the no-change case (same epoch) still returns `undefined` (no spurious republish).
- [ ] Add/extend an end-to-end assertion for the host rotation trigger if a suitable harness exists
  (`packages/db-p2p/test/cohort-topic/*` — check `live-tier` / membership specs): a tail-only churn produces a
  successor cert **with** a rotation attestation, and a chain-only (un-anchored) participant accepts it. If no
  cheap harness exists, cover the trigger logic at the unit level and note the e2e gap in the review handoff.
- [ ] Run `yarn test` (stream output) in `packages/db-core` and `packages/db-p2p`; typecheck both. Confirm no
  regression in the existing membership / rotation / live-tier specs.
