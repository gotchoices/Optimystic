description: A participant redirected to a not-yet-created deeper cohort can now get that cohort started by carrying a signed "I was redirected here" flag that pays the same anti-abuse cost a fresh topic already does. Reviewed and completed.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1.followOn)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload appends followOn)
  - packages/db-core/src/cohort-topic/wire/validate.ts (mutual-exclusion + treeTier>=1)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (gate fires on followOn; tripwire NOTE)
  - packages/db-core/src/cohort-topic/coldstart.ts (header doc corrected during review)
  - packages/db-core/src/cohort-topic/walk.ts (register-side followOn re-issue)
  - packages/db-core/src/cohort-topic/service.ts (messageFactory stamps followOn + mints evidence)
  - packages/db-core/src/cohort-topic/member-engine.ts (RegisterContext.followOn)
  - packages/db-p2p/src/cohort-topic/host.ts (dispatchRegister derives followOn from reg.followOn)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (signedRegister followOn opt; routeTrace signed-ness filter)
  - docs/cohort-topic.md (§Lookup, §Cold-start instantiation, §Anti-DoS, §Wire formats)
----

# Complete: cohort-topic follow-on cold-start derivation

## What shipped

A topic's cohort tree grows under load: a full cohort "promotes" and starts redirecting new joiners one
tier deeper (`Promoted(d+1)`). But the deeper cohort may not exist yet. Before this change a joiner that
followed such a redirect hit `NoState`, walked back inward, hit the promoting cohort again, got redirected
again — an oscillation that only stopped when the `maxSteps` safety valve tripped and the joiner backed off.
A join landing on a freshly-promoted-but-not-yet-grown branch never actually succeeded; it only retried.

This change lets the joiner tell the deeper cohort "I'm here because your parent redirected me" via a signed
wire flag `RegisterV1.followOn`, so the cold cohort instantiates itself. Because the flag is participant-
asserted and therefore forgeable, a follow-on cold-start pays the **same** anti-abuse cost a fresh-topic
`bootstrap` cold-start already pays (proof-of-work at T2/T3, permissive-but-logged parent-reference at
T0/T1). The net effect: a redirected join now converges (accepts at the grown child or backs off cleanly)
instead of oscillating until `maxSteps`.

The implement handoff (commit `fda7431`) covers the full mechanism: wire flag + signing coverage,
mutual-exclusion/`treeTier >= 1` validation, the identical evidence gate, the walk's single-`followOn`
re-issue latch, the host deriving `ctx.followOn` from the wire flag, and the docs. This complete ticket
records the review pass over that work.

## Review findings

**Checked:** the full implement diff (`fda7431`) read first, then the handoff; every touched source file
plus the files the change *should* have touched; the walk state machine (`walk.ts`), the evidence gate
(`bootstrap-evidence.ts` / `coldstart.ts` / `member-engine.ts`), the wire codec + signing coverage, the
mesh-harness trace reconstruction, and `docs/cohort-topic.md`. Ran the full db-core and db-p2p test suites
and rebuilt db-core (typecheck).

**Aspect angles scrutinized:** SPP/DRY (follow-on reuses the bootstrap evidence path verbatim — no parallel
policy), type safety (`followOn?: boolean`, validated + normalized on the wire), error/edge paths (probe
never instantiates; unwilling cold child → back-off; bad evidence → `unwilling_cohort` with no
instantiation; already-hot child → normal admit), resource cleanup (no new state beyond two walk-local
latches), and the walk's termination discipline (single outward move is the redirect; no inward step follows
a non-`no_state`).

- **Minor — FIXED inline: stale header doc in `packages/db-core/src/cohort-topic/coldstart.ts`.** The
  module-header JSDoc still asserted "The `followOn` signal is **not** carried on the wire (`RegisterV1` has
  only `bootstrap`)" and cited an open "wiring gap … for the db-p2p binding" — both untrue after this change.
  This file was not in the implementer's touch list but describes the exact mechanism that changed. Rewrote
  the paragraph to state `followOn` is on the wire, is set only on the post-`Promoted` re-issue, is derived
  by the host into `ctx.followOn`, and is evidence-gated identically to `bootstrap`. No other stale
  "not on the wire / parked" claims remain in `src/` or `docs/` (grep-confirmed; the two remaining hits are
  in `tickets/complete/` archives, which are immutable history).

- **Walk state machine — verified correct, no finding.** `followOn` is only ever `true` while
  `followedPromoted` is `true`; the inward-stepping path (`const next = d - 1`) is unreachable once
  `followedPromoted` is set, so `followOn`/`bootstrap` never leak into an inward step. The single follow-on
  re-issue is bounded by the `followOnReissued` latch; member-retry dials of a follow-on legitimately carry
  the flag and are bounded by `maxMemberRetries` (same shape as bootstrap). Positive (willing child →
  accepted) and negative (unwilling child → one re-issue then back-off, no oscillation) both covered by new
  `walk.spec.ts` cases.

- **Handoff's three self-flagged concerns — reviewed, all judged honest:**
  - *Harness signed-ness filter* (`walkTraceFrom` keeps only signed probes): sound and test-harness-only.
    A walker's own probes are always signed; the sole unsigned frame is the forwarder→parent link
    (`signature: ""`), so the filter is exactly "drop the child-link RPC" and cannot mask a real speculative
    probe in claims 1/3/4 (those probes are signed).
  - *Loosened claim-3 terminal assertion* (`backoff` → `attached || backoff`): honest. Follow-on lets the
    single-cohort tree genuinely grow, so the terminal state is now accept-or-backoff, never spin; the
    discipline invariants (outward-move-is-promoted, inward-follows-`no_state`) are what the test now leans
    on and are still asserted.
  - *`followOnReissued` re-arms on every `Promoted`*: acceptable. A malformed alternating `Promoted`/`NoState`
    tree is bounded by `maxSteps` (covered by the existing oscillation test); each cycle is one per-peer
    rate-limited signed RPC + one PoW mint — no amplification vector.

- **Tripwire (recorded by the implementer, confirmed appropriate — not a ticket): parent-vouched follow-on
  hardening.** PoW-gating a follow-on makes it as costly as a bootstrap but does not *prove* the participant
  was genuinely redirected. If spoofed, PoW-paid follow-on instantiation ever shows up as real abuse, upgrade
  to echoing the parent cohort's threshold-signed `PromotionNoticeV1` on the follow-on and verifying it
  against the parent's `MembershipCertV1`. Parked as a `NOTE:` at `bootstrap-evidence.ts` (the `verify`
  follow-on branch) and in `docs/cohort-topic.md` §Anti-DoS "Follow-on hardening". Conditional on abuse being
  observed — correctly a tripwire, not a queued ticket.

- **Pre-existing parked items — not this ticket's scope, correctly cited:** the live forwarder→parent link
  staying unsigned (child stays `awaiting_parent` in live-key mode), the depth-law e2e
  (`cohort-topic-scale-lifecycle.spec.ts`) staying skipped, and the absence of a T2/T3 follow-on
  mint-real-PoW *e2e* (that path is unit-covered in `antidos.spec.ts` with an injected `verifyPoW`) all trace
  to `cohort-topic-parent-child-link` (parent-side child recording). The re-worded skip citations were
  verified accurate — the depth law has no observable multi-tier parent state to assert against until the
  parent records children. No new ticket filed; these are already tracked.

**Not found / empty categories:** no correctness defect in the shipped diff; no missing mutual-exclusion or
signing-coverage gap (both wire-tested); no security regression relative to the already-accepted bootstrap
model (follow-on is gated by the *identical* policy, by construction). The only defect surfaced was the
stale doc, fixed inline.

## Validation

- `packages/db-core`: `yarn test` → **1018 passing**. `yarn build` → clean (typecheck).
- `packages/db-p2p`: `yarn test` → **1079 passing, 36 pending** (the pending set includes the parked
  depth-law/demotion/handoff e2es cited above; the "parent unreachable" console line is an intentional
  negative-path `console.warn` from the cold-start catch, not a failure).
- No lint step exists in this repo (`root package.json` lint is a placeholder); `tsc` build is the type gate.

## End
