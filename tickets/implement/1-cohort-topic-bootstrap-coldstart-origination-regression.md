description: A real node can no longer create a brand-new low-tier topic because the new anti-DoS check demands proof a fresh root topic cannot possibly produce; make that check stand aside at the low tiers until the real backing for it exists.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy ~L835; its call site ~L592; the buildBootstrapEvidence wiring ~L670)
  - packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts (createParentReferenceVerifier / createDefaultParentTopicView — the real T0/T1 gate that now fails closed)
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts (createReputationVerifier — only consulted at T2/T3)
  - packages/db-p2p/src/libp2p-node-base.ts (~L795 antiDos: { reputation } — keep as-is; do NOT revert)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (host-policy unit tests — add the new lock-in test here)
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (L454-455 T0 register; L521-535 T3 register — OPTIMYSTIC_INTEGRATION-gated)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (the tiered policy — T0/T1 consults verifyParentReference ONLY; read-only reference)
difficulty: medium
----

# Fix cold-start origination regression — keep T0/T1 bootstrap permissive until a committed parent backing exists

## TL;DR of the research

A production node (`libp2p-node-base.ts` L795) wires `antiDos: { reputation }` into every cohort-topic
host. Supplying any reputation view flips `createBootstrapEvidencePolicy` from *permissive-but-logged* to
*configured*, so every unfilled verifier fails **closed**. The net effect is that a real node can no longer
originate a brand-new **tier-0 / tier-1** topic via the `bootstrap: true` cold-start path.

**The original fix ticket's recommended fix (Option 1: "wire the `endorse` self-vouch seam") does NOT
work, and must not be implemented.** That recommendation predates the `cohort-topic-bootstrap-parent-reference`
ticket, which has since landed (commits `0ac3dd7`, `89a1d4c`). Two facts establish this:

- The tiered policy in `db-core/.../antidos/bootstrap-evidence.ts` `verify(reg, tier)` consults, for
  `tier <= maxNoPowTier` (T0/T1), **only** `verifyParentReference` — it never calls `verifyReputation`.
  (`verify` L70-88: `if (tier <= this.maxNoPowTier) return this.verifyParentReference(reg)`.) `tier` here
  is the **capacity tier** (`reg.tier`), confirmed at `member-engine.ts` L142 `const tier = reg.tier`.
- The `endorse` seam mints a **reputation** envelope (`bootstrap-evidence-builder.ts` L92-100). At T0/T1
  that envelope is simply never inspected, so a self-vouch endorsement changes nothing for the regressed
  path. (It would only ever help T2/T3 — which already works via the real PoW the builder mints.)

So the prior ticket's "verifyParentReference is the interim referee reputation stand-in" is no longer
true: `host.ts` `createBootstrapEvidencePolicy` (L856-882) now wires the **real**
`createParentReferenceVerifier` for `verifyParentReference`.

## Why T0/T1 origination is genuinely un-gateable today

For a configured production node, T0/T1 `bootstrap: true` is admitted **iff** `verifyParentReference(reg)`
returns true, which requires **both**:

1. a signed `parentRef` envelope on the register, and
2. `parentTopicView.exists(parentTopicId, tier)` returning true.

Neither can happen for a real cold-start origination:

- The participant-side builder (`createBootstrapEvidenceBuilder`) has **no parentRef minting path** — it
  mints PoW (T2/T3) or a reputation self-vouch (T0/T1, only if `endorse` is wired), never a parentRef. So
  the register carries no `parentRef` envelope → check (1) fails.
- Even if it did, the host-default `parentTopicView` for T0/T1 consults `committedReader`
  (`createDefaultParentTopicView`, `bootstrap-parent-reference.ts` L148-157), and node-base intentionally
  leaves `committedParentTopicReader` **unwired** (`libp2p-node-base.ts` L796-802 — no coord-keyed
  committed index exists yet; that is the follow-on `cohort-topic-parent-ref-tx-log-content`). So
  `exists(...)` is hard-wired `false` at T0/T1 → check (2) fails.
- Conceptually a **brand-new root topic has no parent**, and the verifier explicitly rejects a
  self-reference (`parentTopicId === reg.topicId`, `bootstrap-parent-reference.ts` L90). There is no
  evidence a genuine tier-0 origination can mint that a parent-reference gate would accept.

Therefore T0/T1 cold-start origination cannot be meaningfully gated until a real committed-existence
backing lands. The correct interim posture is **permissive-but-logged at T0/T1**, while keeping the real
T2/T3 PoW / reputation / parent-reference gate (which works today and is worth keeping).

This is a **refinement of the original ticket's Option 2** ("scope the production gate to T2/T3 only"),
narrowed so it does not regress the just-landed parent-reference behavior (see next section).

## The narrowing that keeps the parent-reference work intact

We must NOT make T0/T1 *unconditionally* permissive when configured. `host-antidos-coldstart.spec.ts`
already has live tests (L214-255) that inject an explicit `antiDos.parentTopicView` and assert a configured
host performs **real** T0 parent-ref gating (admits a known parent, denies an unknown parent / bad sig).
Those must keep passing.

The discriminator is: **does this host actually have a committed-existence backing to check against?**

- Yes (an `antiDos.parentTopicView` override OR a `committedParentTopicReader` was supplied) → keep the
  real T0/T1 parent-ref gate. (This is the test path, and the future production path once the committed
  index exists.)
- No (neither supplied — today's production node) → T0/T1 is permissive-but-logged; T2/T3 stays fully
  gated.

Note T2/T3 is unaffected by this change: at T2/T3 the policy calls
`verifyPoW || verifyReputation || verifyParentReference`, and the wrapper below returns the *real*
`verifyParentReference` whenever `tier > maxNoPowTier`, so the T2/T3 third option (FRET-membership-backed)
keeps working.

## Design / interfaces

Thread a `hasCommittedParentBacking: boolean` into `createBootstrapEvidencePolicy` and use it to gate only
the T0/T1 branch of the parent-reference verifier.

```ts
// host.ts — call site (~L592)
const hasCommittedParentBacking =
    options.antiDos?.parentTopicView !== undefined ||
    options.committedParentTopicReader !== undefined;
const bootstrapEvidence = createBootstrapEvidencePolicy(
    options.antiDos, hash, log, parentTopicView, hasCommittedParentBacking,
);

// host.ts — createBootstrapEvidencePolicy (~L835)
// maxNoPowTier mirrors the db-core policy (override config wins, else DEFAULT_MAX_NO_POW_TIER).
const maxNoPowTier = overrides?.config?.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER;
const realParentReference = createParentReferenceVerifier({ parentTopicView });

// When configured but with no committed backing, a T0/T1 (tier <= maxNoPowTier) bootstrap cannot mint any
// acceptable parent-ref (a root has no parent; committedReader is unwired), so admit permissively-but-logged
// — the documented interim posture — while still running the real verifier at T2/T3 and at T0/T1 once a
// committed backing IS wired (the test seam / future production index).
const parentReferenceGate = (reg: RegisterV1): boolean => {
    if (reg.tier <= maxNoPowTier && !hasCommittedParentBacking) {
        return permissive("parent-reference (T0/T1, no committed backing)")(reg); // one-time warn
    }
    return realParentReference(reg);
};

return createBootstrapEvidence({
    verifyPoW: overrides?.verifyPoW ?? (configured ? realPoW : fallback("proof-of-work")),
    verifyReputation: overrides?.verifyReputation ?? realReputation ?? fallback("reputation"),
    verifyParentReference: overrides?.verifyParentReference ?? (configured ? parentReferenceGate : fallback("parent-reference")),
    config: overrides?.config,
});
```

Import `DEFAULT_MAX_NO_POW_TIER` from `@optimystic/db-core` in `host.ts` (already exported; used by
`bootstrap-parent-reference.ts` and `bootstrap-evidence-builder.ts`).

`libp2p-node-base.ts` is **unchanged** — keep `antiDos: { reputation, ... }` and the unwired
`committedParentTopicReader`. The fix lives entirely in the host policy. Do **not** revert the node-base
wiring (that is the original ticket's Option 3, which would also drop the working T2/T3 gate).

Leave the `buildBootstrapEvidence` wiring (`host.ts` ~L670, no `endorse`) as-is. The `endorse` seam stays
unwired — it is dead weight for the regressed path and wiring it is explicitly the wrong fix.

## Integration spec (`substrate-real-libp2p.integration.spec.ts`) — gated, validate out-of-band

This suite is `OPTIMYSTIC_INTEGRATION`-gated and exceeds the 2-min default, so it is **not agent-runnable**;
do the edits, but validate it in CI / out-of-band, not inside this ticket.

- **L454-455 (T0 `bootstrap: true`, no evidence):** with the fix, the production node has no committed
  backing → T0 permissive → admitted. **No change needed**; confirm via the gated run.
- **L521-535 (`Tier.T3` `bootstrap: true`, no evidence):** T3 is always gated. Attach a self-vouch
  reputation endorsement so the production node's reputation verifier admits it (the registrant is an
  unseen, non-banned peer → score 0 < deprioritize threshold → admitted). Build it from db-core helpers:

  ```ts
  // before the final register sign — bootstrapBoundImage depends only on (topicId, tier, participantCoord,
  // timestamp), so compute it on regBody, then attach, then sign the register.
  const repSig = await signPeer(remote.member.key, bootstrapBoundImage(regBody));
  const evidence = serializeBootstrapEvidenceEnvelope({
      v: 1,
      reputation: { referee: bytesToB64url(remote.member.bytes), sig: bytesToB64url(repSig) },
  });
  const regBodyWithEv = { ...regBody, bootstrapEvidence: evidence };
  const reg: RegisterV1 = { ...regBodyWithEv, signature: bytesToB64url(await signPeer(remote.member.key, registerSigningPayload(regBodyWithEv))) };
  ```

  Add `serializeBootstrapEvidenceEnvelope` and `bootstrapBoundImage` to the existing `@optimystic/db-core`
  import block (L8-35). `signPeer` and `bytesToB64url` are already imported. (Verify whether
  `registerSigningPayload` covers `bootstrapEvidence`; either way attach evidence before the final sign.)

## TODO

### Phase 1 — host policy fix
- [ ] In `host.ts`, import `DEFAULT_MAX_NO_POW_TIER` from `@optimystic/db-core`.
- [ ] Compute `hasCommittedParentBacking` at the `createBootstrapEvidencePolicy` call site (~L592) from
      `options.antiDos?.parentTopicView` / `options.committedParentTopicReader` and pass it through.
- [ ] Add the `hasCommittedParentBacking` parameter to `createBootstrapEvidencePolicy` (~L835) and wrap the
      parent-reference verifier so T0/T1 (`reg.tier <= maxNoPowTier`) is permissive-but-logged when there is
      no committed backing, and the real verifier otherwise (and always real at T2/T3).
- [ ] Update the function's doc comment to describe the T0/T1-without-committed-backing permissive path (the
      current comment claims the interim reputation stand-in is gone and the verifier is "real whenever
      configured" — correct that).
- [ ] Confirm `libp2p-node-base.ts` L795 is left wired (`antiDos: { reputation }`) and `endorse` stays
      unwired in `host.ts`.

### Phase 2 — lock-in unit test (runnable)
- [ ] Add a test to `host-antidos-coldstart.spec.ts`: a host configured with `{ reputation: cleanReputation }`
      and **no** `parentTopicView` admits a T0 `bootstrap: true` register with **no** evidence (the regression
      guard), while a T2 `bootstrap: true` with no evidence is still denied (proves the fix is scoped to T0/T1).
- [ ] (Optional but recommended) a sibling assertion that supplying `antiDos.parentTopicView` restores real
      T0 gating (denies an unknown parent) — i.e. the existing L214-255 behavior still holds.

### Phase 3 — integration spec (edit now, validate out-of-band)
- [ ] Attach a self-vouch reputation endorsement to the L521-535 T3 register (snippet above); add the two
      db-core imports.
- [ ] Leave the L454-455 T0 register evidence-less; add a comment that production has no committed backing so
      T0 bootstrap is admitted permissively.

### Validation
- [ ] Build + typecheck `packages/db-p2p` (and `db-core` if touched — it should not be).
- [ ] Run the runnable cohort-topic unit suites (at minimum `host-antidos-coldstart.spec.ts`,
      `bootstrap-evidence-verifiers.spec.ts`, `bootstrap-parent-reference.spec.ts`), streaming output
      (`... 2>&1 | tee`). These cover the policy change.
- [ ] Defer `substrate-real-libp2p.integration.spec.ts` (`OPTIMYSTIC_INTEGRATION=1`) to CI / a human — note
      the deferral in the review handoff.
