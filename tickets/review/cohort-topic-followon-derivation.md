description: A participant redirected to a not-yet-created deeper cohort can now get that cohort started (instead of bouncing until it gives up), by carrying a signed "I was redirected here" flag that pays the same anti-abuse cost a fresh topic already does.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1.followOn + bootstrapEvidence doc)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload appends followOn)
  - packages/db-core/src/cohort-topic/wire/validate.ts (mutual-exclusion + treeTier>=1)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (gate fires on followOn; tripwire NOTE)
  - packages/db-core/src/cohort-topic/walk.ts (register-side followOn re-issue)
  - packages/db-core/src/cohort-topic/service.ts (messageFactory stamps followOn + mints evidence)
  - packages/db-core/src/cohort-topic/member-engine.ts (RegisterContext.followOn sourcing comments)
  - packages/db-p2p/src/cohort-topic/host.ts (dispatchRegister derives followOn from reg.followOn)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (signedRegister followOn opt; routeTrace signed-ness filter)
  - docs/cohort-topic.md (§Lookup, §Cold-start instantiation, §Anti-DoS, §Wire formats)
  - packages/db-core/test/cohort-topic/{walk,member-engine,wire,antidos,bootstrap-evidence-envelope}.spec.ts
  - packages/db-p2p/test/cohort-topic/{peer-key-signing,cohort-topic-scale-antiflood,cohort-topic-scale-lifecycle}.spec.ts
----

# Review: cohort-topic follow-on cold-start derivation

## What this is (plain language)

A topic's cohort tree grows under load: when a cohort fills up it "promotes" and starts telling new
joiners "go one tier deeper" (a `Promoted(d+1)` redirect). But the deeper cohort may not exist yet.
Before this change, a joiner that followed such a redirect hit "I'm not serving this" (`NoState`),
walked back inward, hit the promoting cohort again, got redirected again — an oscillation that only
stopped when a safety counter (`maxSteps`) tripped and the joiner backed off. So a join landing on a
freshly-promoted-but-not-yet-grown branch never actually succeeded; it only retried.

This change lets the joiner tell the deeper cohort "I'm here because your parent redirected me" — a flag
called `followOn` — so the cold cohort instantiates itself. Because that flag is participant-asserted (and
therefore forgeable), a follow-on cold-start is made to pay the **same** anti-abuse cost (proof-of-work at
T2/T3, permissive-but-logged at T0/T1) that a fresh-topic `bootstrap` cold-start already pays.

## What was implemented

- **Wire flag.** `RegisterV1.followOn?: boolean`. Set only on the dedicated re-issue after a `Promoted`
  redirect target answers `NoState`. Always `treeTier >= 1`; mutually exclusive with `bootstrap` and
  `probe`. Appended to `registerSigningPayload` so a MITM cannot strip/flip it. `validateRegisterV1`
  rejects >1 of {bootstrap, followOn, probe} and rejects `followOn` at `treeTier < 1`.
- **Evidence gate.** `bootstrap-evidence.ts` `verify` now demands evidence when `reg.followOn === true` as
  well as `reg.bootstrap === true` (identical tier policy — the whole point: no new weakness relative to
  the already-accepted bootstrap security model).
- **Participant walk.** `walk.ts` gained register-side `followedPromoted` + `followOnReissued` tracking:
  on `NoState` after following a `Promoted` redirect, it re-issues **once** at the same child tier with
  `followOn: true`, then backs off if that also returns `NoState`. The probe path is unchanged (a probe
  never instantiates → immediate back-off). `service.ts` `messageFactory` stamps `body.followOn` and mints
  the same `bootstrapEvidence` envelope on the follow-on re-issue as on a bootstrap re-issue.
- **Host derivation.** `host.ts` `dispatchRegister` now sets `ctx.followOn = reg.followOn === true` (was
  hardcoded `false`). This is the one line that closes the wiring gap; `parentCoord` was already computed.
- **Docs.** `docs/cohort-topic.md` §Lookup, §Cold-start instantiation, §Anti-DoS (incl. a "follow-on
  hardening" tripwire block), and §Wire formats all updated. The old "followOn is not on the wire / parked"
  notes are gone; the "Landed since" list records this.

## How to validate (tests added — treat as a floor, not a ceiling)

Reviewer: the tests below pass, but they are the floor. Push on the walk state machine and the
mesh trace reconstruction in particular.

**db-core (all pass; `yarn test` in packages/db-core):**
- `wire.spec.ts` — follow-on round-trip, non-boolean reject, >1-flag reject, `treeTier < 1` reject,
  distinct signed image for `followOn:true` vs `false`/absent.
- `antidos.spec.ts` — a `followOn` register is evidence-gated exactly like a bootstrap (PoW at T2, parent-
  ref at T1); a plain register needs none.
- `walk.spec.ts` — **positive:** promoted parent + willing cold child → `accepted` via exactly one
  follow-on re-issue, no inward oscillation. **negative:** unwilling cold child → one re-issue then
  back-off (no oscillation). Probe still never emits a `followOn` frame.
- `member-engine.spec.ts` — `followOn:true` cold register + valid evidence → instantiates the tier-1 child
  and kicks off parent registration; bad evidence → `unwilling_cohort`, no instantiation; already-hot
  child → normal admit path (no re-instantiation).
- `bootstrap-evidence-envelope.spec.ts` — the signing-image snapshot now includes the appended `followOn`
  slot.

**db-p2p (all pass; `yarn test` in packages/db-p2p):**
- `peer-key-signing.spec.ts` — a `followOn` register verifies after encode→decode→validate, and a
  stripped `followOn` no longer verifies (signature coverage).
- `cohort-topic-scale-antiflood.spec.ts` — **enabled** the previously-skipped follow-on test as
  "a followOn register instantiates a cold tier-1 child under a willing quorum".

Manual command that exercises the whole path in one go:
`cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/**/*.spec.ts" --reporter min`
(189 passing / 4 pending at handoff).

## Known gaps / things I want a second pair of eyes on

- **The claim-3 anti-flood test regressed and was repaired — review the repair.** My walk change altered
  the post-promotion walk trace: the follow-on re-issue now instantiates the cold child, whose background
  **forwarder→parent link RPC** routes to the (participant-independent) `coord_0` the walk also probes,
  aliasing the walk's own root probe and fabricating a spurious inward/outward move that broke
  `outwardMovesArePromoted`. Fix: the forwarder-link frame is **unsigned** (`signature: ""`, the interim
  gap `cohort-topic-parent-child-link` closes), so I tagged each `routeTrace` entry with signed-ness
  (`cohort-topic-mesh-harness.ts` `routedFrameIsSigned`) and made `walkTraceFrom` keep only signed probes.
  **This is a harness behavior change** — a reviewer should confirm it does not mask a real speculative
  probe in any other walk-trace test (claims 1/3/4). The walker's own probes are always signed, so the
  filter should be exactly "drop the child-link RPC", but verify.
- **The claim-3 terminal assertion was loosened** from strict `backoff === true` to `attached || backoff`,
  because with follow-on the single-cohort tree can now genuinely grow (the child instantiates and may
  admit) rather than only oscillate. The *discipline* invariants (outward-moves-are-promoted, inward-
  steps-follow-no_state) are what the test now leans on. Sanity-check that loosening is honest.
- **Live-key forwarder→parent link stays unsigned → child stays `awaiting_parent`.** In live-key mode the
  parent answers `no_state` to the unsigned link frame, so the follow-on-instantiated child accepts
  participants but the parent never records it. This is pre-existing and parked as
  `cohort-topic-parent-child-link`; the follow-on admission itself still returns `accepted`.
- **The depth-law e2e stays skipped** (`cohort-topic-scale-lifecycle.spec.ts`) — re-worded to cite
  `cohort-topic-parent-child-link` (no observable multi-tier parent state to assert against until the
  parent records children). Confirm the re-word is accurate, not just a citation swap.
- **`followOnReissued` resets on every `Promoted`.** A malformed tree that alternates
  `Promoted`/`NoState` re-arms the follow-on each cycle, so `maxSteps` remains the backstop terminator
  there (bounded, covered by the existing `maxSteps` oscillation test). Confirm this is acceptable and
  cannot be turned into an amplification vector (each cycle is one extra signed RPC + one PoW mint at
  T2/T3, per the existing per-peer rate limit + topic budget).
- **T0/T1 follow-on rides the permissive-but-logged evidence path** (same as bootstrap today, until a
  committed-parent backing is wired). At T2/T3 it requires a real minted PoW. The enabled e2e uses op-tier
  0 deliberately to stay on the permissive path; there is **no e2e that a T2/T3 follow-on mints and passes
  real PoW** — that path is only unit-covered (`antidos.spec.ts` with an injected `verifyPoW`). A reviewer
  may want an e2e that a followed redirect at a T2/T3 topic actually mints PoW end-to-end.

## Review findings (index)

- **Tripwire (recorded, not a ticket): parent-vouched follow-on hardening.** PoW-gating a follow-on makes
  it as costly as a bootstrap but does not *prove* the participant was genuinely redirected. If spoofed,
  PoW-paid follow-on instantiation ever shows up as real abuse, upgrade to echoing the parent cohort's
  threshold-signed `PromotionNoticeV1` on the follow-on and verifying it against the parent's
  `MembershipCertV1` (needs a `RegisterReplyV1` field + an admission-path membership verify). Parked as a
  `NOTE:` at `packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts` (the `verify` follow-on
  branch) and documented in `docs/cohort-topic.md` §Anti-DoS "Follow-on hardening". No ticket filed — it is
  conditional on abuse being observed.
