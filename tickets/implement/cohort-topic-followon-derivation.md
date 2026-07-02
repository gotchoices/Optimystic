description: Let a participant that was redirected to a not-yet-created deeper cohort actually get that cohort started, instead of bouncing back and forth until it gives up — by adding a signed "I was redirected here" flag to the join request and making that path pay the same anti-abuse cost a fresh topic already pays.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1 — add followOn)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload — append followOn)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRegisterV1 — followOn mutual-exclusion + treeTier≥1)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (gate fires on followOn, not just bootstrap)
  - packages/db-core/src/cohort-topic/walk.ts (register-side "followed a Promoted redirect" re-issue)
  - packages/db-core/src/cohort-topic/service.ts (messageFactory — mint evidence on followOn re-issue)
  - packages/db-core/src/cohort-topic/member-engine.ts (RegisterContext.followOn already present; sourcing note)
  - packages/db-p2p/src/cohort-topic/host.ts (dispatchRegister — derive ctx.followOn from reg.followOn)
  - docs/cohort-topic.md (§Cold-start instantiation, §Lookup, §Anti-DoS, §Wire formats)
  - packages/db-core/test/cohort-topic/walk.spec.ts, coldstart.spec.ts, member-engine.spec.ts
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts, cohort-topic-scale-antiflood.spec.ts (partial un-skip)
difficulty: hard
----

# Cohort-topic: derive `followOn` for cold-tier admission (resolved design)

## Plain-language summary

A topic's cohort tree grows outward under load. When a cohort fills up it "promotes" and starts
telling new joiners "go one tier deeper" (a `Promoted(d+1)` redirect). But the deeper cohort may not
exist yet. Today the joiner walks out to that cold deeper cohort, gets "I'm not serving this"
(`NoState`), walks back inward, hits the promoted cohort again, gets redirected again — an oscillation
that only stops when a safety counter (`maxSteps`) trips and the joiner backs off. **So a join that
lands on a freshly-promoted-but-not-yet-grown branch never actually succeeds; it only retries.**

The fix: the joiner tells the deeper cohort "I'm here because your parent redirected me" so the cold
cohort knows to instantiate itself. That signal is called `followOn`. This ticket decides *how* it is
carried and *how it is kept honest*, and implements it.

## The decision (why this shape, and the tradeoffs)

The admission gate in db-core is
`shouldInstantiate({ bootstrap, followOn, quorumWilling }) = (bootstrap ∨ followOn) ∧ quorumWilling`
(`coldstart.ts`). `bootstrap` is a real wire field; `followOn` is currently a host-supplied boolean
hardcoded to `false` (`host.ts` `dispatchRegister`), which is why the deep-tier join never converges.

Three candidate mechanisms were weighed (per the plan ticket):

1. **Wire flag on `RegisterV1`** — the participant sets `followOn: true` after a `Promoted` reply.
2. **Host-side routing inference** — the receiving cohort infers follow-on from local routing state.
3. **Parent voucher** — the promoting parent threshold-signs a redirect token the participant presents.

**Option 2 is not buildable and is eliminated.** The cohort that receives the follow-on register is the
tier-`(d+1)` **child** — a *different* cohort at an *uncorrelated* ring coord from the tier-`d` parent
that promoted (the addressing hash deliberately decorrelates tiers, `addressing.ts` §Tier addressing).
FRET delivers the register to the child with only the routing key `coord_{d+1}(self, topicId)` and **no
breadcrumb of where the participant came from**. A speculative `d_max` probe and a genuine redirect
follow-on are byte-for-byte identical frames at the child; the only thing that distinguishes them is
history the child never sees. The parent holds the promotion state, not the child — so local inference
would require the child to synchronously dial the parent, which the anti-DoS rule forbids ("an admission
gate never dials", §Anti-DoS). The information genuinely lives **only at the participant**.

**Therefore `followOn` must be participant-asserted — a wire flag (Option 1's mechanism).** Because a
wire flag is participant-forgeable, its safety cannot come from its provenance; it must come from a
separate gate. **The chosen resolution: a follow-on cold-start is gated by the *same*
`bootstrapEvidence` policy a cold-root `bootstrap` cold-start already passes** (`bootstrap-evidence.ts`;
§Anti-DoS). At T2/T3 that means the participant mints a proof-of-work bound to
`(topicId, tier, participantCoord, timestamp)` — the *identical* bound image bootstrap already uses, so
no new binding — and the cold child verifies it before instantiating. At T0/T1 it inherits the same
permissive-but-logged posture bootstrap has until the committed-parent backing lands (unchanged, no new
hole). **This makes a follow-on cold-start exactly as costly and exactly as gated as a root bootstrap —
no new weakness relative to the security model already accepted, and no extra reply field or parent
membership fetch in the admission path.**

**Option 3 (parent threshold-signed voucher) is strictly stronger against spoofing but not required for
a correct, non-regressing fix, and is heavier** (a new `RegisterReplyV1` field to carry the parent's
signed notice + parent-cohort `MembershipCertV1` verification on the child's admission path, i.e. a
potential dial). It is recorded as a **future hardening tripwire**, not built now (see TODO). The natural
voucher already exists — the parent cohort's threshold-signed `PromotionNoticeV1` — so the upgrade path
is clean if PoW-gated follow-on ever proves to be a real abuse vector.

**Does `RegisterV1` need a new wire field? Yes — `followOn?: boolean`. Does `RegisterReplyV1`? No** (the
participant self-mints the evidence; it needs nothing from the parent). This is the answer to the plan
ticket's explicit sub-question.

## How the honest walk produces `followOn` (mirror of the root-bootstrap re-issue)

The key to keeping the **common hot-regime path free** (no wasted PoW) is to set `followOn` **only on a
dedicated re-issue after a cold miss**, exactly the way `bootstrap: true` is set only on the re-issue
after the root answers `NoState` (`walk.ts`, the `d < 0 → d = 0, bootstrap = true` branch).

Current register walk (`walk.ts` `register`) on `promoted(targetTier)`: `d = targetTier`, re-register.
If that child answers `no_state`, it steps inward (`d - 1`) → back to the promoted parent → oscillates.

New behavior (register path only; the `probe` path keeps its existing back-off, `walk.ts:186-191`):

```
on promoted(targetTier):
    d = targetTier
    followedPromoted = true          // register-side sibling of the existing probeFollowedPromoted
    (re-register at the child)

on no_state:
    if followedPromoted and not followOnReissued:
        // The redirect target is cold. Instead of stepping inward (which oscillates),
        // re-issue ONCE at the SAME child tier as a follow-on: RegisterV1{ followOn: true } +
        // minted evidence. Mirror of the root NoState → bootstrap:true re-issue.
        followOn = true
        followOnReissued = true
        (re-register at the child, same d)
        continue
    if followedPromoted and followOnReissued:
        // The follow-on re-issue still got no_state → the child's quorum is unwilling to
        // instantiate. Back off in time (retry_later); do NOT loop inward.
        return retry_later(backoffRetryMs(0))
    ... existing inward-step / root-bootstrap logic ...
```

`service.ts` `messageFactory` mints the evidence on `params.followOn` exactly as it does on
`params.bootstrap` (same `buildBootstrapEvidence` call, same bound tuple) and stamps `body.followOn =
true`. `RegisterMessageFactory.build` gains a `followOn: boolean` param alongside `bootstrap`/`probe`.

Cohort side needs **no logic change** beyond sourcing: `member-engine.ts` already takes
`ctx.followOn` into `shouldInstantiate`, and `runGuards` already calls `bootstrapEvidence.verify(reg,
tier)` in step 1. The only db-core edits are (a) `bootstrap-evidence.ts` `verify` firing on
`reg.followOn === true` as well as `reg.bootstrap === true`, and (b) the wire/payload/validate plumbing.
The host edit is one line: `dispatchRegister` passes `followOn: reg.followOn === true` (drop the
hardcoded `false`, `host.ts:907`) — `parentCoord` is already computed there (`host.ts:906`).

## Data flow (end to end)

```
participant walk            wire (RegisterV1)                 cold tier-(d+1) child cohort
─────────────────           ─────────────────                 ────────────────────────────
follow Promoted(d+1) ─────► treeTier=d+1, followOn absent ───► serves? no. shouldInstantiate?
                                                                bootstrap∨followOn = false → no_state
no_state + followedPromoted
  → re-issue once:
  mint evidence (PoW T2/3)  treeTier=d+1, followOn=true,   ──► runGuards: bootstrapEvidence.verify
  followOn=true             bootstrapEvidence=<envelope>,       (fires on followOn) → ok
                            signature covers followOn           shouldInstantiate: followOn ∧ quorum → yes
                                                                topicBudget.admit → instantiate forwarder
                                                                (awaiting_parent; registers with tier-d
                                                                 parent via existing registerForwarderWithParent)
                            ◄─── accepted (primary/backups/epoch + traffic)
```

## Edge cases & interactions

- **Mutual exclusivity.** `followOn`, `bootstrap`, and `probe` are pairwise mutually exclusive. The walk
  sets at most one: `bootstrap` only at the tier-0 root re-issue, `followOn` only at a `treeTier ≥ 1`
  redirect target, `probe` never instantiates so never sets `followOn`. `validateRegisterV1` must reject
  a frame that sets more than one, and reject `followOn: true` with `treeTier < 1` (a follow-on is by
  definition a deeper-than-root growth point). Tests: a hand-crafted `{bootstrap:true, followOn:true}`
  and a `{followOn:true, treeTier:0}` frame are rejected by the codec/validator.
- **Signature coverage.** `followOn` must be **appended** to `registerSigningPayload`
  (`body.followOn ?? false`, strictly appended like `probe`/`withdraw` were) so a MITM cannot strip or
  flip it and signer/verifier agree byte-for-byte. Safe to append: no register signatures are persisted
  (recomputed per verify), so there is no cross-version image concern (same discipline documented for
  `probe`). Verify the existing `peer-key-signing.spec.ts` still passes and add a case that a flipped
  `followOn` breaks the signature.
- **Evidence gate fires on the flag, regardless of hot/cold.** `bootstrapEvidence.verify` runs in
  `runGuards` (step 1) **before** the hot/cold branch, so a `followOn: true` register that lands on an
  *already-hot* child would be evidence-gated too. This is fine: the honest walk sets `followOn: true`
  only on the re-issue after a *cold* `no_state`, so a hot child never receives `followOn: true` in the
  honest flow (it admitted the plain first register). An attacker sending `followOn: true` + no evidence
  to a hot child just earns itself an `unwilling_cohort`. Do **not** try to scope the evidence check to
  "only on actual instantiation" — gate on the flag; the honest-flow invariant is what keeps it correct.
- **Oscillation is bounded, then backs off — update the existing test.** The follow-on re-issue happens
  **once** (`followOnReissued` guard). `walk.spec.ts` "single tier-0 cohort, promoted but childless: …
  terminates within maxSteps (followOn instantiation out of scope)" changes semantics: a *willing* cold
  child now resolves to `accepted` via the followOn path; a child whose quorum is *unwilling* terminates
  with `retry_later` via followOn-then-backoff (not pure oscillation). The `maxSteps` safety valve stays
  as a backstop against a malformed tree but is no longer the primary terminator for this path. Add a
  positive test: promoted parent + willing cold child → walk resolves `accepted` (child instantiated),
  asserting exactly one follow-on re-issue and no inward oscillation.
- **Evidence-reject vs quorum-unwilling on the re-issue.** `followOn:true` + bad/absent evidence →
  `bootstrapEvidence.verify` false → `unwilling_cohort` (temporal back-off, walk returns `retry_later`).
  `followOn:true` + good evidence + quorum **not** willing → `shouldInstantiate` false → `no_state` →
  walk backs off (per the new branch). Both terminate; neither loops. Cover both.
- **Concurrent burst / idempotency.** Several participants following the same redirect to the same cold
  child: the first follow-on instantiates (`coldStart.instantiate` is idempotent per topic,
  `coldstart.ts`); the rest hit the now-hot child and are admitted normally (their own follow-on
  re-issue never fires because the child answers `accepted`/`promoted`, not `no_state`). Per-peer rate
  limit (4/min/peer/topic) and topic budget (2048/cohort, LRU) bound abuse volume — unchanged.
- **Partial failure of parent registration.** A followOn-instantiated tier-`d>0` forwarder registers
  with its tier-`(d−1)` parent via the existing `registerForwarderWithParent` transport; a failed parent
  registration leaves it `awaiting_parent` (accepts participants, holds parent-involving ops) — existing
  behavior, unchanged. The followOn admission still returns `accepted`. **Note the real parent-side
  *recording* of the child (`childCohortCount`, signed child-link frame) is out of scope here — it is the
  `cohort-topic-parent-child-link` follow-on (which has this ticket as its `prereq`).**
- **Probe path untouched.** `probe: true` never sets `followOn`; the probe's cold-child-after-Promoted
  case keeps its immediate back-off (`walk.ts:186-191`). Assert a probe following a redirect to a cold
  child still backs off (does not instantiate).
- **`d_max` independence.** A participant with large `d_max` that starts high, walks inward, hits a
  promoted cohort at `d < d_max`, and is redirected to `d+1 ≤ d_max` still triggers the follow-on
  re-issue on a cold child — the logic keys off `followedPromoted`, not off `treeTier` vs `d_max`.
- **Cross-package wire agreement.** `followOn` must round-trip through the db-core codec
  (`wire/codec.ts` / `wire/validate.ts`) and be readable on the db-p2p host side (`validateRegisterV1`
  in `host.ts` already decodes `RegisterV1`; confirm the new field survives decode). No db-p2p codec
  edits expected beyond that.

## Scope boundary (keep this one agent run)

**In scope:** the wire field + signing/validation + evidence-gate extension + the participant walk
re-issue + host derivation + db-core unit specs + partial un-skip of the two db-p2p scale specs *to the
extent they exercise cold-child instantiation via followOn*.

**Out of scope (stays parked):** the multi-tier e2e assertions that require a **real parent cohort
recording the child** (`childCohortCount`, the signed child-link frame) — those belong to
`cohort-topic-parent-child-link` (prereq = this ticket) and their `it.skip` markers should be **narrowed
or re-worded**, not necessarily fully removed, if the parent-recording half is still absent. If a scale
spec's skipped assertion cannot pass without real child recording, leave it skipped and update its
citation to point at `cohort-topic-parent-child-link` rather than this ticket. Do **not** grow this
ticket into the parent-recording work.

## TODO

Phase 1 — wire + cohort-side gate (db-core)
- [ ] Add `followOn?: boolean` to `RegisterV1` (`wire/types.ts`) with a doc comment mirroring `bootstrap`:
      set on the dedicated re-issue after a `Promoted` redirect target answers `NoState`; `treeTier ≥ 1`;
      mutually exclusive with `bootstrap` and `probe`.
- [ ] Append `body.followOn ?? false` to `registerSigningPayload` (`wire/payloads.ts`) and document the
      append (sibling to the `probe`/`withdraw` notes).
- [ ] `validateRegisterV1` (`wire/validate.ts`): reject >1 of {bootstrap, followOn, probe}; reject
      `followOn && treeTier < 1`.
- [ ] `bootstrap-evidence.ts` `verify`: require evidence when `reg.followOn === true` as well as
      `reg.bootstrap === true` (same tier policy). Update the module doc ("A follow-on cold-start is
      gated identically to a root bootstrap").
- [ ] `member-engine.ts`: no logic change; update the `RegisterContext.followOn` / step-1 comments to
      note it is now wire-sourced and evidence-gated.

Phase 2 — participant walk + host (db-core + db-p2p)
- [ ] `walk.ts`: add register-side `followedPromoted` + `followOnReissued` tracking; on `no_state` after
      a Promoted redirect, re-issue once with `followOn: true`, then back off; leave the probe branch
      as-is. Thread a `followOn` param through `RegisterMessageFactory.build`.
- [ ] `service.ts` `messageFactory`: stamp `body.followOn = true` and mint evidence on `params.followOn`
      (reuse the `buildBootstrapEvidence` call + bound tuple; mutually exclusive with probe/bootstrap).
- [ ] `host.ts` `dispatchRegister`: `followOn: reg.followOn === true` (drop the hardcoded `false`).

Phase 3 — docs + tests
- [ ] `docs/cohort-topic.md`: update §Cold-start instantiation (followOn is now a signed wire flag,
      evidence-gated like bootstrap), §Lookup (the register re-issue on cold-child NoState, vs the probe
      back-off), §Anti-DoS (follow-on cold-start = bootstrap cold-start, evidence-wise), §Wire formats
      (`RegisterV1.followOn`). Remove/annotate the "followOn is not on the wire / parked" notes.
- [ ] db-core specs: `coldstart.spec.ts` (unchanged gate truth-table still holds), `member-engine.spec.ts`
      (a `followOn:true` cold register with valid evidence instantiates; with bad evidence →
      `unwilling_cohort`; on a hot child → normal admit path), `walk.spec.ts` (positive resolve via
      followOn; the childless-unwilling case terminates via followOn-then-backoff; exactly one re-issue;
      probe still backs off).
- [ ] db-p2p scale specs: narrow/re-word the `cohort-topic-scale-lifecycle.spec.ts` and
      `cohort-topic-scale-antiflood.spec.ts` skips per the scope boundary above — enable the
      cold-child-instantiates-via-followOn assertion; keep the real-parent-recording assertions parked
      under `cohort-topic-parent-child-link`.
- [ ] Build + typecheck + run the touched db-core and db-p2p cohort-topic suites; stream output with
      `2>&1 | tee` (never silent redirect).

Phase 4 — record the deferred hardening (do NOT file a ticket)
- [ ] Add a `NOTE:` tripwire at the `bootstrap-evidence.ts` followOn branch (or the walk re-issue site):
      *follow-on cold-start is PoW-gated, same as a root bootstrap; if spoofed PoW-paid follow-on
      instantiation ever shows up as real abuse, upgrade to a parent-vouched redirect — echo the parent
      cohort's threshold-signed `PromotionNoticeV1` on the follow-on and verify it against the parent's
      `MembershipCertV1` (needs a `RegisterReplyV1` field + admission-path membership verify).* Mention it
      in the review handoff's findings index.
