----
description: A deployment that runs fewer machines than its configured replication factor can never repair a missing block, and today it finds that out only by reading a decline log line that does not name the setting responsible. An embedder read the documentation, drew the wrong conclusion, and shipped a two-machine product whose nodes could never heal each other. Say so at startup, and name the knob at the decline.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, docs/transactions.md
difficulty: easy
----

# Warn when the repair corroboration floor cannot be met by the cohort that exists

## The trap, as actually sprung

`clusterPolicy.assumedClusterSize` feeds two consumers with **opposite** unconfigured defaults
(documented at length in `cluster/cluster-policy.ts`):

- membership admission gate → defaults to `minAbsoluteClusterSize` (2)
- repair corroboration floor → defaults to **`clusterSize`**, the replication factor

The sereus embedder set `clusterSize: 16` for its control network and left `assumedClusterSize`
unset, recording in its own source comment:

> `assumedClusterSize` is deliberately left at Optimystic's default of 2 (a party may genuinely run
> two nodes).

That is true of the admission gate and false of the repair floor. With `clusterSize: 16`,
`corroboratorCapacity(cohortPeerCount, 16)` is `max(peers, 15)`, so the floor of two binds; a
two-node party has exactly one peer other than the reader, the quorum can never be met, and **every**
read-repair and reconcile declines — permanently, silently, on a product whose headline capability is
multi-machine operation. Setting `assumedClusterSize: 2` fixes it and is a no-op for the admission
gate, since 2 is already that consumer's default.

Nothing was wrong with the code. The failure was entirely in how discoverable the consequence is.

## What to add

1. **A startup warning.** At `resolveClusterPolicy`, when `assumedClusterSize` is absent and
   `clusterSize > minAbsoluteClusterSize`, log once at warn level: this node will require
   `CORROBORATION_FLOOR` distinct peers to repair a block, a cohort smaller than that cannot heal
   itself, and `clusterPolicy.assumedClusterSize` is the fix — stating that declaring it does not
   shrink the replication factor. One line, at construction, naming both numbers.
2. **Name the knob at the decline.** `cluster-fetch:no-quorum`, `reconcile:no-rev-quorum`, and
   `reconcile:no-content-quorum` should carry the resolved `repairCorroborationClusterSize`, the
   required quorum, and the responder count they actually got, so the log line itself says why.
   Today a reader sees only that it declined.

Do not change any default. The strict fallback is the researched decision
(`cluster/cluster-policy.ts` § "Why two size yardsticks, not one"); this ticket makes it legible,
not different.

## Edge cases & interactions

- The warning must fire once per node, not per repair — a per-attempt warn on a busy node is noise
  that gets filtered, which is how the current situation stays invisible.
- A node with `clusterSize: 16` that genuinely runs 16 peers is correctly configured and would still
  see the warning. Word it as "if you run fewer than N machines" rather than as a fault, or gate it
  on an observed cohort smaller than the floor at first repair.
- `feat-admission-floor-from-observed-cohort-high-water-mark` (backlog) would subsume the whole
  two-yardstick split. This ticket is deliberately the cheap interim; do not build that here.

## TODO

- [ ] Emit the one-time startup warning from `resolveClusterPolicy`.
- [ ] Add the resolved size, required quorum, and responder count to the three decline log sites.
- [ ] Add a test asserting the warning fires for `clusterSize > 2` with no `assumedClusterSize`, and
      does not fire when it is declared.
- [ ] Cross-link from `docs/transactions.md` § the two-node repair paragraph to the warning's text so
      the log line and the doc use the same words.
