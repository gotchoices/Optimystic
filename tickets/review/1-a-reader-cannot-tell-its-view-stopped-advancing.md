description: A node that kept writing a shared table counted its own writes as proof its copy was current, so it could serve stale data forever; now a write only counts as freshness proof when its approval quorum was a majority of the full cohort, which mathematically rules out a rival update having slipped past.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts, packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (prereq behavior, unchanged), packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts (pattern source, unchanged)
----

# Implemented: commit-side freshness stamps gated on quorum intersection

## What changed and why

`CoordinatorRepo` keeps a per-block "last seen fresh" timestamp (`lastSeenCommitMs`) that
suppresses the read path's cohort consult for `readRepairWindowMs` (10 s default). Before
this change, every successful commit this node coordinated stamped that timestamp
unconditionally — so a node that kept writing a block never re-checked it against the
cohort, and a rival commit that landed on a quorum excluding this node stayed invisible
forever (the field measurement: 156 identical stale reads over 45 s, zero consults).

The fix is one new predicate and four gated call sites, all in
`packages/db-p2p/src/repo/coordinator-repo.ts`:

- **`commitQuorumRulesOutRivals(approvals, observedCohortSize)`** (private method, beside
  `markBlocksSeen`): true when the commit's approve votes exceed half of
  `max(observedCohortSize, repairCorroborationClusterSize)`. The comment on it carries the
  intersection argument: two strict majorities of the same cohort must share a voter, so a
  rival majority would have surfaced. The denominator deliberately reuses
  `repairCorroborationClusterSize` — the declared full-cohort yardstick the repair side
  already resolves for the same shrunken-view trap — never `record.peers` (the enrolled
  subset, which is what a downsize shrinks).
- **Solo short-circuit** (`commit`, `peerCount <= 1` branch): arms only when the predicate
  passes with numerator 1 — i.e. a genuine declared-and-observed cohort of one. Degraded
  routing (peerCount 0) and undeclared/larger declared sizes no longer arm.
- **Consensus path**: `armFreshness` is computed once from the record's approve-typed commit
  votes (new module helper `countApprovingCommitVotes`) and gates the local-executed success,
  the local-fallback success, and `tolerateLocalCommitDivergence` (which grew a fourth
  parameter). `clusterReachedCommitConsensus` (enrolled-subset majority — answers "did
  consensus complete") is untouched, per the ticket.
- **Consult-side markings untouched**: the solo-self-skip arm, `cluster-fetch:local-current`,
  and the post-restore arm all still stamp — a consult that ran is exactly the evidence the
  window tracks.

The commit itself still succeeds either way; only the freshness stamp is withheld.

## Prereq verification

`solo-node-read-repair-never-settles` landed (commit 63549617): the
`cluster-fetch:solo-self-skip` exit arms the window (coordinator-repo.ts ~line 958), and its
comment already documents the deliberate asymmetry with this commit-side rule ("Landing
both, keep both"). Its spec file `coordinator-repo-solo-read-repair-window.spec.ts` still
passes, so a genuine solo node's cost stays bounded at one `findCluster` per block per
window — the GitHub-issue-#8 storm does not return.

## How to validate

- New spec: `packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts` — 8 cases
  observing the window through the read path (a consult fires or it does not), covering:
  solo commit under declared cohort 2 does not arm (and the follow-up consult's own arming
  bounds the cost); genuine cohort-of-one commit arms; full-cohort-majority consensus commit
  arms; enrolled-minority record does not arm; the local-fallback success path and both
  tolerated-divergence shapes apply the same gate.
- Full suite: `yarn workspace @optimystic/db-p2p test` — 2566 passing, 49 pending, 0
  failing (log at `tickets/.logs/a-reader-cannot-tell-its-view-stopped-advancing.test.log`).
  `yarn workspace @optimystic/db-p2p typecheck` clean. No db-core changes.

## Honest gaps / things a reviewer should probe

- **Downstream (Sereus) verification is blocked, not done.** The ticket's deterministic
  reproducer (`npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`
  in `C:/projects/sereus/packages/integration-tests`, which symlinks this repo's packages)
  fails ~12 s in with `Block default/Revocation is unavailable (cohort-unreachable)` during
  its step-4 negative window — **before** ever reaching the step-6 stale-serve gate this
  ticket targets. I verified it fails byte-identically with a baseline build of HEAD
  (without this change), so the failure is pre-existing in the downstream repo and neither
  caused nor maskable by this fix. That path (locally-missing block, cohort unreachable) is
  window-independent — missing blocks bypass `shouldReadRepair` entirely. The end-to-end
  field scenario therefore remains unverified; the fix is verified at the unit seam only.
- **Cost surface**: any deployment that commits on downsized quorums (including every mesh
  or embedder that never declares `clusterSize`/`assumedClusterSize` — the yardstick then
  defaults to 10) now pays one cohort consult per touched block per 10 s window on its read
  path. All existing specs stayed green, but this is the deliberate trade the ticket asked
  for — a reviewer may want to confirm no hot read path in `reference-peer` or the demo
  regresses.
- **The two-member-cohort NOTE** at the `cluster-fetch:local-current` site
  (coordinator-repo.ts, "in a cohort of two, that sole peer is the only corroborator…")
  names "two-member cohorts become a supported production topology" as its revisit
  condition. The reporting deployment IS such a topology, so the condition has arguably
  tripped — but the parking it allows is bounded by one window per pass and was not the
  measured mechanism. Left as-is per the ticket; a human should decide whether to promote it.
- **Fork-ahead readers stay invisible** (known, out of scope): once the consult fires, a
  forked reader numerically AHEAD of the cohort's lineage still reads
  `cluster-fetch:local-current` and re-arms. That is backlog
  `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort`'s scope.
- The new predicate is one more piece of the scattered per-block freshness state that
  backlog `debt-freshness-state-scattered-across-coordinator-repo` complains about; it is
  kept as a single named helper so the eventual consolidation can lift it whole.

## Review findings

(to be filled by review stage)
