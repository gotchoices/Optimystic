description: A node asked to co-sign a cohort membership certificate now re-derives what it is willing to vouch for from its own view and refuses anything that doesn't match, instead of blindly signing whatever bytes it was handed.
prereq: cohort-topic-membership-cert-trust-anchoring
files:
  - packages/db-p2p/src/cohort-topic/host.ts (handleSignRequest body + SignEndorsementDeps + signEndorse wiring + CohortTopicHostOptions.now + decodeSignableImage/sameMemberList helpers)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (buildMesh injects a non-tripping endorser clock for virtual time)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (new /sign binding refusal tests + rotation structural test + helpers)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (the signable array images the endorser re-derives — unchanged, read-only reference)
  - packages/db-core/src/cohort-topic/membership/publisher.ts (membershipCertSignable — the image to match — unchanged, read-only reference)
difficulty: hard
----

# Review: bind `/sign` endorsements to a payload the endorser independently re-derives

## What this delivers (the milestone)

`handleSignRequest` (`packages/db-p2p/src/cohort-topic/host.ts`) is the `/sign` endorsement policy a
cohort member runs when another member dials it to collect a `k − x` threshold signature. **Before this
change** it ran only a cohort-membership + wire-`cohortEpoch` gate and then signed `request.payload`
**without ever looking inside it**. Because the requester supplies those bytes verbatim, a single cohort
insider could collect honest endorsements over a `MembershipCertV1` the cohort never agreed to (inflated
`members`, falsified `stabilizedAt`, or even a promotion/demotion image smuggled under `kind: membership`).

**Now**, after the existing cohort + wire-epoch gates and before signing, the endorser decodes the
canonical signable image and refuses unless it re-derives to what the node independently agrees to attest:

- **All non-rotation kinds:**
  - the image tag matches the kind (`membership`→`"MembershipCertV1"`, `promotion`→`"PromotionNoticeV1"`,
    `demotion`→`"DemotionNoticeV1"`) — closes the kind-mismatch hole;
  - the payload-internal `cohortEpoch` equals the endorser's current epoch for `coord` (`image[2]` for a
    membership image, the last array element for promotion/demotion) — closes the falsified-internal-epoch
    hole, cheaply, for promotion/demotion too.
- **`membership` additionally** (the core fix), bound against the endorser's own re-derived view
  (`SignEndorsementDeps.expectedMembershipFields`, wired in the host from the **same** `cohortAround(coord)`
  snapshot the per-coord publisher signs over):
  - `cohortCoord` (`image[1]`) matches;
  - **`members` (`image[3]`) deep-equals the endorser's ascending-sorted b64url cohort set** — a forged
    member list is refused;
  - `stabilizedAt` (`image[4]`) is a finite number and not far-future (`<= now() + 5s`).
- **`rotation`:** the prior-epoch membership gate is untouched (its own design); only a **structural**
  sanity check was added — refuse a rotation payload that is not a `"MembershipCertV1"` image.

Because epoch = H(member-set) in this host, the members and embedded-epoch checks are mutually
reinforcing: a forged member list cannot also carry the honest epoch, and an honest epoch cannot ride a
forged member list. The participant-side verifier still independently re-checks `signers ⊆ cert.members`.

## Key design decision a reviewer should scrutinize — the `stabilizedAt` clock seam

The far-future `stabilizedAt` bound compares against a wall clock. The endorser clock is now injectable
via `CohortTopicHostOptions.now` (default `Date.now`, the right production choice). **The virtual-time
test harness (`buildMesh`) injects `now: () => Number.POSITIVE_INFINITY`** so its synthetic, often
future-advanced publish timestamps (e.g. live-tier test 11 fast-forwards 5 min past `T_membership_refresh`;
the reactivity mesh stamps `stabilizedAt = vtime`) are not rejected, while the finiteness check still
holds. Rationale: the harness is explicitly *not* a wall-clock simulator (it drives `now` via explicit
timestamps), so the endorser cannot see virtual time without a seam. **Verify** this opt-out is acceptable
and that production retains the real tight bound. (Alternative the reviewer may prefer: thread a single
shared virtual clock through the harness instead of disabling the bound — heavier, not done here.)

## Use cases / validation

Tests live in `packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts`,
`describe('cohort-topic: /sign endorsement policy')` and the rotation describe block. Helpers added:
`epochOf` (mirrors the host's `cohortAround` epoch = H(sorted members)), `expectedFields`,
`membershipImage`, `depsFor` (wires the new deps + a fixed clock).

New / changed coverage (all green):
- **endorses a real membership cert image that matches the endorser view** (happy path; was previously an
  arbitrary-bytes payload that now would be refused — rewritten to a real image).
- **refuses a falsified-members payload** (the reproduction: honest epoch field, inflated `members`). This
  was GREEN-as-bug on HEAD (the old policy signed it); it is now refused. *Note: I did not re-run it
  against the pre-fix HEAD to watch it fail (would mean reverting my own edits); the refusal logic and the
  old sign-anything path make this certain, but a reviewer wanting the red-then-green proof can `git stash`
  the `host.ts` hunk and re-run.*
- **refuses** a promotion-image under `kind: membership` (tag mismatch), an internal-epoch mismatch, a
  far-future `stabilizedAt`, an undecodable payload, and a membership request with **no** membership view
  wired.
- **rotation:** the happy-path test now uses a real `MembershipCertV1` image; a new test refuses a
  non-`MembershipCertV1` rotation payload; the four prior-epoch gate tests stay green.

Validation run:
- `node ./node_modules/typescript/bin/tsc --noEmit` from `packages/db-p2p` → clean (exit 0). (Use the
  **local** TS 5.9.3; `npx tsc` pulls a newer TS that spuriously flags `downlevelIteration` and misresolves
  `@types/node` — not a real signal.)
- Full suite `yarn workspace @optimystic/db-p2p test`: **976 passing, 30 pending, 1 failing**. The one
  failure is `reactivity / mesh — cold-to-hot growth + delivery` timing out at 60 s **under full-suite
  load only** — it passes in isolation (first test ~27.6 s) and is unrelated to this change (its mesh runs
  at `vtime = 1_700_000_000_000`, in the *past* vs real `Date.now()`, so the new bound never trips; the
  added per-endorsement work is a sub-ms `JSON.parse`). Flagged in `tickets/.pre-existing-error.md`.
  Targeted suites in isolation: threshold-assembly **22/22**, live-tier **11/11**, reactivity **5/5**.

## Known gaps / honest limitations (treat the tests as a floor)

- **Promotion / demotion content is only partially bound.** They now get the tag + embedded-epoch gate,
  but the endorser does **not** re-derive `topicId`, `fromTier`/`toTier` (promotion),
  `tier`/`parentCohortCoord` (demotion), or `effectiveAt` against an independent view — so an insider could
  still get the cohort to sign a notice for an arbitrary topic/tier as long as the epoch matches (the
  downstream `promote` handler still enforces `signers ⊆ cohort` + the `effectiveAt` high-water). Full
  promotion/demotion binding needs a per-topic `directParticipants` hot/cold view the current
  `(payload, minSigs)` `ICohortThresholdCrypto` port cannot carry, plus gossip record replication that is
  still interim. **Parked in backlog `cohort-topic-sign-endorsement-hotcold-refinement` (already filed).**
- **Rotation successor cert is only structurally checked**, not re-derived. The endorser is the *outgoing*
  cohort and may not know the *successor* member set, so full successor binding is out of scope here; the
  prior-epoch membership gate remains the trust check. Candidate follow-on if rotation forgery is in scope.
- **No churn tolerance for the membership members check**, by design: same epoch ⟹ identical member set, so
  a tolerance band is unnecessary for the current-epoch case and was deliberately omitted.
- **The `stabilizedAt` lower bound is not enforced** (the ticket judged it not security-critical).
- The reproduction test asserts the post-fix refusal but was not executed against pre-fix HEAD (see above).

## Suggested review focus

1. `image[2]` vs last-element epoch indexing — confirm it matches `sig/payloads.ts` array order for each
   kind (membership epoch is index 2, not last; promotion/demotion epoch is last).
2. The honest-assembly path: confirm `expectedMembershipFields` (host wiring) re-derives from the **same**
   `cohortAround(coord)` the publisher's `snapshotAt` uses, so a legitimate quorum is never spuriously
   refused (live-tier 11/11 + reactivity exercise the real network path end-to-end).
3. The `now: Infinity` harness opt-out vs. a shared virtual clock (the design-decision call-out above).
4. The promotion/demotion residual gap above — confirm it is acceptable to ship as the documented milestone
   boundary, or split a tighter ticket.
