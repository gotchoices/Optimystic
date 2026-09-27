description: A re-attaching peer catches up about twice as slowly from a partial store as from an empty one. Each block it reads costs two extra link round trips, because the coordinator first consults the reader's own stale copy. Completion times also fall on repeated ~18 s steps.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (read-repair: `queryClusterForLatest`, `cluster-fetch:certified-selected`, `cluster-fetch:local-current`)
  - packages/db-p2p/src/sync (the sync-service request to the reader)
prereq: reattach-over-a-partial-replica-reads-absent
source: sereus-ec, from sereus's re-attach measurements for optimystic #22 (sereus tickets/blocked/report-reattach-over-partial-replica-to-optimystic.md)
----
# Catch-up from a stale replica is slower than from empty

## Report

The setup is the same as in `reattach-over-a-partial-replica-reads-absent`, with 900 ms one-way
latency.

| measure | from partial store (5 runs) | from empty store (7 runs) |
| --- | --- | --- |
| every table readable | 64–79 s | 39–57 s |
| A's new row readable on B | 140–162 s | 57–90 s |

Trace: B sends each block read to A as coordinator. A then consults B's stale copy first: a
sync-service request to B, followed by `cluster-fetch:certified-selected … claimants: 1` and
`cluster-fetch:local-current`. That is two link round trips per block, spent asking the reader what
it already has.

Completion times repeat across separate runs to within about 50 ms. Out of 12 runs, 38.7 s appeared
three times, and 56.9, 74.9 and 78.6 s twice each. The first steps are about 18 s apart, which looks
like a periodic timer deciding when a stalled read or sync moves on. This is a pattern, not a traced
timer. Candidates to check include `readRepairWindowMs` (10 s), the `RebalanceMonitor` debounce and
interval, `reconcilePassTimeoutMs` (max(5000, 5 × `cohortQueryTimeoutMs`) = 25 s here), and the
per-peer `cohortQueryTimeoutMs` (5 s).

## Questions for this stage

- When the reader is itself a cohort member, should the coordinator skip consulting the reader
  during read-repair? The reader's copy is exactly what the read is trying to get past.
- Which timer produces the ~18 s steps?

## TODO

- Reproduce with a latency-injected mesh and count round trips per block read, from partial vs empty.
- Identify the ~18 s step timer.
- Output implement ticket(s).
