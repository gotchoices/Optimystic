description: A node that kept writing a shared record counted its own writes as proof its copy was current, so it could serve stale data forever; now a write only counts as freshness proof when its approval quorum was a majority of the full group of responsible machines, which mathematically rules out a rival update having slipped past.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts, docs/transactions.md
----

# Completed: commit-side freshness stamps gated on quorum intersection

## What shipped

`CoordinatorRepo` keeps a per-block "last seen fresh" timestamp that suppresses the read path's
cohort consult for `readRepairWindowMs` (10 s default). Every successful commit this node
coordinated used to stamp that timestamp unconditionally, so a node that kept writing a block never
re-checked it against the cohort: a rival commit that landed on a quorum excluding this node stayed
invisible forever (field measurement: 156 identical stale reads over 45 s, zero consults).

One new predicate and four gated call sites, all in
`packages/db-p2p/src/repo/coordinator-repo.ts`:

- **`commitQuorumRulesOutRivals(approvals, observedCohortSize)`** — true when the commit's approve
  votes exceed half of `max(observedCohortSize, repairCorroborationClusterSize)`. The denominator is
  the declared full-cohort yardstick the repair side already resolves for the same shrunken-view
  trap, never `record.peers` (the enrolled subset, which is what a downsize shrinks).
- **Solo short-circuit** (`peerCount <= 1`): arms only where the *declared* cohort is also one.
- **Consensus path**: `armFreshness` computed once from the record's approve-typed commit votes
  (`countApprovingCommitVotes`) and applied to the local-executed success, the local-fallback
  success, and `tolerateLocalCommitDivergence`.
- `clusterReachedCommitConsensus` (enrolled-subset majority — "did consensus complete") untouched in
  meaning; it now shares the vote-counting helper.
- Consult-side markings untouched: a consult that ran is exactly the evidence the window tracks.

The commit itself still succeeds either way; only the freshness stamp is withheld.

## Validation

- `packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts` — 9 cases, all observing the
  window through the read path (a consult fires or it does not).
- `yarn workspace @optimystic/db-p2p typecheck` — clean. `yarn lint` — clean.
  `node scripts/check-doc-citations.mjs` — clean.
- `yarn workspace @optimystic/db-p2p test` — **2567 passing, 49 pending, 0 failing**.
- `yarn test` (all workspaces) — **0 failing** (1594 + 2567 + 76 + 58 + 53 + 52 + 12 + 125 + 705 +
  6 + 258 passing).

## Review findings

Method: read the implement-stage diff (`git show 79d4c5b9`) before the handoff summary, then the
other sites that arm or decline to arm the same window, then the docs that describe it, then ran
lint, doc-citation lint, typecheck, and the full workspace suite.

### Fixed in this pass (minor)

- **The safety argument was overstated.** `commitQuorumRulesOutRivals`'s comment claimed a
  full-cohort majority rules out *any* rival commit. It does not: `clusterReachedCommitConsensus`
  accepts an **enrolled-subset** majority, so a rival coordinating on a shrunken cohort view needs
  no full-cohort majority at all and the two quorums can be disjoint. The intersection argument only
  covers rivals that *also* reached a full-cohort majority; the disjoint case is a fork, which is
  `docs/partition-healing.md`'s business. Comment rewritten to scope the claim and name the gap
  rather than imply it does not exist. Behaviour unchanged — the gate is still the right one; only
  its stated guarantee was too strong.
- **The solo-branch comment was wrong for one corner.** It said degraded routing (`peerCount 0`)
  never arms; with a declared cohort size of 1 it *does* arm — correctly, since a replication factor
  of one admits no rivals. Reworded to key on the declared size, which is what the predicate
  actually tests.
- **Duplicated vote counting.** `clusterReachedCommitConsensus` re-implemented the approve-count
  filter the new `countApprovingCommitVotes` provides. Now calls it.
- **A test gap the handoff did not know it had.** The handoff claimed both tolerated-divergence
  shapes were covered; both specs actually drove the *throw* shape. The **returned**
  `success:false` / `missing-base-revision` shape — a separate branch guarded by
  `isMissingBaseRevisionFailure` — was uncovered, so a dropped flag there would not have failed a
  test. Added a spec for it (the arming case, which fails if the flag is dropped *or* if the reason
  string stops matching). Suite now 2567.
- **Docs were stale.** `docs/transactions.md` § *Lazy read-repair window* enumerates everything that
  arms the window (the solo exit) and everything that deliberately does not (an empty cohort), and
  never mentioned the commit side at all — before or after this change. Added the new rule, the
  reason the full-cohort bar is what makes the stamp mean anything, and the operator-visible cost
  for an undeclared deployment. No other doc describes this window; `docs/internals.md`'s freshness
  passage is about the doubt marker, which this change does not touch, and was verified correct
  as-is.

### Filed (major)

- **`backlog/bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read`** (`repro: verified`).
  The read path's "nothing corroborated" exit deliberately does not arm the window — right for a
  transient failure, wrong for a **provably permanent** one. An undeclared deployment whose real
  cohort is two machines can never reach the two-corroborator floor (the floor is measured against
  the declared size, which defaults to the replication factor of 10), so that exit repeats a
  hopeless check on every read, forever. The code already computes the "this can never succeed"
  verdict for its `cluster-fetch:repair-deadlock` log line and throws it away.
  Measured with a scratch probe (run, measured, deleted): local peer plus one remote, no declared
  size, three reads inside one 10 s window → **6 peer queries**; the same probe with
  `clusterSize: 2` declared → **0**. Cohorts of three or more are unaffected.
  This defect is older than this ticket — it always affected records a node only ever *read*. What
  this ticket changed is that a node's own writes no longer paper over it for records it writes,
  which is the whole point of the change and must not be reverted to hide the symptom.
  Filed at the class level, not the instance: whether a machine re-asks its cohort is decided at
  five separate sites in one file, each arguing its case in prose, with no shared statement of the
  rule they approximate ("arm exactly when re-asking sooner could not learn anything").

### Put to a human (decision, not work)

- **`blocked/two-machine-groups-supported-or-not`.** The accepted-tradeoff `NOTE:` at the
  `cluster-fetch:local-current` arm names its own revisit condition — "if two-member cohorts become
  a supported production topology rather than a dev convenience". That condition has arguably
  tripped (the reporting deployment runs two-machine groups; `docs/transactions.md` documents the
  setting such a deployment needs, which reads like support). Per the accepted-tradeoff rule this
  is not re-filed as a finding: the remedy it names is in direct tension with the backlog bug above
  — applying both naively gives a two-machine deployment a network round trip on every read — so
  the supported-or-not question has to be answered first, and only a maintainer can answer it.

### Recorded as a tripwire (not a ticket)

- One `armFreshness` verdict covers every block in a multi-block commit although it is measured
  against `blockIds[0]`'s cohort alone. Consistent with the rest of the path (consensus for the
  whole commit already runs on that one cohort), so a per-block verdict would measure a quorum that
  never voted. `NOTE:` at the site pointing at
  `debt-sender-side-coordinating-block-binding-is-unchecked` for the day per-block cohorts are
  coordinated separately.

### Evidence appended to an existing ticket

- `backlog/debt-freshness-state-scattered-across-coordinator-repo` — tenth measurement: **2270
  lines**, plus a note that the freshness answer now has to be assembled from the write path as well
  as the read path, with the five-site gap above as its concrete consequence.

### Checked, nothing found

- **Every `markBlocksSeen` call site** re-derived from scratch: the three consult-side ones still
  arm, and each still has a correct reason for doing so; the solo-self-skip arm the prereq ticket
  added is intact and its spec still passes, so the GitHub-issue-#8 consult storm does not return.
- **Error handling** — the gate never changes a commit's success or failure, only the stamp;
  verified at all four gated sites.
- **Type safety** — no `any` introduced; the fourth parameter on `tolerateLocalCommitDivergence` is
  typed. A positional boolean is a mild smell, but it is a private method with a doc comment
  explaining the argument, and threading a wrapper object for one flag would be worse. Left.
- **Performance** — the predicate is `O(commit votes)`, computed once per commit; nothing added to
  the read path.
- **Resource cleanup** — no new resources, timers, or subscriptions.
- **Source hygiene** — `coordinator-repo.ts` is 2270 lines and the new predicate's doc comment is
  long for a two-line function, but it carries a genuinely subtle safety argument and matches the
  density of every neighbouring member. Trimmed where it was redundant, not to a target line count.
  The size complaint itself is already tracked (see the appended measurement above); no new size
  ticket.
- **Pre-existing test failures** — none. Nothing was skipped, disabled, or loosened.

### Not verified, and why

- **The downstream end-to-end scenario.** The implement stage found that the Sereus integration
  reproducer (`control-cohort-edge-carries-data.integration.ts`, in a separate repository that
  symlinks these packages) fails about 12 s in, at a step *before* the stale-serve gate this ticket
  targets, with `Block default/Revocation is unavailable (cohort-unreachable)` — and verified it
  fails identically against a baseline build without this change. Not re-run here: it is outside
  this repository, the failing step is upstream of the behaviour under review, and the path it fails
  on (a locally-missing block with an unreachable cohort) bypasses the freshness window entirely.
  The fix therefore remains verified at the unit seam only, which is stated here rather than
  glossed.
- **Fork-ahead readers** stay invisible once the consult fires: a reader numerically ahead of its
  cohort's lineage still reads `cluster-fetch:local-current` and re-arms. Known and out of scope —
  `backlog/debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` owns it.
