----
description: Reviewed the in-process reactivity mesh test harness and its five suites that exercise push-notification reactivity (commit fan-out, mobile resume, tail rotation, partition healing, slow subscribers) end-to-end without a real network.
files:
  - packages/db-p2p/src/testing/reactivity-mesh-harness.ts
  - packages/db-p2p/test/reactivity/mesh-cold-to-hot.spec.ts
  - packages/db-p2p/test/reactivity/mesh-mobile-resume.spec.ts
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts
  - packages/db-p2p/test/reactivity/mesh-partition-healing.spec.ts
  - packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts
  - packages/db-core/src/reactivity/rotation.ts
  - docs/reactivity.md
  - docs/architecture.md
  - tickets/plan/12.5-reactivity-tail-rotation-transport.md
----

# Reactivity e2e mock-transport tier — reviewed & completed

## Summary

The implement stage added a mock-transport e2e tier for reactivity: a harness
(`reactivity-mesh-harness.ts`, layered on the cohort-topic mesh harness, not forked) that drives the real
reactivity hot path end-to-end (real origination over a real `StorageRepo` + change-bridge, real forwarder
receive/dedupe/replay-ring, real subscription-manager verify/contiguity/backfill/resume, real
rotation/backpressure) over real-Ed25519 cohort hosts, plus five suites (23 new tests, 38 total in
`test/reactivity/`). Notification *transport* and the *single-tier-0 serving reach* are modeled, matching the
matchmaking sibling.

Review read the full implement diff with fresh eyes, traced every "real vs modeled" claim into the production
code, exercised the promotion seam empirically, and ran lint + the full mock tier. The work is sound and
honest about its limits. Three inline fixes were applied; one flagged production seam gap was confirmed and
found to be **already tracked** (no duplicate filed). No major findings warranted a new fix ticket.

## Validation

- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/reactivity/**/*.spec.ts"` from
  `packages/db-p2p` → **38 passing** (post-fix).
- Full mock tier `"test/**/*.spec.ts"` → **726 passing, 17 pending, 0 failing**. (The implement-stage
  pre-existing failure in `peer-reputation-review.spec.ts` was already fixed by the runner's triage pass,
  commit `217cb97`; `.pre-existing-error.md` is gone. The "parent unreachable" line in
  `host-antidos-coldstart.spec.ts` is a handled negative-test log, not a failure.)
- `yarn build` (tsc) clean in both `packages/db-p2p` and `packages/db-core`. Root `lint` is a no-op
  (`echo`); tsc is the type gate.

## Review findings

**What was checked:** the harness's real-vs-modeled boundary against the production code it claims to drive
(origination bridge, commit-cert reuse, forwarder receive, subscription manager, `serveResume`/`serveBackfill`,
rotation handoff, backpressure); every doc-scenario → test claim in the implementer's coverage table; each of
the seven self-declared gaps; crypto/verify seams; determinism; config-drift; resource lifecycle; and the
docs the change touched.

**1. Cold-to-hot "promotion machinery fires" test did not test promotion (FOUND — fixed inline).** The
`[mock-tier]` test was titled "the promotion machinery fires once subscribers cross cap_promote" but asserted
only `registration.tier === Tier.T3` (the *reactivity application tier*, constant for every subscribe — not a
tree-depth/promotion signal) plus delivery, and never crossed the cap (it registered exactly 4 with
`capPromote: 4`, and the "5th that crosses" in its own comment was never created). The claim was unsubstantiated
— the matchmaking sibling is honestly explicit (`it.skip([DOC EXPECTATION NOT YET IMPLEMENTED])`) where this
test dressed up admission+delivery as promotion. **Fix:** the cohort promotion decision *is* observable and
fires deterministically (verified empirically: register > `cap_promote` then one `onStabilized` → `isPromoted`
flips true, no wall-clock wait). Added `ReactivityMesh.stabilizeCohort()` + `ReactivityMesh.isPromoted()`
accessors and rewrote the test to register 6 subscribers (cap 4), assert the cohort was *not* promoted cold,
stabilize, assert it *promoted*, then assert delivery still reaches all 6. The multi-tier *serving* fan-out
remains genuinely gated and stays tagged `[unimplemented:mock-tier]`.

**2. Hard-coded `30_000` jitter window in `peakWindowArrivals` (FOUND — fixed inline).** The harness's
re-registration peak-window computation hard-coded `30_000` with a "cohort-topic default" comment, directly
contradicting the harness's own claim that production config is imported from `config.ts` with "no hard-coded
drifting numbers." It must equal the window `createRejoinJitter` actually spreads the wave over. **Fix:**
imported and used the exported `T_REJOIN_JITTER_MS` constant.

**3. `rotation.ts` docstring overclaimed an unwired seam (FOUND — fixed inline).** The production docstring
stated, present tense, that `PushState.inheritedCheckpoint` "is the seam the resume classifier reads to answer
a checkpoint-window resume whose span crosses the rotation." Confirmed by reading `resume.ts` that
`classifyResume`/`serveResume`/`ResumeServingDeps` consult **only** the rolling `checkpoint`, never
`inheritedCheckpoint` — so a cross-rotation resume currently falls to `out_of_window` (an extra chain read
where the design promises one RT). This is the implementer's honestly-flagged gap #3. **Disposition:** the
*production seam gap itself is already tracked** — `tickets/plan/12.5-reactivity-tail-rotation-transport.md`
carries it as the "Handoff ↔ resume coordination" follow-on — so **no duplicate ticket was filed**. The
docstring, however, lied about current behavior; fixed it inline to say the seam is *intended* to be consulted,
is not yet wired, and points at the tracking plan ticket.

**4. The remaining self-declared gaps (checked — acceptable, no action).**
- *Modeled notification transport + single-tier-0 reach* (#1/#2): consistent with the matchmaking sibling and
  explicitly owned by `substrate-e2e-real-libp2p-tier`. Correctly tagged, not faked.
- *Slow-subscriber backfill fire-and-forget* (#4): the test asserts the converged set `{1..20}` (no loss / no
  dup) after a settle, which faithfully reflects the manager's real `void`-dispatched `requestBackfill`; it
  does not over-assert a backfill count/order it cannot guarantee. Acceptable.
- *At-scale magnitudes are the simulator's* (#5): production `W`/`W_checkpoint`/burst are imported from
  `config.ts`; suites scale down and assert classifier/boundary behavior. Correct division of labor.
- *Cohort crash-failover* (#6) and *Edge-in-cohort exclusion* (#7): cohort-topic-layer mechanisms; reactivity
  asserts its own policy/no-loss-on-heal. Correctly scoped.

**Crypto / verify seam (checked — correct, modeling honest).** Notification signatures are real Ed25519
threshold commit-certs reused unchanged, verified by real collected-multisig against the tail cohort's member
set — the forged-sig and untrusted-signer tests genuinely fail real verification (no pass-crypto stub). The
cached `MembershipCertV1` itself carries a placeholder `thresholdSig` (the cohort-topic layer, not reactivity,
owns cert-threshold verification), matching `reactivity-real-crypto.spec.ts`. The "real Ed25519" claim is
accurate when scoped to notification verification, which is what the suites assert.

**Determinism (checked — clean).** No `Date.now()`/`Math.random()`: virtual clock + a seeded LCG for jitter.
The new promotion assertion is deterministic (`onStabilized` → `isPromoted`), preserving the suite's
no-wall-clock-sleep guarantee.

**Docs (checked — accurate).** `docs/architecture.md` (reactivity Mock-tier → done), `docs/reactivity.md`
(new coverage section + claim-map table), and the `optimystic-network-reactive-watch-integration-test`
supersession note were all read and reflect the new reality; the residual real-libp2p `Database.watch` wakeup
is correctly left to the real-libp2p tier. The strengthened promotion test still matches its coverage-table
row (which keeps the multi-tier serving fan-out tagged unimplemented).

**Test coverage beyond happy path (checked — adequate):** forged sig, untrusted signer, duplicate dedupe
(subscriber + forwarder sliding window), late-subscriber baseline, all four resume boundaries
(backfill/checkpoint/out-of-window/tail-rotated), rotation continuity across the handoff boundary, drain-gate
serve/bounce/drained transitions, partition heal-via-backfill, and slow-subscriber drop-without-stall are all
exercised. Gaps that remain are the correctly-tagged unimplemented (multi-tier serving) and externally-owned
(real-libp2p transport, cohort crash-failover) ones.

## Follow-ups (already tracked — not filed here)

- Wire the resume classifier to consult `PushState.inheritedCheckpoint` for cross-rotation
  checkpoint-window resumes — `tickets/plan/12.5-reactivity-tail-rotation-transport.md` ("Handoff ↔ resume
  coordination").
- Real-libp2p socket fan-out + Quereus `Database.watch` wakeup — `substrate-e2e-real-libp2p-tier` (and the
  retained `backlog/optimystic-network-reactive-watch-integration-test` residual).
