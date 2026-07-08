description: Doc-only annotation pass on correctness.md / right-is-right.md adding target-vs-current status notes to the BFT and dispute theorems. Reviewed and completed.
prereq:
files:
  - docs/correctness.md
  - docs/right-is-right.md
----

# Complete: annotate-correctness-theorems-status

Doc-only change. Annotated `docs/correctness.md` and reconciled one paragraph in
`docs/right-is-right.md` with `> **Status (…):**` blockquotes distinguishing the
**target** dispute/BFT mechanism from what the shipping code actually provides.
See the implement handoff (commit `72a2fbe`) for the full list of annotations.

## Review findings

Adversarial pass. This is a documentation change whose entire correctness rests on
whether its cited source-file references are accurate and whether the target-vs-current
claims match the code. That is what was checked.

### Citation accuracy — every cited `file:line` verified against the codebase

| Citation in docs | Verified |
|---|---|
| `superMajorityThreshold = 0.67` @ `libp2p-node-base.ts:605` | ✅ exact (also documented default at line 177) |
| `disputeEnabled = false` @ `dispute/types.ts:124` | ✅ exact |
| `round = 0` in `initiateDispute` @ `dispute-service.ts:137` | ✅ function decl at 137; `const round = 0` at 179 (citing the function is fine) |
| `sampleArbitrators` @ `db-p2p/src/dispute/arbitrator-selection.ts` | ✅ exists at line 94, takes a `round` param |
| `cascade.ts`, `invalidation.ts` under `dispute/` | ✅ both exist |
| `ClusterCoordinator.executeTransaction` | ✅ class + private method exist (`repo/cluster-coordinator.ts:37,249`) |
| `initiateDispute` has no production caller | ✅ confirmed — only callers are `test/dispute.spec.ts`; no `src/` call site |

### Finding fixed inline (minor — misattributed line range)

Three occurrences cited `cluster-coordinator.ts:299-332` as the range that "commits and
sets `record.disputed = true`". Lines 299–311 are the **super-majority-*failed* throw**
(the transaction does *not* commit there) — the opposite path. The disputed-flag set is
`312-332`. Corrected all three to `312-332` (matching the precedent in
`tickets/plan/p2p-dispute-subsystem-wiring.md` and `docs/review.html`):
- `correctness.md` Theorem 1 Case 3 status note
- `correctness.md` Theorem 10 status note
- `right-is-right.md` §Current Behavior: Async Dispute

### Threshold-default nuance — verified, no change needed (noted here so a future reader doesn't re-flag it)

The docs frame the tolerance discrepancy as "prose 0.75 vs code default 0.67
(`libp2p-node-base.ts:605`), 0.75 in the test/mesh harness". There are in fact *three*
library-level `superMajorityThreshold` fallbacks that default to **0.75**
(`coordinator-repo.ts:97`, `db-core/src/cluster/structs.ts:51`, `mesh-harness.ts:144,265`),
not just the harness. The docs' central claim still holds because the production node
factory (`libp2p-node-base.ts:605`) passes `0.67` explicitly, overriding those fallbacks
on the real wire — and the docs cite exactly that line as the source. So the "effective
production default is 0.67" framing is correct. Not a defect; recorded so the multiple
0.75 fallbacks aren't mistaken for a contradiction later.

### Invariants the implementer asked the reviewer to confirm

1. **Every status note cites real source-file line numbers** — ✅ after the 299→312 fix above.
2. **No annotation contradicts the honest notes in `architecture.md` §Status & Evolution or `right-is-right.md` §Durable Invalidation** — ✅ consistent (dispute escalation described as partially-implemented / target in all three).
3. **Top-of-document banner lists exactly the theorems that have per-theorem notes** — ✅ banner names Theorems 1 (Case 3), 2, 7 (clause 2), 8, 8b, 10 (Tiers 3–4 + cost model); each has a matching per-theorem note. The additional section notes (§1.5, §7.1, §7.2, §8 composition item 6, §9) are sections, not theorems, and are correctly outside the banner's theorem list — no contradiction.

### Scope decisions accepted (documented, not defects)

- **Theorem 6 (Durability)** also says "≥75% of cluster nodes" — same prose-vs-code discrepancy — but is outside the BFT/dispute set this ticket scoped, so it was left un-annotated. Reasonable; the discrepancy is already surfaced in the Theorem 2 and 10 notes. Not filed as a follow-up — the target proofs deliberately retain the design number.

### Lint / tests

**Not run — with reason.** The change is doc-only: three markdown line-number edits and
prior prose annotations. There is no code surface to compile, lint, or exercise; running
the suite would test nothing about this diff and would only risk surfacing unrelated
pre-existing failures. No `.pre-existing-error.md` written (no suite run).

### Net disposition

- **Minor:** 1 found (misattributed `299-332` line range) → **fixed inline** in all 3 sites.
- **Major:** none.
- **Tripwire:** none warranted — the 0.75-fallback nuance is verification, not a conditional latent concern; the docs already cite the correct production source line.
