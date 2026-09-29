description: When a node asks its cohort peers about a block, a hidden 3-second limit used to cut every request short, whatever per-peer time limit the deployment configured, so on links with a round trip near 3 seconds the node never confirmed a block with its cohort. The configured per-peer limit is now the only limit on those requests; review the change.
files:
  - packages/db-p2p/src/rpc-deadline.ts (`withinRequestBudget`, `RequestBudgetExceededError`, `REQUEST_BUDGET_EXCEEDED_ERROR_CODE`)
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `fetchArchiveFromPeer`)
  - packages/db-p2p/src/protocol-client.ts (`ProtocolClient.processMessage`: dial-phase abort now throws the caller's reason; `dial:aborted` / `response:aborted` log lines)
  - packages/db-p2p/src/libp2p-key-network.ts (`Libp2pKeyPeerNetwork.connect` docblock)
  - packages/db-p2p/src/network/open-protocol-stream.ts (`OpenProtocolStreamOptions.negotiateFully` doc)
  - packages/db-p2p/src/cohort-topic/stream-util.ts (module NOTE on `negotiateFully`)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.cohortQueryTimeoutMs` doc)
  - docs/transactions.md (§Read Consistency and Staleness: `cohortQueryTimeoutMs` row, "When to raise" paragraph)
  - docs/debugging.md (`protocol-client` namespace row, `silent` row, `noArchive` note)
  - packages/db-p2p/docs/cluster.md (`cohortQueryTimeoutMs` section)
  - packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts (premise spec from the fix stage; unchanged)
----
# The read-path consult's per-peer budget bounds the whole request

## What was wrong

`clusterPolicy.cohortQueryTimeoutMs` is the per-peer budget for the two read-path requests: the latest-revision consult (`clusterLatestCallback`, deadlined by `CoordinatorRepo.queryClusterForLatest`) and the archive fetch (`fetchArchiveFromPeer`). Both called `SyncClient.requestBlock` with no options, so `withRpcDeadlineDefaults` put a 3000 ms dial deadline and a 10000 ms response deadline underneath. Opening a stream costs one full round trip even on an open connection (`@libp2p/multistream-select@7.0.10` ignores `negotiateFully: false`; confirmed: the package source never reads the option), so above a 3 s round trip every consult failed at 3 s and a configured budget above 3000 never took effect. Sereus measured this: declines exactly 3.00–3.02 s apart at budgets of 5000 and 7000.

## What changed

- `withinRequestBudget(peer, protocol, budgetMs, request)` in `rpc-deadline.ts` runs one RPC with the budget as its only limit. It hands `request` the options `{ signal, dialTimeoutMs: 0, responseTimeoutMs: 0 }`, where an explicit `0` means "no cap" to `withRpcDeadlineDefaults` and `processMessage`. The signal comes from an `AbortController` plus an `unref`'d `setTimeout`, which works on Hermes. It aborts with a `RequestBudgetExceededError` naming the peer, the protocol and the budget, and the timer is cleared in a `finally`.
  - **Deviation from the ticket's letter:** the ticket asked for a helper that returns a disposer. It is a wrapper that disposes itself instead, so no caller can forget the cleanup. Both callers wanted exactly "run this one request under this budget".
- `clusterLatestCallback` runs `requestBlock` under `withinRequestBudget` with `consensusConfig.cohortQueryTimeoutMs`. That is the same resolved number the coordinator's `withDeadline` uses, because the coordinator factory is built from `...consensusConfig`. The coordinator's deadline still decides that a late peer is silent; the budget signal tears the stream down at the same moment instead of letting it run to the 10 s response default. The three-way contract is unchanged: every failure, the budget abort included, still rejects.
- `fetchArchiveFromPeer`: the `Promise.race` against a timer is gone. It uses the same wrapper, and a timeout rejects into the existing `catch` → `undefined`, so "a timed-out fetch resolves to no archive" still holds. Before this change the losing side of the race kept the stream open for up to 10 s; now it is aborted.
- `ProtocolClient.processMessage`: when the caller's `signal` aborted during the dial or stream negotiation (with no client dial timer of its own firing), the method now throws `signal.reason`, just as the read phase always has. Before, it rethrew whatever libp2p raised. It also logs `dial:aborted`, and on the read side `response:aborted` (the read side already threw the reason but logged nothing). **This applies to every `ProtocolClient` caller, not just the two above.** For example, `RepoClient`'s `'RepoClient timeout'` reason now surfaces from the dial phase as well. Libp2p mostly throws the signal's reason already (via `race-signal`), so the practical change should be small. Check it anyway.
- The three `negotiateFully` comments now say the option is accepted and ignored on this libp2p, so it currently saves nothing. It is still passed, and the premise spec is the tripwire if libp2p honours it again. The accepted tradeoff in `stream-util.ts` keeps its decision; only its premise was rewritten.
- Docs: the `transactions.md` row and paragraph, `cluster.md`, and the db-core field doc now say the field is the whole budget for each request and nothing inside it is shorter. They also say to size it for two round trips on a reused connection (negotiation plus the request). `transactions.md` adds that the field bounds only these two read-path requests, and that the other RPC clients keep their defaults. `debugging.md`: new log lines in the `protocol-client` row. The `silent` row gives the two-round-trip guidance and says what a fixed decline interval means. The `noArchive` note names the log lines that tell a dial failure from a budget expiry. `yarn lint:docs` is clean.

## Tests

None added, as the ticket specified. The premise spec pins the mechanism, and the change is wiring. The optional `RUN_LONG_TESTS=1` end-to-end spec (1600 ms one-way, showing `clusterLatestCallback` with a 7000 ms budget succeed where it used to fail at 3 s) was **not** written. A reviewer who wants proof at full scale should write it or ask sereus to re-run their measurement.

Validation run:

- `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`: clean.
- db-p2p `yarn test`: 3134 passing, 63 pending, 0 failing.
- db-p2p `yarn test:integration`: 44 passing, 2 pending.
- quereus-plugin-optimystic `yarn test`: 1001 passing, 13 pending. It was run because the `processMessage` abort change reaches every client.
- eslint on the changed source files: clean. `yarn lint:docs`: clean.

## Worth a reviewer's attention

- **Timer order.** The budget timer is created inside the callback before `withDeadline` creates its own, so the budget fires first. The stream-abort rejection usually settles before the coordinator's timer runs. Either way the peer counts as silent, and only the error text in the logs differs.
- **Writes on a slow link are still broken.** Cluster consensus, repo, dispute and pushes still dial under 3000 ms. That is `declared-link-round-trip-derives-every-dial-deadline` (in implement/, with this ticket as its prereq). Its derived default for an undeclared `cohortQueryTimeoutMs` reaches these two callers automatically through `consensusConfig`. Because `withinRequestBudget` passes explicit `0`s, the per-client fallback defaults that ticket introduces will not apply underneath these two calls, which is intended.
- **`RestorationCoordinator.queryPeer`** still calls `requestBlock` with no options. It has no budget of its own; the ticket above covers it.
- The `fetchArchiveFromPeer` NOTE about the consult and the archive fetch making the same request twice still stands. On a slow link that costs a second `cohortQueryTimeoutMs` per peer.
