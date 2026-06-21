description: A real node could no longer create a brand-new low-tier topic because a new anti-DoS check demanded proof a fresh root topic cannot produce; the check now stands aside at the low tiers until its real backing exists.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy + its call site — the fix)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (new lock-in unit test)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (claim-4 denial mechanism updated)
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (gated — T3 self-vouch added; T0 left evidence-less; NOT run here)
  - packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts (the real T0/T1 verifier — read-only reference)
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts (PoW/reputation verifiers — read-only reference)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (tiered policy — read-only reference)
difficulty: medium
----

# Review: cold-start origination regression fix — T0/T1 bootstrap permissive until a committed parent backing exists

## What was wrong

A production node (`libp2p-node-base.ts` L795) wires `antiDos: { reputation }` into every cohort-topic
host. Supplying any reputation view flips `createBootstrapEvidencePolicy` from *permissive-but-logged* to
*configured*, so every unfilled verifier fails **closed**. After the `cohort-topic-bootstrap-parent-reference`
ticket landed, the only accepted evidence at T0/T1 is `verifyParentReference`, which a brand-new root topic
**cannot satisfy**: a root has no parent to reference, the participant-side builder mints no parentRef, and
the host-default existence view fails T0/T1 closed (no committed-by-coord index is wired). Net effect: a real
node could no longer originate a brand-new tier-0/tier-1 topic via the `bootstrap: true` cold-start path.

## What was changed (the fix)

A `hasCommittedParentBacking: boolean` is threaded into `createBootstrapEvidencePolicy`
(`packages/db-p2p/src/cohort-topic/host.ts`). It is `true` iff this host actually has a committed-existence
backing to gate against — i.e. an explicit `antiDos.parentTopicView` override **or** a wired
`committedParentTopicReader`. The parent-reference verifier is wrapped so that:

- **T0/T1 (`reg.tier <= maxNoPowTier`) with NO committed backing** → **permissive-but-logged** (the
  documented interim posture; a brand-new root cannot mint any acceptable parent-ref).
- **T2/T3 always, and T0/T1 once a committed backing IS wired** (the test seam, or a future production
  index) → the **real** `createParentReferenceVerifier`.

`configured` semantics are unchanged: a reputation view / `bootstrapEvidence` override still makes the gate
configured, and `verifyPoW` / `verifyReputation` still fail closed when unfilled, so the T2/T3
`PoW || reputation || parent-ref` disjunction cannot be slipped by a banned referee. The fix is **scoped to
T0/T1**; T2/T3 gating is untouched.

`libp2p-node-base.ts` is **unchanged** (the node still wires `antiDos: { reputation }` and leaves
`committedParentTopicReader` unwired) — the fix lives entirely in the host policy. The `endorse` self-vouch
seam stays unwired (it is dead weight for this path; wiring it was the original ticket's rejected Option 1).

## Use cases to validate (what the reviewer should check)

1. **The regression itself.** A host configured with `{ reputation }` and **no** `parentTopicView` admits a
   T0 `bootstrap: true` register carrying **no evidence**. (New unit test:
   `host-antidos-coldstart.spec.ts` → *"cold-start origination: a configured host with no committed backing
   admits a T0 bootstrap with no evidence but still denies a T2 one"*.)
2. **The fix is scoped to T0/T1.** The same configured host still **denies** a T2 `bootstrap: true` with no
   evidence (PoW/reputation/parent-ref all fail closed). (Same test, second assertion.)
3. **Real T0 gating is preserved when a backing IS supplied.** A configured host given an explicit
   `antiDos.parentTopicView` runs the real T0 verifier — admits a known parent, denies an unknown parent /
   bad-sig. (Pre-existing tests at `host-antidos-coldstart.spec.ts` L214-255, still green.)
4. **T2/T3 parent-ref still works** (the third disjunction option). (Pre-existing tests, still green.)

## Validation performed (this is a floor, not a ceiling)

- `yarn build:db-p2p` (tsc, which type-checks both `src` and `test`) → **exit 0**.
- `host-antidos-coldstart.spec.ts`, `bootstrap-evidence-verifiers.spec.ts`,
  `bootstrap-parent-reference.spec.ts` → **42 passing**.
- Full `test/cohort-topic/**/*.spec.ts` (the shared host policy is broad) → **146 passing, 5 pending, 0
  failing**.
- `cohort-topic-scale-antiflood.spec.ts` → **8 passing, 2 pending** (after the claim-4 fix below).

## Known gaps / things to scrutinize

- **An additional file beyond the ticket's plan was touched.**
  `cohort-topic-scale-antiflood.spec.ts` §Anti-flood claim 4 forced an `UnwillingCohort` by configuring a
  banning reputation view and registering a **T0** bootstrap — which this fix now makes *permissive*, so
  the test would have flipped to "admitted" and failed. It was updated to additionally supply an empty
  `parentTopicView` (`{ exists: () => false }`), giving the configured host a committed backing so the real
  T0 verifier runs and the evidence-less bootstrap still fails closed → the denial (and the walk's
  restart-at-d_max behavior it actually tests) is preserved. **Reviewer: confirm this faithfully preserves
  the claim-4 intent and is not masking a behavior change** — the denial mechanism shifted from
  "reputation ban" to "empty committed-backing parent-ref fail-closed" (functionally equivalent for a
  no-evidence register, since T0 consults only `verifyParentReference`).

- **The integration spec is GATED and was NOT run here** (`OPTIMYSTIC_INTEGRATION=1`, exceeds the agent
  2-min window). Edits were made and **type-check cleanly**, but their runtime behavior is unverified:
  - L454 T0 register: left evidence-less; relies on the new permissive T0 path (production has no committed
    backing). A comment was added.
  - L521-535 T3 register: a **self-vouch reputation endorsement** was attached (the registrant peer-key-signs
    its own `bootstrapBoundImage` as referee). This **assumes the origin's reputation view scores
    `remote.member` as an unseen, non-banned peer (score 0 < deprioritize threshold)**. If the integration
    mesh has recorded reputation for that peer by this point in the test, the endorsement could be rejected
    and the assertion would need adjustment. **Validate this in CI / out-of-band.**

- **Conceptual anti-DoS opening (by design, tracked elsewhere).** With this fix, a real configured production
  node currently admits **any** evidence-less T0/T1 cold-root `bootstrap: true` (permissive-but-logged, one
  warning). This is the deliberate interim posture — the alternative is total inability to originate root
  topics — and it closes when the committed-by-coord backing lands (follow-on
  `cohort-topic-parent-ref-tx-log-content`, which would let node-base wire `committedParentTopicReader`,
  flipping `hasCommittedParentBacking` to true and re-enabling the real T0/T1 gate with no further host
  change). Reviewer should confirm this tradeoff is acceptable for the milestone and that the follow-on
  ticket adequately tracks closing it.

- **Minor doc imprecision left as-is (out of scope).** The class-level header comment in `host.ts` (~L38-41)
  says a configured node gates cold-root bootstrap with "real PoW always", which reads as all-tiers but is a
  T2/T3 statement (T0/T1 never uses PoW). Pre-existing; not corrected. The `createBootstrapEvidencePolicy`
  doc comment and the `antiDos.reputation` field doc **were** updated to describe the T0/T1 permissive path
  accurately.

## Out of scope / explicitly NOT done (per the ticket's research)

- Did **not** wire the `endorse` self-vouch seam (original Option 1 — proven not to fix this path, since
  T0/T1 never consults `verifyReputation`).
- Did **not** revert the node-base `antiDos: { reputation }` wiring (original Option 3 — would also drop the
  working T2/T3 gate).
- Did **not** touch `db-core` (the tiered policy is consumed read-only).
