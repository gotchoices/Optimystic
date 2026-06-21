description: A real node could no longer create a brand-new low-tier topic because a new anti-DoS check demanded proof a fresh root topic cannot produce; the check now stands aside at the low tiers until its real backing exists. Reviewed, validated, and shipped.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy + hasCommittedParentBacking — the fix)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (lock-in unit test)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (claim-4 denial mechanism updated)
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (T3 self-vouch; T2 matchmaking self-vouch added in review; T0 left evidence-less)
  - docs/cohort-topic.md (§Anti-DoS — doc reconciled with the T0/T1 permissive posture in review)
  - tickets/backlog/cohort-topic-parent-ref-tx-log-content.md (follow-on; cross-ref strengthened in review)
difficulty: medium
----

# Complete: cold-start origination regression fix — T0/T1 bootstrap permissive until a committed parent backing exists

## What was wrong

After `cohort-topic-bootstrap-parent-reference` landed, the only accepted bootstrap evidence at T0/T1 became
a real signed `verifyParentReference`. A production node (`libp2p-node-base.ts`) wires `antiDos: { reputation }`,
which makes the gate *configured* → every unfilled verifier fails **closed**. But a brand-new root topic
**cannot** mint any acceptable parent-ref (a root has no parent; the participant builder mints none; the
host-default existence view fails T0/T1 closed with no committed-by-coord index wired). Net effect: a real
node could no longer originate a brand-new tier-0/tier-1 topic via the `bootstrap: true` cold-start path.

## What was implemented (the fix under review)

`createBootstrapEvidencePolicy` (`packages/db-p2p/src/cohort-topic/host.ts`) now receives
`hasCommittedParentBacking: boolean` — true iff this host has a committed-existence backing to gate against
(an explicit `antiDos.parentTopicView` override **or** a wired `committedParentTopicReader`). The
parent-reference verifier is wrapped:

- **T0/T1 (`reg.tier <= maxNoPowTier`) with NO committed backing** → permissive-but-logged.
- **T2/T3 always, and T0/T1 once a committed backing IS wired** → the real `createParentReferenceVerifier`.

`configured` semantics, and T2/T3 `PoW || reputation || parent-ref` gating, are unchanged. `node-base` is
untouched; the fix lives entirely in the host policy.

## Review findings

Adversarial pass over commit `cbd73a3`. Read the full implement diff (host.ts, three test files) with fresh
eyes, then verified the policy logic against db-core's `TieredBootstrapEvidence`, ran the build, the
cohort-topic unit suite, and — going beyond the implementer — the **gated integration suite**.

### Verified correct (no change needed)

- **Tier-dispatch consistency.** The host gate branches on `reg.tier <= maxNoPowTier`; db-core's
  `verify(reg, tier)` branches on `tier = reg.tier as Tier` (member-engine.ts:142) with the *same*
  `maxNoPowTier` resolution (`overrides?.config?.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER`, mirrored on both
  sides, and `config` is forwarded). The two never diverge — the host gate exactly matches the tiers at which
  db-core consults `verifyParentReference` exclusively (T0/T1). Confirmed db-core only consults the verifier
  for `reg.bootstrap === true`.
- **`hasCommittedParentBacking` is correct.** It is the disjunction of the only two backing sources
  (`antiDos.parentTopicView` override or `committedParentTopicReader`); single call site (host.ts:603), build
  type-checks, no stragglers.
- **T2/T3 gating intact.** Unit test confirms a configured host still denies an evidence-less T2 bootstrap;
  the banned-referee-cannot-slip-the-disjunction tests remain green. An explicit
  `overrides.verifyParentReference` still wins (gate bypassed), an explicit `parentTopicView` still runs the
  real T0 verifier (admit-known / deny-unknown / deny-bad-sig).
- **Lock-in test is meaningful.** Without the fix, the new T0 assertion would fail closed → it genuinely
  guards the regression.

### Findings fixed inline (minor)

1. **Integration regression the implementer missed (`substrate-real-libp2p.integration.spec.ts`,
   matchmaking T2).** Running the **gated** integration suite (`OPTIMYSTIC_INTEGRATION=1`) surfaced
   `1 failing`: *"a matchmaking provider registration lands in the real cohort…"* — a T2 `bootstrap` register
   with no evidence got `unwilling_cohort` (expected `accepted`). Root cause: the **parent-reference** ticket
   made T2/T3 fail-closed; this register was never updated. It is *pre-existing* (the implement commit's
   host.ts change is T0/T1-only and never touched this test, so the outcome predates `cbd73a3`) but lives
   inside this ticket's edited file and is the identical root cause + fix-pattern the implementer already
   applied at L536. The implementer missed it only because they explicitly did **not** run the gated suite.
   **Fixed inline:** added a reusable `selfVouch?` option to the local `signedRegister` helper (the L536
   manual code is itself a self-vouch — DRY) and used it for the matchmaking register. Full integration suite
   now **9 passing, 3 pending, 0 failing**.
2. **Canonical doc contradicted the new behavior (`docs/cohort-topic.md` §Anti-DoS).** The doc still said
   T0/T1 parent-ref "fails closed without [a committed reader]" and that permissive-but-logged is "reserved
   for an *entirely unconfigured* host" — both now false for a configured production node, which is permissive
   at T0/T1. The implementer updated only the in-code comments. **Fixed inline:** the T0/T1 bullet and the
   closing paragraph now describe the configured-but-no-backing T0/T1 permissive posture and cite the ticket.
3. **Class-header comment in `host.ts` (~L39).** Said a configured node "genuinely gates cold-root
   `bootstrap: true` (real PoW always)" — misleading (PoW is T2/T3-only) and now wrong for T0/T1 on a
   production node. **Fixed inline** to state the per-tier reality.
4. **Deferred anti-DoS opening not fully tracked.** The fix admits **any** evidence-less T0/T1 cold-root
   bootstrap on a configured production node (deliberate interim posture). The follow-on backlog ticket
   `cohort-topic-parent-ref-tx-log-content` tracked the committed-read API but did not call out that landing
   it must also re-wire `committedParentTopicReader` in `node-base` to re-close the gate. **Fixed inline:**
   added a "## Also re-closes the T0/T1 cold-start anti-DoS opening" section to that backlog ticket.

### Findings noted, not changed (minor, with reason)

- **Shared permissive log message.** The one-shot warning text says "no PoW/reputation view wired", which is
  inaccurate for the new configured-but-no-backing T0/T1 path (a reputation view *is* wired there). Left as-is:
  the descriptive `kind` string (`"parent-reference (T0/T1, no committed backing)"`) already disambiguates the
  log line, and rewording the shared message risks degrading the unconfigured-case wording. Cosmetic only.
- **`reg.tier` trust.** The whole policy (this ticket and its predecessors) trusts attacker-supplied
  `reg.tier`; a tier-spoof to reach the permissive path only yields the same T0/T1-open treatment already
  granted to legitimate originators, so it opens no *additional* hole. Pre-existing design, out of scope.

### Findings filed as new tickets (major)

- **None.** No defect required a new fix/plan ticket; the deferred anti-DoS opening is design-intended and now
  fully tracked by the existing `cohort-topic-parent-ref-tx-log-content` backlog ticket.

### Validation run (all green)

- `yarn build:db-p2p` (tsc, type-checks `src` + `test`) → **clean (exit 0)**, run twice (after doc edits and
  after the integration-test fix).
- `test/cohort-topic/**/*.spec.ts` → **146 passing, 5 pending, 0 failing**.
- `OPTIMYSTIC_INTEGRATION=1` full integration suite → **9 passing, 3 pending, 0 failing** (was 1 failing before
  the inline fix). Each integration test ran in ~600ms — the implementer's "exceeds the 2-min window"
  assumption was over-cautious; the two implement-stage integration edits (T0 evidence-less permissive path,
  T3 self-vouch) are now **runtime-verified**, not merely type-checked.
- **Lint:** the repo's root `lint` script is a no-op (`echo 'Lint not configured for all packages'`); db-p2p
  has no linter to run. Type safety is covered by the strict `tsc` build above.

## Out of scope / explicitly NOT done (unchanged from implement)

- Did **not** wire the `endorse` self-vouch seam in the host (original Option 1 — T0/T1 never consults
  `verifyReputation`).
- Did **not** revert the node-base `antiDos: { reputation }` wiring (original Option 3 — would drop the
  working T2/T3 gate).
- Did **not** touch `db-core` (the tiered policy is consumed read-only).
