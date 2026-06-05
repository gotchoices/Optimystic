description: Review the partition-healing doc-map addition and cross-link consistency audit (architecture.md, cohort-topic.md, reactivity.md).
prereq:
files: docs/architecture.md, docs/partition-healing.md, docs/cohort-topic.md, docs/reactivity.md, docs/crdt-sync.md
----

## What was done

Doc-only change. No source, build, or test impact.

### 1. Document Map (docs/architecture.md)

Added two rows to the `## Document Map` table (between `matchmaking.md` and `correctness.md`):

| [crdt-sync.md](crdt-sync.md) | Convergent replicated state sync underpinning partition recovery |
| [partition-healing.md](partition-healing.md) | Partition-induced invariant reconciliation: two-tier intent/invariant rules, deterministic application-defined merge |

Both files existed on disk but were absent from the map. partition-healing was the mandated fix; crdt-sync was added per the ticket's instruction ("add it too if also absent — it is the paired document partition-healing builds on"). Verified crdt-sync.md exists via Glob.

### 2. Cross-link consistency audit — result: CONSISTENT, no edits required

- **cohort-topic.md L662** — link text: "cohort merge after partition is handled by FRET stabilization; the layer reacts via `cohortEpoch` refresh." This is layer-accurate. cohort-topic §"Failure modes" (L418 minority loss, L424 network partition healing) describes membership/transport recovery only: FRET re-stabilization, `cohortEpoch` refresh, deterministic primary re-assignment, child-cohort list merge. It does **not** claim data/invariant reconciliation — which is correctly left to partition-healing's transaction-layer two-tier model. No overclaim to correct.

- **reactivity.md L497** — link text: "handled at the cohort-topic layer via `cohortEpoch` refresh; reactivity reacts by re-verifying its parent-checkpoint bracketing signatures." Coherent with partition-healing's `effectGate: 'on-stable'` semantics (partition-healing.md L182: "stable transactions survive merges"). Since stable transactions and their commit/bracketing certificates survive a merge, reactivity's re-verification of bracketing signatures on heal is sound. No inconsistency.

## Validation for reviewer

- Confirm the two new Document Map rows render correctly and links resolve (`docs/crdt-sync.md`, `docs/partition-healing.md` both exist).
- The audit conclusion is a judgment call: the reviewer may independently re-read partition-healing.md §"Two-Tier Rule Model" / §"External Effects Revisited" against the cohort-topic and reactivity §"Failure modes" sections to confirm no overclaim. Specifically verify the assertion that cohort-topic performs *no* data reconciliation (membership/transport only) holds throughout cohort-topic.md, not just at the cited lines.

## Known gaps / honesty notes

- This was a documentation-only audit. No automated check enforces doc-map completeness, so future spec docs could again be omitted — out of scope here but worth noting.
- The audit did not exhaustively cross-read every reference to partition-healing across all docs (e.g. crdt-sync.md's several references mentioned in the source ticket were not re-verified line-by-line, only the two mandated cohort-topic/reactivity links).
