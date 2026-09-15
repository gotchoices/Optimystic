description: A new end-to-end test drives the ordinary growth path of a small deployment over real network connections: one machine writes alone and restarts, a second joins as its backup, one is away for a while, and both restart. Review the test, a small timer-leak fix it exposed, and what it observed about writes made while one of two machines is away.
files:
  - packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts (new)
  - packages/db-p2p/src/cluster/block-transfer.ts (`withTimeout` now clears its timer)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`NOTE:` tripwire in `handleTopologyChange`, comment only)
  - docs/architecture.md (§ Supported deployment sizes: one paragraph pointing at the spec)
  - tickets/backlog/more-design/6.5-partition-healing.md (new arm: what phase 5 observed)
  - tickets/backlog/debt-node-factory-wiring-steps-own-their-teardown.md (update: which half of its second arm the spec now covers)
difficulty: medium
----

# What was built

`small-deployment-lifecycle.integration.spec.ts` runs two real libp2p nodes over loopback TCP. Each has a stable Ed25519 key and its own `MemoryRawStorage`, and both outlive every restart of that machine. Rows are written into one Tree collection through `NetworkTransactor`. The spec is gated on `OPTIMYSTIC_INTEGRATION=1`, so it runs in `yarn test:integration` and `yarn check`; without the variable it reports 6 pending.

- **Phase 1, solo.** A starts with no peers or bootstrap, writes three rows, and reads them back.
- **Phase 2, solo restart.** A stops and starts over the same key and storage, reads every row, and writes one more.
- **Phase 3, add a backup.** B joins, bootstrapped to A. The spec lists every block A holds a committed revision of, straight from A's storage via `listBlockIds`. It then waits (90s bound) until B's own storage holds each of those blocks at that revision or later; on timeout the message names each missing block and revision. Then A stops and B reads every row.
- **Phase 4, both write.** A restarts; each node writes two rows and reads the other's.
- **Phase 5, one away.** B stops and A writes one row. The spec records whether that write was acknowledged or refused, and when refused, whether the refused row shows up later. B restarts. Every acknowledged row must then read correctly on both nodes, which covers B's own pre-stop rows.
- **Phase 6, both restart.** Both stop and start over their storage. Every acknowledged row must read on each node; one new write from each must read on the other.

Structure: six `it`s over shared state rather than one long `it`, so the reporter names the phase that broke. A phase whose predecessor failed throws at once, naming that phase, instead of running on broken state. It deliberately does not `this.skip()`, which would read as pending and look green. `after` stops both nodes with `Promise.allSettled`, including after a mid-phase failure. The spec contains no layout-dependent skip.

# Configuration and the choices made

- **Only the documented two-machine setting.** The spec sets `clusterPolicy: { repairCorroborationClusterSize: 2 }` and leaves everything else at its default: cluster size 10, FRET profile, rebalance timings. It does not use `clusterSize: 2`. No scan-interval override was needed: phase 3 completes in 10.2–10.5s with the default 5-second rebalance debounce.
- **A is declared from its first start.** One exploratory run started A undeclared in phases 1 and 2 (and still undeclared when B joined), and every phase came out the same. Nothing in this sequence asks A to repair proof-less data from B, since A is the source of everything B learns in phases 1–3, so A's declaration never comes into play here.
- **Restarts use a fresh port.** A restarted node starts with an empty in-memory peer store, so it cannot find its partner by peer id. It dials the partner's current address through `bootstrapNodes`, as a host application that enrolled the backup would. The surviving node learns the new address through identify. Same-port restart is never attempted, so the OS port-release race does not arise.
- **Reads open a fresh transactor and tree** (`Tree.open`) every time, so no staged or cached state from an earlier write can answer. In phases 4–6 a read on one node may be served by the other; only phase 3 proves a copy is stored locally.

# Observed behaviour in phase 5 (reported, not asserted)

Across 16 full runs (15 runs of the spec as written or an earlier draft, plus the undeclared variant):

- **Acknowledged 11 times, after 11–31s.** A debug log shows A retrying against the stopped B until A's routing view dropped B. The write then committed as `commit:solo-cohort` with `cohortSize: 1, soleIsSelf: true` and returned plain success, so the row was held by A alone until B returned.
- **Refused 5 times, after 8–12s,** with `Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)`. In the two refused runs of the final spec, the refused row stayed absent on both nodes after B returned, so no refused write landed anyway.
- **Which of the two happens is a timing race, not a rule.** It depends on whether A still counts B as a cohort member when the write reaches the commit step. This is recorded as a new arm on `tickets/backlog/more-design/6.5-partition-healing.md`, the design home the ticket named. The acknowledged-but-held-by-one-machine half is also the situation `commit-result-carries-durability-class` (in `plan/`) describes; the reviewer may want to cite this spec there.
- **The invariant held in every run:** every acknowledged write was readable on both nodes once both were up.

# Runtime and repeat results

- **Final spec, 5 consecutive runs: 5/5 passing.** Mocha reported 25–46s and processes took 32–53s wall-clock. About 4.6s of that is process startup, measured with the spec gated off. Phase 5 dominates at 11–32s, phase 3 takes about 10.5s, and phases 1, 2, 4 and 6 together take under 4s.
- **Earlier drafts: 11 more full runs, all passing.** The only later change was how phase 5 reports its outcome.
- **Rest of the gate:** db-p2p unit suite (`test/**/*.spec.ts`, integration specs skipped) 2708 passing, 56 pending; `yarn build` (db-p2p) clean; root `yarn lint` clean; `yarn lint:docs` clean. The `rebalance-monitor.ts` comment was added after that build, and the db-p2p `yarn typecheck` was re-run afterwards.
- **No `fix/` tickets were filed:** no phase failed in any run.

# Timer-leak fix, outside the ticket's listed files (please scrutinize)

Before this fix, every spec process stayed alive 12–32s after mocha finished. An async-hooks trace after both nodes had stopped found 18 referenced 30-second timers, all created by `BlockTransferCoordinator.withTimeout` in `packages/db-p2p/src/cluster/block-transfer.ts`. That helper raced each pull, push and confirm against a `setTimeout` it never cleared, so every transfer left a timer running for the full transfer timeout. It now clears the timer when the race settles, using the same idiom as `withDeadline` in `repo/coordinator-repo.ts`. After the fix the process exits about 2s after mocha finishes. No sockets outlived teardown, before or after. No unit test pins the clearing; the existing block-transfer and rebalance-reaction specs pass. A fake-timer test would pin it, if the measurement above is not enough.

# Findings parked rather than ticketed

- **Tripwire:** a `NOTE:` in `RebalanceMonitor.handleTopologyChange`. The join check samples FRET's cohort once, 5s after the last connection event. If FRET has not admitted a new backup by then, the backup is never reported as newly co-responsible, and nothing re-checks until an unrelated connection event. Loopback was always in time (16/16). The relay variant, `implement/2.5-two-phones-over-a-relay-transact-and-replicate`, is where a slower admission could first show.
- **Update on `debt-node-factory-wiring-steps-own-their-teardown`:** phase 3 now covers the rebalance reaction's dispatch (removing it would leave B without A's blocks, by inspection). It does not cover the growth-feedback line (`recordGrowthOutcome`): removing that still passes.

# Known gaps

- **Phase 5 checks reachability, not local storage.** It asserts that B can read A's away-write after returning, not that B holds a copy. Today's growth arm tracks cohort membership changes, not writes a returning peer missed, so any copy B gets comes from read repair or read-through. The under-replication ledger in `commit-result-carries-durability-class` is the work that would change this.
- **Narrow write shapes.** Each row is its own `Tree.replace` action. There are no multi-row actions, no deletes, and no simultaneous writes from both nodes.
- **Not covered:** relay and phone transports. The sibling relay ticket builds on this spec and plans to extract its helpers into `test/util/`.

Logs for reference, git-ignored and pruned by the runner:

- `tickets/.logs/small-deployment-lifecycle.debug.log`: a refused phase 5 under `DEBUG=optimystic:*`.
- `small-deployment-lifecycle.undeclared.log`: an acknowledged phase 5 under DEBUG, with A undeclared.
- `small-deployment-lifecycle.final-repeat.log` and `small-deployment-lifecycle.unit.log`.
