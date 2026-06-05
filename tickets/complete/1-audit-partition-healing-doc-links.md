description: Add partition-healing.md (and crdt-sync.md) to the architecture document map and audit cohort-topic/reactivity cross-links for consistency with partition-healing's two-tier rule model.
prereq:
files: docs/architecture.md, docs/partition-healing.md, docs/cohort-topic.md, docs/reactivity.md, docs/crdt-sync.md
----

## Summary

Doc-only change. Added the two missing spec docs (`crdt-sync.md`, `partition-healing.md`) to the `## Document Map` table in `docs/architecture.md` (L291–292), and audited the two existing cross-links from `cohort-topic.md` and `reactivity.md` into `partition-healing.md` for layer consistency. No source, build, or test impact.

## What landed

- **architecture.md L291–292** — two new Document Map rows:
  - `crdt-sync.md` — "Convergent replicated state sync underpinning partition recovery"
  - `partition-healing.md` — "Partition-induced invariant reconciliation: two-tier intent/invariant rules, deterministic application-defined merge"
  - Placed after `matchmaking.md`, before `correctness.md`; crdt-sync precedes partition-healing (which builds on it).
- Cross-link audit conclusion: **CONSISTENT, no edits required.**

## Review findings

Adversarial pass over commit `fcaa184` and the docs it touches / should touch.

### Checked — doc map completeness
- Enumerated `docs/*.md` (15 files) against the map. After the change the map lists all 14 sibling docs; `architecture.md` itself is correctly excluded (it is the host of the map). Both new rows are well-formed table cells and their links resolve to files confirmed present on disk. **No defect.**
- Placement/ordering is a judgment call (crdt-sync/partition-healing sit between the cohort-topic family and correctness). Reasonable and internally ordered (paired doc before dependent). Not churned. **No defect.**

### Checked — cohort-topic ↔ partition-healing link (cohort-topic.md L662, §Failure modes L418/L424)
- Re-read cohort-topic §"Failure modes": "Cohort partition (minority loss)" (L418) and "Network partition healing" (L424) describe **only** membership/transport recovery — FRET re-stabilization, `cohortEpoch` refresh, deterministic primary re-assignment, child-cohort list merge. No claim of application-data/invariant reconciliation anywhere in the section. The L662 link text ("cohort merge after partition is handled by FRET stabilization; the layer reacts via `cohortEpoch` refresh") is layer-accurate and does not overstate cohort-topic's role. The implementer's assertion that cohort-topic performs *no* data reconciliation holds throughout the section, not just at the cited lines. **No overclaim; no edit.**

### Checked — reactivity ↔ partition-healing link (reactivity.md L497)
- L497 ("handled at the cohort-topic layer via `cohortEpoch` refresh; reactivity reacts by re-verifying its parent-checkpoint bracketing signatures") is coherent with partition-healing.md L182 (`effectGate: 'on-stable'` — "stable transactions survive merges"). Stable transactions and their commit/bracketing certificates survive a merge, so reactivity re-verifying bracketing signatures on heal is sound. **No inconsistency; no edit.**

### Checked — crdt-sync ↔ partition-healing references (implementer-flagged gap, now closed)
- The implementer's known-gap noted crdt-sync.md's references to partition-healing were not re-verified line-by-line. Did so: all 8 references (crdt-sync.md L11, L36, L73, L183, L239, L248, L259, L262, L285) consistently position partition-healing.md as the tier-2 / reconcile companion that "builds on this model." Bidirectional and coherent (partition-healing.md L9/L179 reciprocally reference crdt-sync as the tier-1 log). **No inconsistency found.** Gap is closed.

### Lint / tests
- `package.json` `lint` script is a no-op (`echo 'Lint not configured for all packages'`); no markdown/link-check tooling exists in the repo. The change touches no source. Running the package test suite would exercise nothing related to this diff. **Not run — disproportionate and non-exercising for a docs-only change; stated explicitly rather than skipped silently.**

### Minor findings fixed in this pass
- None. The implementation was complete and correct as handed off.

### Major findings filed as new tickets
- None.

## Honesty notes / residual gaps (out of scope, not regressions)
- No automated check enforces Document Map completeness; a future spec doc could again be omitted. This is a pre-existing process gap, not introduced by this change. Worth a backlog item if doc-map drift recurs, but not filed now (single occurrence, just corrected).
