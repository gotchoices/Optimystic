description: A node asked to co-sign a cohort membership certificate now re-derives what it is willing to vouch for from its own view and refuses anything that doesn't match, instead of blindly signing whatever bytes it was handed.
prereq: cohort-topic-membership-cert-trust-anchoring
files:
  - packages/db-p2p/src/cohort-topic/host.ts (handleSignRequest payload binding + SignEndorsementDeps + signEndorse wiring + CohortTopicHostOptions.now + decodeSignableImage/sameMemberList helpers)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (buildMesh injects a non-tripping endorser clock for virtual time)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (/sign binding refusal tests + rotation structural test + helpers)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (the signable array images the endorser re-derives — read-only reference)
  - packages/db-core/src/cohort-topic/membership/publisher.ts (membershipCertSignable — the image to match — read-only reference)
----

# Complete: bind `/sign` endorsements to a payload the endorser independently re-derives

## What landed

`handleSignRequest` (`packages/db-p2p/src/cohort-topic/host.ts`) — the `/sign` endorsement policy a cohort
member runs when another member dials it to collect a `k − x` threshold signature — now, after the existing
cohort-membership + wire-`cohortEpoch` gates and before signing, decodes the canonical signable image and
refuses unless it re-derives to what the node independently agrees to attest:

- **All non-rotation kinds:** the image tag matches the kind (`membership`→`"MembershipCertV1"`, etc.) and
  the payload-internal `cohortEpoch` (`image[2]` for membership, last array element for promotion/demotion)
  equals the endorser's current epoch for `coord`.
- **`membership` (the core fix):** `cohortCoord` (`image[1]`), the full `members` list (`image[3]`,
  deep-equal to the endorser's own ascending-sorted b64url cohort set re-derived from the SAME
  `cohortAround(coord)` the per-coord publisher signs over), and a finite, not-far-future `stabilizedAt`
  (`image[4]`) all match the endorser's independent view (`SignEndorsementDeps.expectedMembershipFields`).
- **`rotation`:** prior-epoch gate untouched; a structural check refuses a payload that is not a
  `MembershipCertV1` image.

The `stabilizedAt` far-future bound compares against an injectable wall clock (`CohortTopicHostOptions.now`,
default `Date.now`); the virtual-time mesh harness injects `now: () => +Infinity` so synthetic future
publish timestamps are not rejected while finiteness still holds.

## Review findings

### Method
Read the implement diff (`f61e9ae`) for `host.ts`, the mesh harness, and the spec with fresh eyes before
the handoff summary; cross-checked array indices against `db-core/.../sig/payloads.ts`; traced the honest
network path (`cohortAround` → `cohort()` → publisher `snapshotAt`, and the endorser's
`expectedMembershipFields` → same `cohortAround`); audited `unknown[]` handling for type safety; ran lint
(tsc), the targeted suites, and the end-to-end live-tier/reactivity suites.

### Correctness — checked, no defects found
- **Array-index ↔ payload-image agreement is correct.** `MembershipCertV1` image is
  `["MembershipCertV1", cohortCoord, cohortEpoch, members, stabilizedAt]` → tag[0], coord[1], **epoch[2]**,
  members[3], stabilizedAt[4]; promotion/demotion carry `cohortEpoch` as the **last** element. The host's
  `image[2]`-vs-last-element selection matches exactly.
- **Honest path re-derives from the same view the publisher signs.** `expectedMembershipFields(coord)` and
  the publisher both bottom out in `ctx.cohortAround(coord)` (via `cohort()`/`snapshotAt`) and
  `membershipCertSignable` (byte-sorted b64url members), so a legitimate quorum is never spuriously refused.
  Confirmed end-to-end: live-tier 11/11 (real cert publish + endorse + promotion + rotation), reactivity 5/5.
- **Promotion embedded-epoch gate does not break honest promotion.** The promotion lifecycle stamps the
  notice `cohortEpoch` from `localEpoch()` (= current epoch); the wire-epoch gate already requires that to
  equal `currentEpoch(coord)`, so the new payload-epoch check is consistent, not a new refusal surface.
- **Type safety of `unknown[]` decode is sound.** Empty/short arrays, non-array `members`, non-string
  entries, non-number/`NaN`/`Infinity` `stabilizedAt`, and undecodable bytes all fall to a refusal; the
  decode is `try/catch` around `b64urlToBytes`+`JSON.parse`.
- **Mutually-reinforcing epoch=H(members) argument holds.** A forged member list cannot also carry the
  honest epoch (would fail the wire-epoch gate first); an honest epoch cannot ride a forged member list
  (members gate). The falsified-members test isolates the members gate (honest epoch field, inflated list).

### Findings & disposition
- **MINOR (fixed inline, DRY):** `sameMemberList` duplicated the exact loop body of the module-level
  `sameStringOrder`. Consolidated `sameMemberList` to guard the `unknown`/non-array case then delegate to
  `sameStringOrder` (behavior-preserving: non-array → false, element-wise `!==`). Typecheck clean,
  threshold-assembly 22/22 still green after the change.
- **OBSERVATION (not changed):** the `stabilizedAt` far-future tolerance is a fixed 5 s skew. Because
  `stabilizedAt` is stamped to the publisher's publish time (a near-`now` value, not a deep-past event) and
  endorsement happens at ≈ the same wall-clock moment plus network delay, the bound only trips when the
  publisher's clock leads the endorser's by > 5 s. That is uncommon (and certs refresh every 5 min), so it
  is left as the implementer tuned it; flagged here in case real-world peer clock skew later motivates a
  wider band. Not security-critical (it is an upper bound on a sanity check, not the trust gate).

### Scope boundaries — verified acceptable, already tracked
- **Promotion/demotion content only partially bound** (tag + embedded-epoch, not `topicId`/tiers/
  `effectiveAt` re-derivation). Downstream `promote` still enforces `signers ⊆ cohort` + `effectiveAt`
  high-water. Parked in backlog `cohort-topic-sign-endorsement-hotcold-refinement` (confirmed present).
- **Rotation successor only structurally checked**, by design — the endorser is the outgoing cohort and may
  not know the successor member set; the prior-epoch membership gate is the trust check.

### Docs
No markdown doc references the `/sign` endorsement protocol (the `docs/cohort-topic.md` referenced in code
JSDoc does not exist in the tree). The protocol documentation lives in the `host.ts` JSDoc, which the
implementer updated thoroughly and which accurately reflects the new binding. Nothing stale to correct.

### Tests / lint
- `node ./node_modules/typescript/bin/tsc --noEmit` from `packages/db-p2p` → exit 0 (use the **local** TS
  5.9.3, not `npx tsc`).
- threshold-assembly **22/22**, live-tier **11/11**, reactivity-real-crypto **5/5** — all green in isolation.
- Full-suite: the single `reactivity / mesh — cold-to-hot growth + delivery` timeout under full-suite load
  is pre-existing (its mesh runs at past `vtime`, so the new bound never trips; the added per-endorsement
  work is a sub-ms `JSON.parse`) and is already tracked in backlog
  `mock-tier-mesh-fullsuite-timeout-flakiness`. Not re-flagged in `.pre-existing-error.md` (already triaged).

## Outcome
Milestone delivered as specified. One minor DRY fix applied inline; no major findings (the two documented
scope limits are already filed in backlog). Lint + the suites covering this change pass.
