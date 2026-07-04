description: Two block-restoration paths used to trust a single peer's self-reported "latest version" with no proof; they now require a quorum of peers to agree (and, for content copies, matching bytes) before accepting. This is the review pass over that change.
prereq:
files: packages/db-p2p/src/cluster/quorum-restore.ts (new — quorum + content-hash helpers), packages/db-p2p/src/repo/coordinator-repo.ts (queryClusterForLatest rewrite + penalize helper), packages/db-p2p/src/libp2p-node-base.ts (reconcileBlock rewrite), packages/db-p2p/src/reputation/types.ts (PenaltyReason.InvalidRestoration), packages/db-p2p/test/quorum-restore.spec.ts (new unit spec), packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts (new — was the repro, now inverted), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts (unchanged, still green)
difficulty: hard
----

# Review: read-repair + reconcile now verify peer claims by quorum

## What the change does

Before this change, two paths that restore/replicate a block trusted whatever
"latest revision" a **single** peer reported — no signature, no quorum, no
content check. A lone lying peer over-reporting its revision could steer
restoration onto bogus content even when the honest majority disagreed. The fix
replaces "max rev any peer reports wins" with "**highest `(rev, actionId)`
corroborated by a quorum of distinct peers wins**", and additionally requires
**byte-identical content agreement** before persisting a replicated block.

### New shared module — `packages/db-p2p/src/cluster/quorum-restore.ts`

Three pure, directly-unit-tested primitives:

- `quorumSize(responderCount, simpleMajorityThreshold)` → `max(2, floor(threshold × responderCount))`.
  Absolute minimum of 2 means a claim must be seconded by at least one other peer.
- `selectQuorumRev(claims, threshold)` — groups `RevClaim`s by exact
  `(rev, actionId)`; returns the highest rev whose group has ≥ quorum **distinct**
  voters. Small-cluster fallback: when there are too few responders to *form* a
  quorum but ALL responders agree on one pair, that pair is accepted (honest
  lagging peer). Returns `undefined` when nothing is corroborated.
- `canonicalBlockHash(block)` + `selectQuorumBlock(candidates, threshold)` — the
  reconcile content gate: hashes each candidate block (sha256 over canonical
  JSON, mirroring `ClusterMember.canonicalJson`/`computeCommitHash`) and requires
  a **unique** hash group meeting quorum (no single-block fallback — a lone block
  or a content split declines).

### Read-repair — `CoordinatorRepo.queryClusterForLatest` (coordinator-repo.ts)

Rewritten from `Math.max` over peer revs to `selectQuorumRev`. Each peer's
response is tagged with its peer-id so votes stay distinct (the local node's own
latest is one vote — `clusterLatestCallback` self-short-circuits to local
storage). `undefined` → `fetchBlockFromCluster` does not restore (keeps local).
`simpleMajorityThreshold` and `reputation` are now stored as fields.

### Reconcile — `reconcileBlock` (libp2p-node-base.ts)

Rewritten from raw `Math.max` archive rev to: build one `(rev, actionId)` claim
per cohort archive (max rev ≥ committed.rev) → `selectQuorumRev` → filter
corroborating archives that carry a block → `selectQuorumBlock` content gate →
`saveReplicatedBlock` only on agreement. No quorum, or no content quorum → skip
persist (leave block; churn/rebalance retries).

### Penalties (best-effort, never throws)

New `PenaltyReason.InvalidRestoration` (weight 30). Read-repair penalizes a peer
whose claim contradicts the quorum (`rev > selected.rev`, or equal rev with a
different actionId — a **lower** rev is just lag and is never penalized).
Reconcile penalizes a peer serving content that hashes differently from the
agreed block. Both are wrapped so a reputation write can never block or throw in
the restore path.

## How to validate

- `cd packages/db-p2p && yarn test` — full suite: **1144 passing, 36 pending**
  (was green before; no regressions).
- Focused: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/quorum-restore.spec.ts" "test/coordinator-repo-read-repair-trust.spec.ts" "test/coordinator-repo-read-repair.spec.ts" --reporter spec`
- Typecheck: `cd packages/db-p2p && npx tsc --noEmit` (exit 0).

### Cases covered by tests (the floor, not the ceiling)

- **Single liar outvoted** (`...-trust.spec.ts`): 3 honest rev-1 + 1 liar rev-99
  → no restore against rev 99; liar penalized, honest peers not.
- **Independent minority liars** (distinct fabricated pairs) → outvoted.
- **Honest quorum-backed higher rev** (2 peers agree rev-5) → restoration fires
  with rev 5.
- **Lone honest lagging responder** → still restores via the small-cluster
  fallback.
- **Quorum primitives** (`quorum-restore.spec.ts`): thresholds, highest-rev
  preference, disagreement decline, single-responder fallback, distinct-voter
  counting; and the reconcile CONTENT gate — accept-on-agreement,
  **reject-tampered-content**, decline-on-single-block, decline-on-even-split.

## Known gaps — treat my tests as a floor

1. **`reconcileBlock` has no end-to-end/integration test.** Its quorum + content
   logic is fully unit-tested via `quorum-restore.spec.ts`, but the *wiring* in
   the `libp2p-node-base.ts` closure (archive fetch → candidate build →
   `selectQuorumRev` → `selectQuorumBlock` → penalize → `saveReplicatedBlock`) is
   verified by reading only — no libp2p node is stood up. Read-repair, by
   contrast, IS exercised end-to-end through the `CoordinatorRepo` harness.
   Reviewer: consider whether a mesh-harness/integration test for the reconcile
   wiring is warranted, or accept the unit coverage + read-repair parallel.

2. **The mesh-harness test double was NOT changed.** `src/testing/mesh-harness.ts`
   (`reconcileBlock`, ~line 157) still does simple single-peer trust (saves the
   first block a cohort peer serves). It is test infrastructure, not the
   production path, so the fix is complete for production — but the harness no
   longer mirrors production restore semantics. Flagging in case a reviewer wants
   the simulated mesh to be faithful (would let an integration test for gap #1
   actually observe the quorum behavior).

3. **Quorum is corroboration-of-a-claim, NOT Sybil-resistant.** Colluding peers
   minting fresh keypairs onto the SAME fabricated `(rev, actionId)` can still
   reach quorum. This is the explicit scope boundary from the source ticket;
   parked as `NOTE:` comments at both quorum sites (queryClusterForLatest doc
   comment; reconcileBlock candidate-build comment) and indexed here. The
   stronger commit-cert + cohort-membership upgrade is the existing backlog
   ticket `debt-read-repair-commit-cert-verification` (already present).

4. **`quorumSize` uses `floor`, per the source ticket's spec** ("`threshold ×
   responder count, floored, min 2`"). For odd responder counts this *under*-shoots
   a true majority — e.g. 5 responders → quorum 2 (not 3). This defeats the
   single-liar threat (1 < 2 always) but means two seconding votes suffice at
   N=5. If a reviewer thinks the barrier should be a strict majority (`ceil`),
   that is a deliberate design change beyond this ticket's stated rule — record
   as a tripwire, not a silent edit.

## Tripwires noticed (parked, not filed as tickets)

- The Sybil-membership gap (#3) — `NOTE:` at both quorum sites, indexed above.
- `floor` vs strict-majority quorum (#4) — indexed above; the source ticket
  prescribed `floor`, so it is intentional, not a defect.
