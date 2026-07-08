description: Doc-only annotation pass on correctness.md, right-is-right.md — adds target-vs-current status notes to all BFT/dispute theorems and sections.
prereq:
files:
  - docs/correctness.md
  - docs/right-is-right.md
difficulty: easy
----

# Review handoff: annotate-correctness-theorems-status

Doc-only change; no code edited, no build or test run required.

## What was done

Added `> **Status (…):**` blockquotes to `docs/correctness.md` mirroring the Theorem 3 precedent, plus reconciled one paragraph in `docs/right-is-right.md`. No theorem text was deleted — all are retained as target designs.

### Top-of-document banner (correctness.md line 7)

Single blockquote immediately after the intro paragraph listing which theorems are target vs current, citing the two code constants (`superMajorityThreshold = 0.67` at `libp2p-node-base.ts:605`, `disputeEnabled = false` at `dispute/types.ts:124`) and cross-linking `architecture.md` §Status & Evolution and `tickets/blocked/dispute-synchronous-escalation-decision.md`.

### Per-theorem status notes added

| Location | Status assigned |
|---|---|
| §1.5 Global Honest Majority | Pointer: `f < N/2` is the target; current bound described in T10 note |
| Theorem 1, Case 3 | **Target** — Byzantine cluster super-majority commits with `disputed` flag; no pre-commit dispute |
| Theorem 2 | Largely **current** (membership binding + admission gate landed); flagged: (1) threshold discrepancy 75% prose vs 0.67 code default; (2) implicit escalation clause is target |
| Theorem 7, clause 2 | **Target** — multi-round escalation with per-round timeouts; clauses 1 and 3 are current |
| Theorem 8 | **Target / not implemented** — single round, hard-coded `round=0`, no production caller, sampling function exists but unwired |
| Theorem 8b | **Built but not live** — cascade + reversal code implemented and unit-tested; end-to-end origination wiring missing |
| Theorem 10 | Tiers 1–2 **current**; Tiers 3–4 + cost model **target**; threshold discrepancy noted; effective guarantee stated plainly |
| Cost model table (T10) | **Target** — added separate blockquote after table |
| §7.1 Sybil | Sampling function **current**; dispute invocation path **unwired** |
| §7.2 Partition healing, forked case | **Built but not live** (same as T8b) |
| §8 Composition item 6 | Softened: detection **current**, ejection **target** |
| §9 Formal Verification | **Targets design** — TLA+ model covers phases not yet built; current theorems listed |

### right-is-right.md reconciliation

"Current Behavior: Async Dispute" paragraph — added explicit note that even the async path is not wired in production (`initiateDispute` has no production caller, service is off by default). The paragraph previously described the design intent of the code accurately but omitted the off-by-default + unwired-initiation reality.

## Cross-document consistency check

- All tolerance numbers cite both the prose value (0.75) and the code default (0.67) with `libp2p-node-base.ts:605` as the source.
- No annotation describes a landed prereq (`arbitrator-independent-sampling`, `cluster-membership-admission-gate`, `bind-cluster-membership-into-signed-record`) as unbuilt.
- Annotations are consistent with `architecture.md` §Status & Evolution ("cascading dispute escalation with synchronous blocking" listed as partially implemented there) and with `right-is-right.md` §Durable Invalidation / §Client Notification wiring-status notes.

## Known gaps (not filed as tickets — existing state)

- Threshold discrepancy (0.67 code vs 0.75 prose) is noted in annotations but not corrected in the theorem proofs themselves; those proofs belong to the target design and correcting the numbers there is a separate concern. `NOTE:` left in the Theorem 10 status note.
- Theorem 6 (Durability) also says "≥75% of cluster nodes" — same discrepancy — but Theorem 6 is not in the BFT/dispute set covered by this ticket. No annotation added there.

## Testing / verification

No build or test run required — doc-only. Reviewer should read all three docs end-to-end for cross-document consistency. The three key invariants to check:

1. Every status note cites real source-file line numbers that exist in the codebase.
2. No annotation contradicts the existing honest notes in `architecture.md` §Status & Evolution or `right-is-right.md` §Durable Invalidation.
3. The top-of-document banner lists exactly the theorems that have per-theorem status notes.
