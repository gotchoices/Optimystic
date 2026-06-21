description: Turning on the new cold-start anti-DoS check for every real node accidentally blocks a node from ever creating a brand-new low-tier topic, because the node never produces the proof the check now demands.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (~line 787 — antiDos.reputation wired into every production node)
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy; createBootstrapEvidenceBuilder wiring; the `endorse` seam is left unwired)
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts (the `endorse` self-vouch seam — wired only in tests)
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (lines 454-455 tier-0 and 533-535 T3 bootstrap registers — now denied)
difficulty: medium
----

# Cold-start origination regression from the production bootstrap-evidence gate

## What happened

The verifiers ticket (`cohort-topic-bootstrap-evidence-verifiers`) wired the node's
`PeerReputationService` into **every** production node's cohort-topic host
(`libp2p-node-base.ts`, `antiDos: { reputation, … }`). Supplying any reputation view flips the
`createBootstrapEvidencePolicy` gate from **permissive-but-logged** to **configured**, which means an
unfilled verifier now fails **closed**.

The participant-side builder (`createBootstrapEvidenceBuilder`) is wired into the host **without** its
`endorse` seam. So for a cold-start `bootstrap: true` register:

- **T0/T1** — the builder mints **nothing** (no PoW expected at these tiers; no `endorse` supplied). A
  *configured* cohort gates T0/T1 solely on `verifyParentReference`, which is the interim referee
  reputation stand-in and rejects a register that carries no evidence envelope → `unwilling_cohort`.
- **T2/T3** — the builder mints a real PoW, which the configured cohort accepts. These tiers are fine.

**Net effect:** a real node can no longer originate / register a brand-new **tier-0 or tier-1** topic
in production. Before this change, an unconfigured production node admitted these permissively. This is
a behavioral regression for the core cold-start path at the single-tier-0 milestone, where topics live
at tier 0.

This was the deferral the implementer explicitly flagged for review ("a *configured* production cohort
denies a T0/T1 cold bootstrap … confirm this deferral is acceptable, or re-enable `selfEndorse`"). The
review verdict: it is **not** acceptable to ship as-is, because it silently breaks tier-0 origination
while providing **no** added T0/T1 protection (self-vouch and the eventual parent-ref are the real
gates; until one lands, the choice is "working + ungated" vs "broken + nominally configured").

## Concrete breakage: the real-libp2p integration suite

`substrate-real-libp2p.integration.spec.ts` is `OPTIMYSTIC_INTEGRATION`-gated, so it did **not** run in
the verifiers ticket's validation (nor in this review). It hand-rolls evidence-less `bootstrap: true`
registers against production (now-configured) nodes and asserts `accepted`:

- **Line 454-455** — a tier-0 `bootstrap: true` register (`signedRegister(participant, TOPIC, …)`, no
  `bootstrapEvidence`) handled by a production node's engine; expects `accepted`. Now `unwilling_cohort`.
- **Line 533-535** — a `Tier.T3` `bootstrap: true` register (no `bootstrapEvidence`) handled by a
  production node's engine; expects `accepted`. T2/T3 with no evidence → all verifiers fail closed →
  `unwilling_cohort`.

Both assertions will fail when the gated suite runs. The commit did not touch this spec.

## Options (pick one; needs a design call)

1. **Wire the `endorse` self-vouch seam into the production builder** (the implementer's trivial closure:
   `referee = self, sig = signPeerSig(nodeKey, boundImage)`). This restores T0/T1 origination — a
   configured peer's referee verifier admits a self-vouch (self scores 0 < threshold, valid sig). Note
   this gives **no real anti-DoS at T0/T1** (a Sybil mints keys freely), so it is functionally
   equivalent to permissive-with-a-signature until parent-ref lands — but it keeps origination working
   and the wire format real. Also requires the key-ful host to thread its private key into the builder.
2. **Scope the production gate to T2/T3 only** until `cohort-topic-bootstrap-parent-reference` lands —
   e.g. keep T0/T1 permissive (parent-reference is the real T0/T1 gate anyway), gate T2/T3 with the real
   PoW/reputation verifiers. Avoids shipping a broken-but-nominally-configured T0/T1 path.
3. **Defer the production wiring entirely** (revert the `antiDos: { reputation }` line) until both the
   minter and the parent-reference verifier exist, so the verifiers ship as unit-tested library code
   without changing live-node behavior this milestone.

Whichever is chosen, **update `substrate-real-libp2p.integration.spec.ts`** so its two bootstrap
registers carry evidence the now-configured nodes accept (the participants are keyed `Member`s, so a
self-vouch endorsement via `signPeerSig(member.key, bootstrapBoundImage(reg))` is the natural fix), or
construct those nodes with an explicit permissive `antiDos` override. Run the gated suite
(`OPTIMYSTIC_INTEGRATION=1`) to confirm — it exceeds the 2-min default and may not be agent-runnable, so
validate out-of-band / in CI.

## Recommendation

Option 1 (wire `selfEndorse`) keeps the milestone's cold-start path working with the least conceptual
drift from the documented interim posture, and the integration spec then needs only matching self-vouch
evidence on its two registers. Confirm with the design owner whether the (acknowledged) absence of real
T0/T1 anti-DoS until parent-ref is acceptable to ship behind a working origination path.
