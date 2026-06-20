description: Supply real cold-root bootstrap-evidence verifiers (proof-of-work + committed-work/parent-reference) for the cohort-topic BootstrapEvidence policy, replacing the interim permissive-but-logged default in the host.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy — verifier injection seam)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (the tier policy; verifiers are injected, unchanged)
  - docs/cohort-topic.md (§Anti-DoS bullet 4)
difficulty: hard
----

# Cohort-topic: real bootstrap-evidence verifiers

The anti-DoS wiring ticket (`cohort-topic-host-antidos-coldstart`) constructed the node-level
`BootstrapEvidence` policy and wired it into every cohort, but db-core embeds no PoW / reputation /
committed-work scheme, so the host injects the **verifiers**. Today those default to a
**permissive-but-logged** fallback (one-time warning, never an undefined gate): unless the caller
passes an `antiDos.reputation` view (which gates all tiers on a non-banned participant — the unwired
PoW verifier fails closed once any gating is configured) or explicit `antiDos.bootstrapEvidence`
verifiers, a cold-root `bootstrap: true` register is admitted without real cryptographic evidence.

Per `docs/cohort-topic.md` §Anti-DoS bullet 4, a cold root must demand one of:

- **T0 / T1** — a signed reference to a *committed parent topic that exists* (these tiers correspond
  to committed work; no proof-of-work expected).
- **T2 / T3** — a small **proof-of-work**, OR a **signature from a peer with sufficient reputation**
  ([architecture.md](../docs/architecture.md) §Reputation), OR a **signed parent-topic reference**.

## Requirements

- A real `verifyPoW(reg)` over a defined, cheap-to-verify / costly-to-produce PoW carried in the
  registration's opaque `appPayload`. Specify the puzzle (target difficulty, what bytes are bound —
  at least `(topicId, tier, participantCoord, timestamp)` so a PoW can't be replayed across topics or
  peers), and the difficulty knob.
- A real `verifyParentReference(reg)` that checks a signed reference to a committed parent topic that
  actually exists (the committed-work proxy for T0/T1), backed by the appropriate db-core/db-p2p
  committed-state lookup rather than a reputation stand-in.
- A real `verifyReputation(reg)` over a signature from a sufficiently-reputable peer, backed by the
  existing reputation service.
- The evidence envelope format in `appPayload` (a small, versioned, fully-parsed structure — no
  ad-hoc parsing) shared by the participant (who attaches it) and the cohort (who verifies it).
- Wire the verifiers as the host defaults (replacing the permissive fallback) where the backing
  subsystems are available; keep the injection seam for tests/overrides.

## Use cases / expected behavior

- A cold-root `bootstrap: true` with valid evidence for its tier → instantiates.
- A cold-root `bootstrap: true` with missing/invalid/wrong-tier evidence → `unwilling_cohort`
  (temporal back-off), never a silent accept.
- A PoW or parent-reference captured from one topic/peer cannot be replayed to bootstrap another.
- Non-bootstrap registrations carry no evidence and are unaffected.
