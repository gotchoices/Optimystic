description: Before transaction-reversals are wired to actually run on a live node, the network must be able to independently re-derive who the legitimate referees were — otherwise an attacker could still get a forged reversal accepted.
prereq: cohort-topic-membership-cert-trust-anchoring
files:
  - packages/db-p2p/src/dispute/invalidation.ts (verifyInvalidationCertificate — layer-2/3 / degradation)
  - packages/db-p2p/src/cluster/cluster-repo.ts (applyConsensusInvalidation, recomputeArbitratorSet injection)
  - packages/db-p2p/src/libp2p-node-base.ts (composition root — recomputeArbitratorSet intentionally unset)
  - docs/right-is-right.md (§Durable Invalidation — Unforgeability / Wiring status)
difficulty: hard
----

# Gate live invalidation wiring on arbitrator-set anchoring (recompute or trust chain)

## Why this exists (review finding, 7.8-invalidation-cert-arbitrator-set-binding)

The arbitrator-set binding (#1) landed as **defense-in-depth with a degradation tier**. When the
verifying member has no way to independently re-derive the legitimate arbitrator set — no injected
`recomputeArbitratorSet` (layer 2) and no trust anchor (layer 3) — `verifyInvalidationCertificate`
**accepts a layer-1-valid certificate and logs** it as not-fully-anchored. That is correct *today*
because:

- the live composition root (`libp2p-node-base.ts`) intentionally leaves `recomputeArbitratorSet`
  unset (a naive FRET recompute without a churn-tolerance window would false-reject legitimate
  late-joiner certs — a liveness regression), and
- the invalidation subsystem is **dormant**: there is no end-to-end origination/emit wiring
  (`onInvalidate` → `applyInvalidation`, invalidation change-event emit) on a live node, so nothing
  actually applies a network-originated invalidation. No live exploit path exists.

The hazard is **sequencing**. The moment invalidation is wired to a live path — without either a
validated live recompute (layer 2) or the trust-anchor chain (layer 3) in place — the accept-and-log
degradation becomes a **live forgeable-reversal vector**: a peer that can mint Ed25519 keypairs
self-signs a synthetic cohort + a 2/3 super-majority, and a degradation-mode member accepts it. The
headline test `invalidation.spec.ts` "rejects sybil-key votes when recompute exposes a forged
arbitrator set" documents exactly this: with no recompute the forged proof returns `true`.

This constraint currently lives only in code comments (`verifyInvalidationCertificate` doc-comment,
the `libp2p-node-base.ts` comment) and `docs/right-is-right.md`. It is **not** enforced by the ticket
graph — the trust-anchor plan ticket (`cohort-topic-membership-cert-trust-anchoring`) does not know
invalidation is a downstream consumer, and no live-wiring ticket exists yet to carry the prereq. This
ticket makes the requirement first-class and discoverable.

## Requirement

The ticket that wires invalidation onto a live node (origination/emit + `onInvalidate` →
`applyInvalidation` at the composition root) **must not** land until at least one of the following
hard-gates the no-anchor case:

- **Layer 2 — live recompute.** Wire `recomputeArbitratorSet` on `ClusterMember` from FRET at the
  composition root, with a churn-tolerance window validated against live topology (not unit-testable
  here). It must re-derive the eligible set the way `sampleArbitrators` does (verifiable dispersed
  sampling — the peers nearest K pseudo-random ring coordinates `hash(blockId ‖ round ‖ epoch ‖ i)`,
  threading the proof's `round`/`epoch` through the recompute context) and judge the carried set, returning
  `{feasible:false}` only for genuine late-joiner/churn cases — never silently accepting.
- **Layer 3 — trust anchor.** When `cohort-topic-membership-cert-trust-anchoring` lands, upgrade the
  degradation tier from accept-and-log to a **hard gate** for the no-recompute path, so a cert that
  can be neither recomputed nor anchored is *rejected*, not accepted.

Until one of those is in place, invalidation must stay dormant (verify-only, no live apply/emit). The
live-wiring ticket should depend on this one (and on the trust-anchor / recompute work) via `prereq:`.

## Related residuals (same review, lower severity — capture, do not necessarily fix here)

- **Challenger ∈ cohort (layer-1 depth).** The pure verifier validates `arbitratorSetSignature`
  against `challengerPeerId`'s embedded key but does not confirm `challengerPeerId` was a member of the
  committed transaction's cohort (the `InvalidateRequest`/proof does not carry the original peers). A
  cheap hardening when wiring the cluster path: thread the committed transaction's cohort into the
  cluster-path verify and assert the challenger was a member (the applying member honored that commit
  cert). Closes part of the malicious-challenger surface even before layer 2/3.
- **Cascade children verify at degradation strength.** `cascadeInvalidate` reuses the root proof
  through `applyInvalidation`, which runs no recompute. Acceptable because the root was already gated at
  the cluster path (`applyConsensusInvalidation` passes the recompute) — but the live-wiring work must
  preserve that invariant: a cascade root must always pass through the recompute-capable gate before
  its children reuse the proof.
