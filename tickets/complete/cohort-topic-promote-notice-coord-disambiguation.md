description: A node helping run several groups for the same topic could apply a "grow"/"shrink" decision to the wrong group or silently drop a valid one; the decision message now names its group (protected by the same signature) and is delivered by that name.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (PromotionNoticeV1 / DemotionNoticeV1 — cohortCoord field)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validate cohortCoord on both notices)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (cohortCoord folded into both signing images; cohortEpoch kept LAST)
  - packages/db-core/src/cohort-topic/promotion.ts (PromotionDeps.cohortCoord; promote()/demote() stamp it)
  - packages/db-p2p/src/cohort-topic/host.ts (createCoordEngine wires cohortCoord; handleInboundNotice routes by findByCoord; per-coord high-water)
  - packages/db-core/test/cohort-topic/{wire,promotion}.spec.ts
  - packages/db-p2p/test/cohort-topic/{promote-notice,live-tier,threshold-assembly,service}.spec.ts
  - docs/cohort-topic.md (§Promotion pipeline; §Wire formats)
difficulty: hard
----

# Complete: carry the served coord on promotion/demotion notices so a multi-cohort node routes them to the right engine

## What shipped

A **cohort** is the small group of nodes that jointly forward one topic at one point in the routing
tree. When a cohort grows (promotes) or shrinks (demotes) it threshold-signs a notice and broadcasts it
so siblings adopt the same state. Previously that notice identified itself only by `(topicId, tier)`, not
by the specific cohort — so a node serving several sibling cohorts for one `(topic, tier)` (possible at
tree depth `d ≥ 1`, where each cohort sits at its own served coord `coord_d(participantCoord, topicId)`)
could adopt a notice into the wrong cohort or fail the signature check and silently drop a valid one. A
second bug shared the root: the replay high-water was keyed by `(topic, tier)`, so two sibling cohorts on
one node shared one water and one cohort's notice could stale-drop the other's.

The fix adds a `cohortCoord` field (the deciding cohort's served coord) to both notices, folds it into
both threshold-signing images (so it cannot be rewritten to hijack a sibling), routes inbound notices by
`registry.findByCoord(cohortCoord)` instead of a first-match `(topic, tier)` scan, and keys the
high-water per served coord. This is **latent, not a live regression**: multi-cohort serving is not yet
functional and no nodes speak this protocol pre-release, so it ships as a hard, coordinated wire+signature
change with no version negotiation — a gate for future multi-cohort promotion.

The implementation matches the review of the implement-stage diff (`2cceee4`); no code changes were
needed during review.

## Review findings

Adversarial pass over the implement diff (`2cceee4`) with fresh eyes, then the handoff. Build (tsc) is
the only static gate — the repo's root `lint` script is a stub (`echo 'Lint not configured…'`), so there
is nothing else to run.

**Validation run this pass (all green):**
- `yarn workspace @optimystic/db-core build` — clean.
- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-core test` — **998 passing**.
- `yarn workspace @optimystic/db-p2p test` — **1077 passing / 37 pending / 0 failing**. The lone
  `parent unreachable` line is an expected `log()` from `host-antidos-coldstart.spec.ts`'s
  deliberate-unreachable test, not a failure. No `.pre-existing-error.md` written.

**Correctness — verified, no findings.**
- Signature binding is real: the coord-tamper test (`promote-notice.spec.ts`) uses **real** threshold
  crypto — rewriting `cohortCoord` on a validly-signed notice yields `untrusted`. Confirmed `cohortCoord`
  sits in both signing images (`promotion.spec.ts` `.contains` checks) and survives wire round-trip
  (`wire.spec.ts`).
- Routing/verify coord can never diverge: `findByCoord(cohortCoord)` returns the engine keyed by that
  coord, so `target.servedCoord` canonically equals the notice's `cohortCoord`, and
  `verifyAndApplyNotice` looks the cert up by exactly that coord. The "combined route-by-A-and-verify-
  against-A's-real-cert" test the handoff flagged as missing is redundant *by construction* (there is no
  code path where the routed coord and the verified coord differ) — agreed, no ticket filed.
- Epoch-last coupling holds: both notice images are 7 elements with `cohortEpoch` last, so the `/sign`
  endorser's positional read (`image[image.length - 1]`) still reads the epoch. The bidirectional `NOTE:`
  guards both sides. Verified by the passing e2e suites the handoff says caught the original epoch-displaced
  bug.
- Producers are complete: the only runtime constructors of these notices are `promote()`/`demote()` in
  `promotion.ts`, both updated. No other src builds these objects (grep-confirmed); `cohortCoord` being
  newly-required is enforced by tsc and by `validate.ts`.
- Per-coord high-water: the `tier` component of the `` `${cohortCoord}|${tier}` `` key is genuinely
  redundant (a served coord embeds its own tier, and both `promote` and `demote` for a cohort use
  `treeTier(topicId)`), so it is stable per coord — harmless, matches the "readability only" comment.
- Docs (`docs/cohort-topic.md` §Promotion pipeline + both §Wire-format listings) reflect the new reality;
  cross-checked against `wire/types.ts` and the pipeline in `handleInboundNotice`.

**Minor — none.** Nothing needed an inline fix.

**Major — none.** No new fix/plan/backlog ticket filed.

**Deviation from the ticket, re-checked and endorsed.** The ticket said `CoordRegistry.findServing`
"becomes unused" and should be removed; the implementer correctly kept it — there are two genuine
tier-0 callers (`matchmaking/query-transport.ts:147`, `libp2p-node-base.ts` reactivity forwarder). The
notice path no longer calls it, so the first-match trap is closed *for notices*; reconciling those two
tier-0 readers with multi-cohort serving is owned by `cohort-topic-followon-derivation`. Removing
`findServing` would break the build. No follow-on ticket needed here.

**Conditional/speculative (tripwires) — considered, nothing new filed.**
- *Non-canonical base64url could bypass the pre-verify stale gate.* The high-water key uses the raw wire
  `cohortCoord` string while `findByCoord` canonicalizes (decode→re-encode), so a re-encoded replay could
  key-miss the water and reach the verify. This is **pre-existing** (the old key used the raw `topicId`
  string identically), **bounded** (the signature covers the field, so a re-encoded frame fails
  verification and is never applied; the rate limiter + bounded refetch cap the amplification), and **not
  introduced by this change** — so no new code comment or ticket. Recorded here only as "considered".
- The two out-of-scope conditions the handoff parked already carry `NOTE:` tripwires in `host.ts`
  (parent-coord demotion is a no-op apply for a parent-only node at `broadcastNotice`; the epoch-last
  coupling at the `/sign` epoch read). Both re-read and accurate.

**Known parked gaps (disclosed, correctly out of scope).**
- The `/sign` endorser still does not bind `cohortCoord` for promotion/demotion notices (only the tag +
  embedded epoch). This is defense-in-depth, not a correctness hole: a signer is only ever instantiated at
  its own `servedCoord`, so the coord it stamps equals the endorsers' cohort coord; an insider cross-coord
  forgery would still need ≥ `minSigs` membership overlap with the target cohort's cert to verify. Owned by
  the existing backlog ticket `cohort-topic-sign-endorsement-hotcold-refinement`.
- No full-mesh e2e stands up two live cohorts for one `(topic, tier)` on one node — the mesh harness can't
  until the sibling `d ≥ 1` derivation tickets (`cohort-topic-followon-derivation`,
  `cohort-topic-participant-coord-routing-key-mismatch`) land. The disambiguation guarantee is proven at
  the `handleInboundNotice` unit level. This is the honest ceiling of what is testable pre-derivation.

## Tests (starting point, now covering the new surface)

New/changed coverage exercised and reviewed: two-cohort routing disambiguation, per-coord high-water
isolation (equal-`effectiveAt` sibling notices both apply; own replay still stale), coord-tamper
rejection under real crypto, signing-image coverage for both notices, wire round-trip, and the adjusted
"coord miss → dropped" drop path. Routing tests intentionally use a trust-all verifier to isolate routing
from crypto; the tamper test covers the crypto binding with real signatures.
