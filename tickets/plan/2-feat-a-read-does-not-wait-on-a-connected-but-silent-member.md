description: A local read of rows a node already holds can block for a full per-peer consult budget (about 7 s) when another cohort member is connected but not answering (GitHub #25), and on the first read after a restart it blocks the same way when a cohort member's dial hangs (GitHub #34, ~14 s to re-open a strand whose data is all local). Sereus ranks #34 and #25 second and third, after a data-loss bug; #34 is the user-visible React Native cold start.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (the once-per-`readRepairWindowMs` cohort consult on the read path; `cohortQueryTimeoutMs`)
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, run under `withinRequestBudget`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveCohortQueryTimeoutMs`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the live read path refreshes before reading)
  - tickets/backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds.md (neighbouring question)
difficulty: medium

# A read does not wait on a connected but silent member

GitHub issue #25: https://github.com/gotchoices/Optimystic/issues/25
GitHub issue #34: https://github.com/gotchoices/Optimystic/issues/34 (read its repro and experiment before planning)

## #34: the first read after a restart (reported on 1.12.1)

A phone-like node re-opening a strand whose blocks are **all in its own storage** waits on cohort consults. `CoordinatorRepo.get` awaits `readRepairBlock` for every block, and in `'lazy'` mode `shouldReadRepair` says yes for any block with no freshness stamp — every block on the first read after a restart, since the stamp is in memory. When the one other member's dial **hangs** (SYN dropped behind NAT, or a port that moved on the other node's restart) rather than being refused, each consult waits out the cohort-query budget (~7 s, ~6 s at `linkRoundTripMs` 1000), and opening the strand (`hydrateCatalog` → `listTables` on `tree://optimystic/schema`) hits two in sequence:

| Re-open, data all local | dial refused | dial hangs |
|---|---|---|
| other node down | 0.09 s | 14.05 s |
| other node restarted (ports changed) | 0.13 s | 14.05 s |

Reporter's experiment: serving a **present** block at once and running its repair in the background (only a **missing** block waits) took both slow cases to ~0.06 s, every other case unchanged. On an Android emulator the health app's catalog hydrate spent 10.5–11.4 s in this wait, JS thread idle. Smaller related finding: with 20 ms per storage call and the other node reachable, the first table scan after re-open took 4.3 s (one consult per first read of each block) vs 0.12 s never-paired.

The reporter's two directions: (a) in `'lazy'` mode serve a present block immediately and repair in the background, awaiting the consult only for a missing block, where the absence verdict depends on it; (b) a much shorter budget for a peer with no live connection whose dial has not completed.

## Planning notes (from the gardener)

- #34 and #25 are one change: a **present** block's read should not wait on the consult. Fix them together.
- Inside the read-repair window a cohort member already serves its own copy without consulting (docs/transactions.md § Lazy read-repair window). Treating the first read after restart, and the per-window consult, the same way — serve now, consult in the background, apply what the consult learns (repair, floor, `unconfirmedAheadRev` memo) to the next read — keeps the staleness bound the window already accepts. Writes stay safe through optimistic concurrency: a write computed on stale content is refused and retried.
- What must still block: a **missing** block (the fail-closed absence rules), and a read carrying a floor above the local revision (`floorDemandsConsult`) — the asker has proof the local copy is too old.
- Check the `unconfirmedAheadRev` memo: a background consult that records a claim must stamp later reads, as today.
- If you conclude any of this changes a documented guarantee in a way a maintainer must approve, route that question to `blocked/` with proposed text and plan the rest.

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
