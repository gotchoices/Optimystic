description: A local read of rows a node already holds can block for a full per-peer consult budget (about 7 s) when another cohort member is connected but not answering, such as a phone frozen in the background.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (the once-per-`readRepairWindowMs` cohort consult on the read path; `cohortQueryTimeoutMs`)
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, run under `withinRequestBudget`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveCohortQueryTimeoutMs`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the live read path refreshes before reading)
  - tickets/backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds.md (neighbouring question)
difficulty: medium

# A read does not wait on a connected but silent member

GitHub issue #25: https://github.com/gotchoices/Optimystic/issues/25

## Measured (from the issue)

Two Node processes, relay only (sereus 1.9.0, optimystic 1.8.1). The host reads `select … from App.Message` every
2 s; the peer blocks its event loop 8 s of every 10 s but stays connected.

| window | median | p90 | max |
|---|---|---|---|
| peer healthy | 3 ms | 305 ms | 533 ms |
| peer stalled | 3 ms | 7003 ms | 7005 ms |
| peer offline | 2 ms | 3 ms | 150 ms |

Slow reads come in pairs about every 30 s; each is a `sync` "latest revision" request to the peer aborted at
`ms=7002`, after which the read returns rows it already held. An offline peer costs nothing because the dial fails
at once.

## What to decide

Since v1.8.0 a cohort member answers from its own copy inside the read-repair window, so this is the per-window
consult itself. Options the reporter raised:

- serve what is held and run the consult in the background (opt-in, e.g. `latencyHint: 'interactive'` per read or
  per node), keeping the floor and doubt machinery for its result;
- a shorter budget for the read-path consult than for a write's dial;
- document what sets the ~30 s rhythm and whether an app can tune it.

Any answer has to keep the fail-closed rules in docs/internals.md: a silent peer may be the sole holder.
