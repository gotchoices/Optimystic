description: The debugging guide now has a section explaining how to read log fields that already say which of several very different situations a log line describes, written after a misread log nearly led to a false bug report.
files:
  - docs/debugging.md (new section `## Reading the fields that tell you which case a line is`, before `## Common DEBUG patterns`; a pointer on the `coordinator-repo` row of the db-p2p namespace table)
  - tickets/backlog/bug-abandoned-commit-retry-never-releases-its-transaction.md (filed during implement)
  - packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts (the code the section describes; not changed)
----
# Document the log fields that say which case a line is

Documentation only. `docs/debugging.md` gained one section with an entry per log event: `cluster-tx:read-repair-triggered` (with the GitHub issue #8 worked example, crediting `risavian`), `coordinator-repo:pend-cluster-complete`, `coordinator-repo:commit-stale-classify-own-action`, `coordinator-repo:commit-local-refusal-tolerated`, `cluster-member:admission-reject`, `cluster-fetch:no-quorum` together with `reconcile:no-rev-quorum`, `cluster-tx:complete`, and `cluster-tx:small-cluster-no-confident-estimate`. Events already documented elsewhere are linked, not repeated.

While verifying `cluster-tx:complete`, the implementer found that a commit retry that runs out of attempts never releases its transaction entry. That is filed as `bug-abandoned-commit-retry-never-releases-its-transaction` (backlog, `repro: static`), and the doc names it by slug.

## Review findings

Every claim in the new section was checked against the code it cites. For each event that meant reading the code that writes the log line: `get` / `shouldReadRepair` / `ageMs` / `fetchBlockFromCluster` / `queryClusterForLatest` / `classifyRepairDeadlock` / `pendThroughCluster` / `commit` / `confirmCommitRivalAgainstLocal` in coordinator-repo.ts; `executeClusterTransaction`'s `finally` / `validateSmallCluster` / `scheduleCommitRetry` / `retryCommits` / `clearRetry` in cluster-coordinator.ts; `admitMembership` and `deriveExpectedClusterView` in cluster-repo.ts; `createReconcileBlock` / `fetchAnswer` in reconcile-block.ts; `fetchArchiveFromPeer` in libp2p-node-base.ts; `quorumSize` / `corroboratorCapacity` in quorum-restore.ts.

**Fixed in this pass (minor):**
- **Wrong override rule in `pend-cluster-complete`.** The doc said a non-empty `cohortRefusals` "never overrides a local `conflict` or `fault`". In `pendThroughCluster`, a tolerated local fault (`localExecuted: true`, `localVerdict: 'fault'`) falls through to the success answer, which `answerWithCohortRefusal` *does* override (the code comment says so explicitly: "a sibling's refusal is not lost just because this node also had local trouble"). Only a local conflict, or a refused fallback pend, reaches the writer untouched. The sentence now says this, and says that `pend-remote-refusal` follows `pend-local-fault-tolerated` in that case.
- **Imprecise stamping summary.** The read-repair background paragraph said the window is stamped by "a consult the cohort answered". `cluster-fetch:solo-self-skip` stamps without anyone answering, and the doc's own later paragraph lists it as a stamping outcome. The summary now says "a consult that settled the block (including the no-op consult on a node that is its block's whole cohort)".

**Verified correct (no change):**
- The `lazy` table row for `ageMs` at or below the window carries both qualifiers (the mode, and `readRepairSampleRate` at `0`), and a follow-up paragraph repeats them. Checked against `shouldReadRepair`.
- A missing `ageMs` is described as "never armed OR evicted" (`lastSeenCommitMs` is `LruMap(1000)`), never as proof the window was never armed.
- `localRev` is always present on the trigger (the line needs `!isMissing`). "A `solo-self-skip` with no trigger before it means a block this node does not hold" also holds: `get` is the only caller of `fetchBlockFromCluster`, and it logs the trigger before the consult for every held block; in `off` mode, held blocks never consult at all.
- Which outcomes stamp the window (solo-self-skip, local-current, synced, not-restored, the `cohort-too-small` decline) and which do not (other declines, an empty cohort lookup) match `fetchBlockFromCluster`.
- The `no-quorum` table: the "cohort too small" row compares `cohortPeers` against the logged `required` (sized from `holders`), while `classifyRepairDeadlock` compares against the quorum a fully answering cohort would need. With `simpleMajorityThreshold` at or below 1 both reduce to `cohortPeers < CORROBORATION_FLOOR`, so the two agree. `holders + absent + silent = cohortPeers` holds by construction.
- The `reconcile:no-rev-quorum` note on `noArchive` and `fetchErrors` matches `fetchArchiveFromPeer`, which returns `undefined` on every failure and on its own one-second timeout, and never throws.
- `admission-reject`: all six reasons, the three readings of `confidence`, and `self-not-member` staying enforced under `allowUnvalidatedSmallCluster`.
- `cluster-tx:complete` runs in a `finally`; `transactions.delete` appears only in that `finally` (skipped when a retry is pending) and in `clearRetry`; the `retry-abort` path calls neither. So the backlog bug holds up. With the defaults (250 ms first interval, backoff ×2, 5 attempts) the budget is about 7.75 s, which matches the ticket's "about 8 s".
- `small-cluster-no-confident-estimate` and its `admit` follow-ups match `validateSmallCluster` and `executeTransaction`.

**Major:** none. The only defect found in code (the retry leak) was already filed during implement, and no open ticket (other than that one) claims `scheduleCommitRetry`. Two open tickets also touch `docs/debugging.md` (`bug-cohort-topic-debug-namespaces-are-documented-but-not-emitted`, `enable-optimystic-logging-on-every-debug-copy`), but different parts of it, so nothing conflicts.

**Considered and declined:** no test ties the fields these log lines print to what this section says. This review did not file a `debt-` ticket for one: it would take eight capture specs to pin log shapes that change rarely, which is out of proportion to a docs change. The doc cites every event's source by symbol anchor, so `yarn lint:docs` fails if a cited function is renamed or removed. What it cannot catch is a field renamed inside a line. If that drift is ever observed, the right fix is one spec per event using `test/support/capture-log.ts`.

**Tripwire:** the `cluster-tx:complete` entry says that after `retry-abort` the entry is never removed, and names the backlog bug by slug. That backlog ticket already lists `docs/debugging.md` in its `files:` and says to update the sentence when fixed, so no extra `NOTE:` was added.

**Not changed:** the new section is one paragraph per line, while the older text in `docs/debugging.md` is hard-wrapped. The rendered output is identical, and `yarn unwrap:md` was not run over the whole file, to keep this diff scoped.

**Validation:** `yarn lint:docs` passes (45 documents, 96 anchored citations, 593 file mentions, 338 links). `packages/db-p2p/test/logger.spec.ts` passes (29), including the namespace-table guards. The full db-p2p suite was not run: no source changed, and `logger.spec.ts` is the only spec that reads `docs/debugging.md`.
