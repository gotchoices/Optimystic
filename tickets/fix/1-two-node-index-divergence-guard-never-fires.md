description: Two machines each write a row and neither ever sees the other's. A previous investigation could not reproduce this on the mock mesh and instead landed guards meant to turn the divergence into a loud, named error — but on a real network it is still silent empty rows, so either the guards do not cover this path or the cause is somewhere else entirely.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema-manager.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/src/testing/mesh-harness.ts
difficulty: hard
repro: verified (in sereus, not here)
----

# The divergence guards land, and the real two-node case is still silent

## What is different from last time

`secondary-index-update-never-reaches-the-sibling` was worked at the **fix** stage on 2026-08-13
(log retained in `tickets/.logs/`). That stage did good work and reached an honest stopping point:

- It **corrected the reporting ticket's log reading** — the 3-block pend is all data-collection
  blocks for a first commit, and `NetworkTransactor.commit` legitimately splits the tail from the
  rest. Nothing was being dropped. The real symptom was stated more sharply: **the index collection
  is absent from the write transaction entirely.**
- It **could not reproduce**: eight two-node/two-Database shapes on the mock mesh all converged.
  "Trigger needs something the mock mesh lacks."
- It filed `1-index-maintenance-must-track-the-declared-index-set` and
  `1.5-schema-catalog-index-list-is-lossy`, both since completed, and said explicitly that they do
  **not** verify the reported symptom fixed — "what they guarantee is that the divergence becomes a
  named error instead of empty rows."

**That guarantee is the thing to test, and it is not holding.** Measured in sereus on 2026-08-22,
against this repo at `v0.24.2` with both those tickets landed, the failure is still a 30-second
timeout on empty rows with no error raised anywhere:

```
node A: after 30000ms its view of invite-concurrent-multi-… is missing approved joiners' rows.
node A holds 1 row(s) [7ynberR2…], count=1; node B holds 1 row(s) [4qDnbboQ…], count=1;
approved joiners: 7ynberR2…, 4qDnbboQ…
```

So the divergence is reached without any guard firing. Two possibilities, and separating them is
this ticket's first job:

1. The guards are correct but do not cover this path, so the loud error never gets a chance.
2. This is not the index-maintenance defect at all, and attributing it there has been wrong since
   2026-08-12.

**Read the shape before assuming (1).** Each node holds exactly **its own** row and neither sees the
other's. That is symmetric, and index blindness is not obviously symmetric — a node that never
maintained an index would fail to find *any* row through it, including one it wrote itself. A
mutual, symmetric non-convergence looks at least as much like the two collection *views* having
forked. This repo has prior art on that shape under
`relay-only-cohort-member-addresses-never-reach-siblings`, and sereus tracks the same suspicion in
its `forked-control-collection-sync-livelocks` and
`control-peer-row-refresh-invisible-to-third-node`. If the three turn out to be one defect, that is
a much better outcome than three.

## The reproducer, and why it is not here

`packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts` in
the sereus checkout. **All 3 cases, every run** — 2026-08-20, 2026-08-21 and twice on 2026-08-22.
Deterministic, which for a distributed convergence failure is a gift. (Case 3 fails only because
case 2 must run first; there are two real failures and one dependency.)

The shape the mock mesh lacked is worth naming: **two nodes on real libp2p transports, redeeming
the same invitation concurrently**, each writing a row to a table carrying a secondary index, with
the control cohort confirmed on both sides before the first write. The single most valuable thing
this ticket could produce, independent of any fix, is that shape as a test **in this repository** —
`packages/db-p2p/src/testing/mesh-harness.ts` is the closest existing scaffolding. The last attempt
stalled precisely because the defect only exists where the tests are not.

## Done means

Whichever of these the evidence supports:

- The guards from the two completed tickets fire on this path, and the failure becomes a named
  error rather than a timeout — **this alone is worth landing**, even before a fix, because it
  converts a silent wrong answer into a loud one.
- Or the attribution is refuted, and the sereus tickets get re-pointed at whatever this actually is.

Either way, report the conclusion back to sereus's `secondary-index-seek-blind-to-sibling-rows`,
which currently states this defect as established fact and has been carrying that attribution since
2026-08-12 on evidence the last investigation partly overturned.

---

## Appended 2026-08-24 from `stale-read-returned-as-authoritative-when-repair-cannot-converge`

That ticket asked the same question this one does — are these one defect? — and got far enough to
give you a **cheap, decisive check** before you spend time on the mock mesh again.

### The mechanism it found

Read-repair accepts a peer's claimed revision only when a quorum of distinct peers corroborates the
exact `(rev, actionId)`. The required number of corroborators is floored at 2, and that floor
relaxes only as far as `corroboratorCapacity(cohortPeersOtherThanMe, repairCorroborationClusterSize)`
in `packages/db-p2p/src/cluster/quorum-restore.ts`. `repairCorroborationClusterSize` falls back to
`clusterSize`, whose default is **10**.

So for a two-node deployment the outcome depends entirely on one setting:

- `clusterPolicy.assumedClusterSize: 2` (or an honest `clusterSize: 2`) declared → capacity 1, floor
  relaxes to 1, the lone peer's newer revision **is** adopted. Repair works.
- **Nothing declared** → capacity is `max(1, 9) = 9`, the floor stays 2, and a cohort with exactly
  one other peer **can never supply two corroborators**. Every repair pass declines, forever. Each
  node keeps its own revision and neither ever adopts the other's.

That second shape is a *symmetric*, permanent, silent non-convergence in which each node holds only
its own write — which is exactly the symptom reported here, and exactly the symmetry this ticket
noted did not look like index blindness.

### The check to run first

In the sereus node startup logs, look for:

- `cluster-policy` → `assumed-cluster-size-unset` (fires once per node construction whenever
  `assumedClusterSize` is undeclared and `clusterSize > 2`), and
- `coordinator-repo` → `cluster-fetch:no-quorum` with `responders: 1, required: 2`.

Both present ⇒ this is the same defect as the three-node ticket, seen at two nodes, and it is
**configuration-reachable**: set `clusterPolicy.assumedClusterSize` to the real node count and rerun
`strand-formation-concurrent-redemption.integration.ts`. If it converges, all three sereus tickets
(`secondary-index-seek-blind-to-sibling-rows`, `forked-control-collection-sync-livelocks`,
`control-peer-row-refresh-invisible-to-third-node`) collapse into one, and the index-maintenance
attribution is refuted rather than merely unproven.

If the advisory is absent (i.e. the size *is* declared) the mechanism does not apply at two nodes,
and this remains a separate defect — that is a useful result too, and it costs one grep.

### What is already known not to be the answer

The related claim that a stale read is returned silently is **fixed** — a read the coordinator
cannot confirm is current now throws `BlockPossiblyStaleError`
(`complete/coordinator-serves-stale-data-as-if-confirmed`, verified again during that
investigation). If sereus still sees silent empty rows rather than that error, the divergence is
*not* reaching the coordinator's freshness consult at all, which is itself a strong clue about
where to look.

