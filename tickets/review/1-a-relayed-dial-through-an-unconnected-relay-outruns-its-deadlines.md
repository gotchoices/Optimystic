description: When a node dials a peer through a relay it is not already connected to, it first has to open the connection to that relay, and on a slow link that did not fit in the time limits derived from the declared round trip. The limits are now sized for that case, and the plugin's overall write budget grows with them.
architecture: packages/db-p2p/readme.md
files:
  - packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `LinkDeadlines`, the round-trip multiples and the comment above them, `MAX_LINK_ROUND_TRIP_MS`)
  - packages/db-p2p/src/libp2p-node-base.ts (`connectionManager` block in `createLibp2pNodeBase`; `NodeOptions.connectionManager` and `NodeOptions.linkRoundTripMs` docs; read-path `NOTE:` above the consult's `withinRequestBudget` call)
  - packages/db-p2p/test/link-deadlines.spec.ts
  - packages/db-p2p/test/cold-relayed-dial-fits-the-address-limit.spec.ts (new)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`NetworkTransactor` `timeoutMs`, `abortOrCancelTimeoutMs` and their `NOTE:`s)
  - packages/reference-peer/src/cli.ts (`NetworkTransactor` construction)
  - packages/db-p2p/readme.md (*Slow relayed links* paragraph and table)
  - packages/db-p2p/docs/cluster.md (*Declaring the link instead*)
  - docs/optimystic.md (*Wire up a transactor* example)
  - tickets/fix/1.5-the-rpc-dial-deadline-cannot-be-set-per-node.md (appended a section on the shape left for it)
----
# A relayed dial through an unconnected relay outruns its deadlines — review handoff

## What changed

`resolveLinkDeadlines` now sizes every deadline that covers a connection open for the cold path (no connection to the relay yet), since libp2p takes one `addressDialTimeout` for every address and the circuit transport opens the relay connection inside it. Multiples of the declared round trip `r`, each still floored at the old constant, so an undeclared node is unchanged:

| `LinkDeadlines` field | Before | Now | At r = 3 s |
|---|---|---|---|
| `addressDialTimeoutMs` (libp2p `addressDialTimeout`) | `max(6000, 5 r)` | `max(6000, 10 r)` | 30 s |
| `libp2pDialTimeoutMs` (libp2p `dialTimeout`, new, split out of `connectionTimeoutMs`) | `max(10000, 5 r)` | `max(10000, 10 r)` | 30 s |
| `inboundUpgradeTimeoutMs` (libp2p `inboundUpgradeTimeout`, new, split out of `connectionTimeoutMs`) | `max(10000, 5 r)` | unchanged | 15 s |
| `dialTimeoutMs` (RPC dial) | `max(3000, 6 r)` | `max(3000, 11 r)` | 33 s |
| `transferTimeoutMs` | `max(30000, dial)` | unchanged formula | 33 s |
| `transactionTimeoutMs` (new) | — | `max(30000, 4 × dial)` | 132 s |
| response, cohort query | unchanged | unchanged | 10 s, 9 s |

`connectionTimeoutMs` is gone; `createLibp2pNodeBase` wires `dialTimeout` and `inboundUpgradeTimeout` to their own fields. Explicit `options.connectionManager.*` still wins.

## Deviations from the ticket's plan — check these

- **Transaction budget lives in `LinkDeadlines`, not in each host.** The plan had the plugin compute `Math.max(30_000, 3 * dialTimeoutMs)` itself. The reference peer and the `docs/optimystic.md` example needed the same number, so it is one derived field, `transactionTimeoutMs`, read by all three. The plugin falls back to `resolveLinkDeadlines()` (the undeclared values) for an injected node with no `linkDeadlines`.
- **Multiple is 4 dials, not 3.** `NetworkTransactor` stamps `expiration = now + timeoutMs` per operation (`pend`, `commit`, `get`), not per transaction. One pend where the first coordinator is dead costs a dial that runs out (11 r), the cold dial to the next coordinator (≤ 11 r), that coordinator's cold dial to a cohort member (≤ 11 r), and a few warm round trips for the consensus rounds: about 38 r. 3 dials (33 r) did not cover that. 4 dials (44 r) does.
- **The plan's cost claim was wrong, and is not repeated.** The plan said a dead writer would hold its pending records for the length of the budget. Storage pending records have no age bound at all (docs/repository.md, *A pending record's lifetime is bounded by its writer*), and the expiration does not touch them. What the budget does bound: how long a write against an unreachable cohort takes to fail, how long a cluster member accepts the record before rejecting it as expired, and when `activeTransactions` and persisted participant state are cleaned up. `findConflict` already sweeps reservations idle for more than `CONFLICT_STALE_THRESHOLD_MS` (2 s), so conflict blocking is not lengthened. The collection-factory `NOTE:` names those costs.
- **`MAX_LINK_ROUND_TRIP_MS` changed.** The plan said it needed no change. The transaction budget does reach timers: `RepoClient.processRepoMessage` arms one for `expiration - now`, and `ClusterMember.setupTimeouts` arms one 5 s past the expiration. So the ceiling is now `floor((2^31 − 1) / (44 + 1))` ≈ 47.7 M ms, about 13 hours, down from about 1.66 days. The extra round trip of headroom covers the 5 s timer. The ceiling test now includes every field and `transactionTimeoutMs + 5000`. No realistic declaration is anywhere near either ceiling. The ceiling exists to catch unit mistakes (nanoseconds), and both values catch them.
- **Reference peer cancel budget.** It was a fixed 10 s. It is now `Math.max(10_000, dialTimeoutMs)`, so the undeclared value is unchanged and a cancel always gets at least one dial.
- **Read-path `NOTE:`** is at the consult's `withinRequestBudget` call in `createLibp2pNodeBase` (the `clusterLatestCallback` closure). There are two such call sites (the consult, and `fetchArchiveFromPeer` for acquisition). The note names both, and `cluster.md` points at it. The claim that libp2p 3.3.11's dial queue runs a dial under its first caller's signal, and that later callers `join` without extending it, was re-checked in `node_modules/libp2p/dist/src/connection-manager/dial-queue.js`.

## Tests

- `test/link-deadlines.spec.ts` (updated): undeclared object and the 3 s case cover the new and renamed fields. The "fast enough to change nothing" case moved from 300 ms to 250 ms, because 11 × 300 = 3300 now exceeds the 3000 floor. The transfer ≥ dial case is at 110 s. The ceiling case takes the max over every field plus `transactionTimeoutMs + 5000`.
- `test/cold-relayed-dial-fits-the-address-limit.spec.ts` (new; the reproduction): three plain libp2p nodes (relay with `applyDefaultLimit: false`, a target with a reservation, a dialer that has never connected to the relay). Each reaches the relay through its own `listenDelayProxy`: 150 ms one-way on the dialer's leg, 1 ms on the target's, so r = 302 ms. The dialer's `addressDialTimeout` is the cold multiple × r, read as `resolveLinkDeadlines(MAX_LINK_ROUND_TRIP_MS).addressDialTimeoutMs / MAX_LINK_ROUND_TRIP_MS`. The caller's own signal is 20 s. The test asserts that the dial opens to the target. Measured: passes 5/5 at about 2.15–2.19 s. With the multiple temporarily set to 5, it failed 3/3 with `EncryptionFailedError: This operation was aborted`, so it reproduces the defect. It is not env-gated.

## Validation run

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs`: clean.
- db-p2p full suite: 3165 passing, 64 pending, 0 failing.
- quereus-plugin-optimystic full suite: 1001 passing, 14 pending, 0 failing.
- Not run: `yarn test:integration`, and the reference-peer suite. The reference peer's undeclared values are unchanged (30 s, 10 s), and it builds and typechecks. Its known intermittent concurrent-writes failure is tracked as `fix/2-all-lose-conflict-race-wedges-concurrent-first-appends`.

## Known gaps / for the reviewer

- The cold multiple's margin (10 r against 6.6 r measured) rests on the dialer→relay leg's socket setup costing at most one `r` per layer (TCP, WebSocket upgrade, TLS). The proxy does not delay handshakes, so that part is not measured. A real `wss` measurement over a slow link has not been done.
- The cancel budget (`abortOrCancelTimeoutMs`) still covers only a warm cancel (about 6 r against 11 r). A cancel that must first open a cold relayed connection does not fit. That is recorded in the collection-factory `NOTE:` as a tripwire, on the reasoning that a cancel normally reuses the connection its pend just opened.
- `fix/1.5-the-rpc-dial-deadline-cannot-be-set-per-node` depends on this ticket. A section appended to it says that `transferTimeoutMs` and `transactionTimeoutMs` derive from `dialTimeoutMs`, so an override has to be applied before they are computed, and that the ceiling interaction changes.
- After release: tell sereus-ec the version and the multiples (cold open 10 r, RPC dial 11 r, transaction budget 4 dials). Application admission time is not modelled; it goes on top through the explicit overrides.
