description: A node that keeps writing a shared table never re-checks whether its copy is current, because its own writes are counted as proof of freshness — so when another machine's update lands on a quorum that excludes it, it serves the old data forever. Make a write count as freshness proof only when its quorum was large enough to rule rivals out.
prereq: solo-node-read-repair-never-settles
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts, packages/db-core/src/collection/collection.ts (context only — no change), packages/db-core/src/transactor/transactor-source.ts (context only — no change)
difficulty: hard
repro: verified
----

# Self-referential freshness: a node's own commits suppress the staleness check forever

Supersedes `fix/1-a-reader-cannot-tell-its-view-stopped-advancing` (research complete; this
ticket carries the traced cause and the fix specification).

## The traced mechanism (why 156 reads, 0 consults, 0 flags)

The reader-side machinery for discovering staleness already exists and is layered correctly:

1. `Collection` data reads are pinned to the held revision and cache-served — by design.
   The ONE seam where a lagging collection learns a newer revision exists is the **unpinned
   log-tail read** in `Collection.bootstrapContext` (collection.ts:1111), which runs inside
   every `update()` / `updateAndSync()`. The Quereus plugin runs `tree.update()` before every
   live scan, so this seam fires on **every SQL read** — 156 times in the Sereus measurement.
2. That unpinned read lands in `CoordinatorRepo.get` (coordinator-repo.ts:632). For a
   locally-present block it consults the cohort only when `shouldReadRepair` (line 860) says
   the lazy window lapsed: `now - lastSeenCommitMs > readRepairWindowMs` (10 s default,
   sample rate defaults 0).
3. When the consult DOES run, everything downstream works: `fetchBlockFromCluster` →
   certified single-signer claims accepted → `restoreCorroborated` converges, or an unsettled
   claim is memoed and `flagUnconfirmedCurrency` stamps `unconfirmedAheadRev`, which
   `TransactorSource.tryGet` / `bootstrapContext` escalate to `BlockPossiblyStaleError`.
   The upstream Sereus run shows this chain working on other blocks in the same boot.

The defect is the **gate**: `markBlocksSeen` (line 881) — the only thing that arms the lazy
window — is called unconditionally on every successful commit this node coordinates:

- line 1961 — the solo short-circuit (`peerCount <= 1`, which also swallows degraded routing);
- line 2005 — consensus path, local member executed;
- line 2034 — consensus path, local commit after consensus;
- line 2188 — `tolerateLocalCommitDivergence` (cluster succeeded, local apply failed).

So a node that keeps writing a collection re-arms the window on that collection's log tail
(and any tree blocks its commits touch — in a small control table, the same root/leaf every
row lives in) more often than the window can lapse. The staleness seam is then served from
local storage as authoritative-current on every `update()`, indefinitely. In the Sereus trio,
node B's periodic self-registration writes to the `CadrePeer` collection did exactly this
while node C's newer commits landed on a quorum that excluded B: B measured 45 s / 156
identical stale reads with **zero** `read-repair-triggered` and zero flags — matching this
gate, and only this gate, staying closed.

Why this is wrong in principle: a commit is evidence of freshness **only when its quorum
must intersect any rival commit's quorum** (a majority of the full cohort). Then no rival
can have moved past this node without this node hearing about it. A commit on a downsized
quorum — the solo branch, or a consensus record that enrolled fewer than a full-cohort
majority — proves nothing about rivals, and the reporting deployment (2-member cohorts,
permissive control writes) commits on downsized quorums routinely. That is precisely when
forks happen, and precisely when the code stops checking.

## Fix specification

Arm the lazy read-repair window from a commit **only when the commit's approvals form a
majority of the full cohort**; otherwise leave the window alone so the next read past the
window consults the cohort as if the commit had not happened.

- **Denominator** — the full cohort size, not the enrolled/reachable subset:
  `max(cohortPeerIds.length, <declared cluster size>)`. The class already resolves a declared
  yardstick for exactly this trap on the repair side (`repairCorroborationClusterSize`,
  line 494, resolved from `assumedClusterSize` — see the long rationale at line 384). Reuse
  that resolution or mirror it; do NOT use `Object.keys(record.peers).length` as the
  denominator — `record.peers` is the enrolled subset, which is the thing that can be
  downsized (compare `clusterReachedCommitConsensus`, line 2194, which has this weaker shape
  for a different purpose — leave it as is).
- **Numerator** — approve-typed commit signatures on the consensus `record` (as in
  `clusterReachedCommitConsensus`). For the solo branch (line 1961) the numerator is 1, so it
  arms only when the declared/observed cohort is also 1 — a genuine cohort-of-one.
- Apply the same rule at all four commit-side `markBlocksSeen` sites. The commit itself still
  succeeds and still returns success — only the freshness stamp is withheld.
- **Do not touch** the consult-side markings (lines 981, 1019, and the solo-self-skip arm the
  prereq ticket adds): a consult that ran IS the evidence the window exists to track, and the
  failed-convergence case at 1019 deliberately damps repair effort while
  `unsettledAheadClaims` keeps the doubt alive.

### Why the prereq matters

`fix/1-solo-node-read-repair-never-settles` (same board, same file) makes the
`cluster-fetch:solo-self-skip` exit arm the window. Without it, this change makes a genuine
solo node consult on **every** read of every actively-written block (its commits no longer
arm, and its solo-skip consults never did) — re-amplifying the GitHub-issue-#8 read-repair
storm that ticket exists to end. With it, a solo node pays one `findCluster` per block per
window, and re-verifying "I am still the sole responsible peer" each window is exactly the
right evidence. If that ticket lands under a different slug, the dependency is on that
behavior, not the slug — verify the solo-skip exit arms the window before landing this.

### Cost

A node committing on a downsized quorum pays one cohort consult per touched block per
`readRepairWindowMs` (10 s) on its read path. That cost is confined to the deployments and
moments where rival quorums are actually possible, which is the trade the original ticket
asked to be made deliberately. Discovery latency for a stalled view is bounded by the window
plus one consult round trip (the Sereus gate allows 45 s).

## Expected downstream effect

Once the window can lapse, B's next `update()` tail read consults, the cohort's certified
claim surfaces C's newer revision, and either the tail restores and the collection advances
(log entries then clear the affected cache blocks, and the same fix lets the tree blocks'
own consults fire as their windows lapse), or the claim stays unsettled and the read raises
`BlockPossiblyStaleError` instead of answering — both shapes the original ticket accepts.
The Sereus deterministic reproducer
(`npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts` in
`C:/projects/sereus/packages/integration-tests`, gate `bootControlTrio` step 6) should clear,
along with `forked-control-collection-sync-livelocks` (its loud sibling).

## Interactions / non-goals

- `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` (backlog): once the consult fires,
  a forked reader that is numerically AHEAD of the cohort's lineage still reads
  `cluster-fetch:local-current` and re-arms — the fork stays invisible. That comparison is
  that ticket's scope; do not widen this one. In the measured scenario the reader is
  numerically behind, so this fix suffices there.
- The NOTE at coordinator-repo.ts:973 (two-member cohort: a single corroborating voter can
  park the reader and re-arm the window each pass) names "two-member cohorts become a
  supported production topology" as its revisit condition. The reporting deployment is such
  a topology, so the condition has arguably tripped — but the parking it allows is bounded
  by one window per pass and was not the measured mechanism. Leave the NOTE; mention it in
  the review handoff so a human can decide whether to promote it.
- `debt-freshness-state-scattered-across-coordinator-repo` (backlog): this change adds one
  more freshness rule to the same scattered state that ticket complains about. Keep the new
  predicate as one named helper (e.g. `commitQuorumRulesOutRivals(record, cohortSize)`) so
  the eventual consolidation can lift it whole.
- No change in db-core: `Collection`, `TransactorSource`, and the
  `unconfirmedAheadRev`/`BlockPossiblyStaleError` machinery are correct as-is; they were
  starved of input, not broken.

## TODO

- [ ] Add the quorum-intersection predicate (approvals > full-cohort/2, denominator per spec)
      as a named helper in coordinator-repo.ts with a comment stating the intersection
      argument.
- [ ] Gate the four commit-side `markBlocksSeen` calls (1961, 2005, 2034, 2188) on it.
- [ ] Verify the prereq's solo-self-skip arming is in place; if its ticket landed differently,
      add that arm here with a test.
- [ ] Unit tests (natural home: coordinator-repo-read-repair.spec.ts):
      solo commit with declared cluster size 2 does NOT arm the window (next in-window read
      consults); solo commit with genuine cohort-of-one DOES arm; consensus commit with
      full-cohort majority approvals arms; consensus commit whose record enrolled a minority
      of the full cohort does not arm.
- [ ] Regression: existing read-repair, trust, divergence, and solo-cohort specs stay green
      (`yarn workspace @optimystic/db-p2p test`, foreground, no redirection).
- [ ] Optional cross-repo verification if workspace linking permits: run the Sereus
      reproducer named above; otherwise note in the review handoff that downstream
      verification is pending.
