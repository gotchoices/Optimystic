description: A group of nodes that swaps in a replacement member now announces and signs the change so that faraway peers who track the group only through its chain of signed hand-offs stay on the current member list instead of getting stuck on a stale one.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/publisher.ts (republish gate: SigningMembershipCertPublisher now keys on the full cohortEpoch, not the first k−x members)
  - packages/db-p2p/src/cohort-topic/host.ts (rotation-attestation trigger: epochChanged replaces firstKx/firstKxChanged; publishMembership.rotating; dropped the now-unused compareBytes import)
  - packages/db-core/test/cohort-topic/membership.spec.ts (publisher unit tests; snapshot() now derives a real epoch from the member set)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (rotation tests 8–11: comments updated to say "epoch" instead of "first k−x"; no assertion changes)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (unchanged; the accept path this fix feeds)
difficulty: medium
----

# Publish + attest a membership hand-off on *any* epoch change

## What shipped

A **cohort** is the small group of nodes that jointly serve one topic at one point in the routing tree.
Its identity label is `cohortEpoch = H(sorted all members)`. When the membership changes, two independent
decisions used to fire — but **both** keyed only off the first `minSigs` (= `k − x`) members of the sorted
set (the stable signing core, called the "firstKx"):

1. **Republish gate** (`publisher.ts`, `SigningMembershipCertPublisher.onStabilized`) — decides whether to
   serve a fresh membership certificate promptly.
2. **Rotation-attestation trigger** (`host.ts`, `publishMembership`) — decides whether the fresh cert
   carries a signed hand-off from the outgoing cohort (`prevEpoch` / `rotationSig` / `rotationSigners`).

Because both keyed on the firstKx, a membership change **beyond position `minSigs`** (e.g. the 15th/16th
member under the production `minSigs = 14`, `wantK = 16`) changed the epoch label but produced **no prompt
republish** and, when it eventually republished on the 5-minute periodic refresh, **no hand-off signature**.

The consequence (full analysis in the source ticket): a distant peer that can only verify this cohort
*through the chain of signed hand-offs* — no direct anchor available — and that has *already* trust-
established the cohort will reject an un-anchored successor cert that carries no hand-off. It stays on the
cached predecessor. Usually harmless (messages signed by the unchanged core still verify against the stale
cert), but a legitimate message whose signer set includes the swapped-in tail member is `∉` the stale
cert's members → fails → single refetch → fetches the new (unattested) cert → still rejected → the message
is reported `untrusted` even though the real current cohort produced it.

**The fix (Option A):** key **both** gates on the full cohort identity (`cohortEpoch`) instead of the
firstKx. Any member change — head or tail — rotates the epoch, so the publisher republishes promptly and
the host attaches a hand-off attestation on **any** epoch change. That closes the chain-only gap: an
un-anchored successor for an already-trusted cohort always carries a valid attestation and inherits trust
through the chain.

### Exact changes

- `publisher.ts`: the class's republish key went from `lastFirstKx: string[]` to `lastEpoch: string`
  (base64url of `snapshot.cohortEpoch`); `onStabilized` returns `undefined` only when the epoch is
  unchanged. The `firstKx()` and `sameOrder()` helpers were deleted; the `DEFAULT_MIN_SIGS` import and the
  private `minSigs` field went with them. `minSigs?` **stays** on `MembershipCertPublisherDeps` (accepted
  but no longer read) so existing callers — `host.ts` and the two db-p2p test specs — compile unchanged;
  the threshold-sign quorum has always lived in the `CohortSigner`, not the publisher. File- and
  member-level doc comments updated to describe the epoch rule.
- `host.ts`: `firstKx()` / `firstKxChanged()` replaced by
  `epochChanged = (a, b) => a.epochKey !== b.epochKey` (compares the `CohortIdentity.epochKey` that was
  already carried). `publishMembership`'s `rotating` now uses it. `produceRotation` is unchanged — it
  already scopes the `/sign` round to the predecessor epoch/members; for a tail-only change the signing core
  is unchanged, so the predecessor quorum is at least as reachable as for a firstKx rotation. `sameStringOrder`
  is kept (still used by `sameMemberList`). The unused `compareBytes` import was removed.

## How to exercise / validate

**Publisher unit tests** (`packages/db-core/test/cohort-topic/membership.spec.ts`, "membership cert
publication" block). The key enabler: `snapshot()` now derives `cohortEpoch = H(sorted members)` via the
new `epochOf()` helper, instead of a constant `EPOCH`. The old constant epoch is exactly what masked this
bug — every snapshot looked identical, so a tail change was indistinguishable from no change. New/changed
cases:
- **`republishes on any member change — head OR tail`** — the regression test. First two members fixed,
  only the tail moves (`2,3 → 2,20`); asserts a fresh cert *is* served (would have been `undefined` before).
- **`does not republish when the member set (epoch) is unchanged`** — same set in a different order + a
  later `stabilizedAt` → same epoch → no spurious republish (guards against over-publishing).
- **`attaches a rotation attestation on a tail-only change`** — a tail-only change (first two fixed) now
  both republishes *and* carries the attestation verbatim; mirrors the old firstKx rotation test but with an
  unchanged signing core.

**End-to-end rotation tests** (`packages/db-p2p/test/cohort-topic/live-tier.spec.ts`, tests 8–11). These
still pass unchanged: they run `minSigs = wantK = 4`, so firstKx = the whole cohort and *any* swap changes
both firstKx and the epoch — i.e. old and new triggers fire identically there. Only their comments changed
(now say "epoch" not "first k−x"). They cover: hand-off produced + accepted as a chain extension (8),
forged non-predecessor hand-off rejected (9), clean no-attestation fallback when the predecessor quorum is
unreachable (10), and a plain periodic refresh emitting no rotation fields (11).

**Commands run this pass (all green):**
- `yarn build` (tsc) in `packages/db-core` — clean.
- `yarn build` (tsc) in `packages/db-p2p` — clean.
- `yarn test` in `packages/db-core` — **999 passing**.
- `yarn test` in `packages/db-p2p` — **1077 passing / 37 pending / 0 failing**. The single
  `parent unreachable` stderr line is an expected `log()` from `host-antidos-coldstart.spec.ts`'s
  deliberately-unreachable-parent test, not a failure. No `.pre-existing-error.md` written.

## Known gaps (treat the tests as a floor)

- **No deterministic tail-only host-trigger e2e.** The unit test proves the *republish gate* (the
  publisher) fires on a tail-only change, and it's the same gate the host's `epochChanged` mirrors. But
  there is no end-to-end test that drives the **host** trigger with a swap that is *provably* beyond the
  firstKx (signing core unchanged). Reason: the live-tier mesh assigns random Ed25519 identities, and a
  cohort's firstKx is the first `minSigs` of the *sorted* member set — the harness gives no control over
  which sorted position a swapped member lands in, so a "swap only a tail member" scenario can't be forced
  deterministically. To make it real you'd need `minSigs < wantK` (so a tail exists) *and* a way to pin
  member sort order across the swap. The source ticket explicitly permitted covering the trigger at the
  unit level and noting this gap here. **Suggested reviewer probe:** if you want e2e coverage, the cheapest
  path is to extend the mesh harness (`packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts`) with
  identity pinning, or assert at the host level that `epochChanged` gates `rotating` given two hand-built
  `CohortIdentity` values — but the latter reaches into `createCoordEngine` internals with no seam today.

- **`minSigs?` is now a dead knob on `MembershipCertPublisherDeps`.** Kept only for call-site
  compatibility (host + `threshold-assembly.spec.ts` + `promote-notice.spec.ts` still pass it). If a later
  cleanup wants to remove it, it must also drop those three call sites. Documented at the field.

## Tripwires planted (per the source ticket; recorded here as the index, not the analysis)

- **`publisher.ts`, `onStabilized`** — `NOTE:` that prompt republish + attestation now fire on any epoch
  change (bounded by real churn, never per-tick); if a high-churn cohort ever shows excess `/sign` or
  publish load, reconsider a short debounce / batching.
- **`host.ts`, at `epochChanged`** — `NOTE:` that the `/sign` "rotation" endorsement gate only remembers
  the current + immediately-prior epoch (`RotationState.membersAt`). That two-deep bound is *orthogonal* to
  this change (it already shifts on every observed epoch change), so this fix does not shorten it; if rapid
  multi-step churn ever ages a predecessor epoch out of the window, that's a history-depth concern in
  `RotationState`, not this trigger.

## Suggested review focus

- Confirm the epoch is genuinely a pure function of the *whole* member set everywhere it's compared
  (publisher `snapshot.cohortEpoch` vs. host `CohortIdentity.epochKey`) so the two gates can't disagree on
  what counts as a change.
- Sanity-check the accepted tradeoff: one extra `/sign` round + one prompt republish per post-firstKx
  churn event (both gated on an actual epoch change). Is the churn rate assumption sound for production?
- Decide whether the tail-only host-trigger e2e gap warrants a `debt-` backlog ticket (harness identity
  pinning) or is adequately covered by the unit test + the unchanged-behavior argument for tests 8–11.
