description: When a node asks its cohort peers about a block, a hidden 3-second limit cuts every request short, whatever per-peer time limit the deployment configured. On links with a round trip near 3 seconds, every such request fails, so the node never confirms a block with its cohort. The configured per-peer limit should be the only limit on the request.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `fetchArchiveFromPeer`)
  - packages/db-p2p/src/rpc-deadline.ts (`withRpcDeadlineDefaults`, `DEFAULT_DIAL_TIMEOUT_MS`; new budget helper)
  - packages/db-p2p/src/sync/client.ts (`SyncClient.requestBlock`)
  - packages/db-p2p/src/protocol-client.ts (`ProtocolClient.processMessage`: how `signal`, `dialTimeoutMs`, `responseTimeoutMs` combine)
  - packages/db-p2p/src/repo/client.ts (the "Explicit combinator rather than the native `AbortSignal.any`" block — precedent for a Hermes-safe deadline signal with a reason)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`queryClusterForLatest`, which deadlines each consult with `cohortQueryTimeoutMs`)
  - packages/db-p2p/src/libp2p-key-network.ts (`Libp2pKeyPeerNetwork.connect` docblock — false "saves a round trip" claim)
  - packages/db-p2p/src/network/open-protocol-stream.ts (`OpenProtocolStreamOptions.negotiateFully` doc)
  - packages/db-p2p/src/cohort-topic/stream-util.ts (module NOTE on `negotiateFully`)
  - packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts (premise spec, added by the fix stage)
  - docs/transactions.md (§Read Consistency and Staleness, `cohortQueryTimeoutMs` row and "When to raise" paragraph), docs/debugging.md (`silent` row, `noArchive`), packages/db-p2p/docs/cluster.md (`cohortQueryTimeoutMs`)
repro: verified
----
# The read-path consult's per-peer budget must bound its whole request

## What happens

`clusterPolicy.cohortQueryTimeoutMs` is documented as how long one cohort peer gets to answer one read-path request, and it sets the deadline in two places:

- `CoordinatorRepo.queryClusterForLatest` wraps each `clusterLatestCallback` call in `withDeadline(…, cohortQueryTimeoutMs)`.
- `fetchArchiveFromPeer` races `requestBlock` against a `cohortQueryTimeoutMs` timer.

Both call `SyncClient.requestBlock` with no options, so `withRpcDeadlineDefaults` adds a 3000 ms dial deadline and a 10000 ms response deadline underneath. `ProtocolClient.processMessage` applies the dial deadline to `peerNetwork.connect`, which covers the connection-reuse path too: `openProtocolStream` hands the signal to `connection.newStream`, and multistream-select waits one full round trip for the remote's acknowledgement.

`Libp2pKeyPeerNetwork.connect` passes `negotiateFully: false` to skip that wait, but `@libp2p/multistream-select@7.0.10` (under libp2p 3.1.3) ignores the option, and `select` always reads the acknowledgement. So opening a stream costs one round trip even on a connection that has been open for minutes, and a 3 s dial deadline fails every request on a link with a 3 s round trip. When `cohortQueryTimeoutMs` is above 3000, it never takes effect.

Sereus measured this on 2026-09-29: two relay-only nodes, 1500 ms one-way. With `cohortQueryTimeoutMs` at 5000 and at 7000, consecutive declined reads were 3.00–3.02 s apart and neither configured value ever fired. There were 39 and 32 declined reads (`cluster-fetch:peers-silent` → no-quorum). Read repair never corroborated a block; joins completed only because sereus's own backfill pushed the blocks.

## Reproduction

`packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts` (added in the fix stage, passing, ~2 s) sets up two real libp2p nodes behind a TCP proxy that adds 200 ms each way, and opens the connection first:

- An RPC with no dial cap succeeds, and takes at least two round trips: one for negotiation, one for the request.
- An RPC whose dial deadline is below one round trip fails with `DialTimeoutError`, although the connection is open.

The spec checks the premise with scaled-down numbers: libp2p plus `ProtocolClient`, not any particular deadline value. Sereus's measurement is the full-scale version.

## Fix

One rule: **a caller that owns a per-peer budget bounds the whole request with it, and nothing inside the request may be shorter.**

- Add a small helper in `rpc-deadline.ts` that turns a budget into `RpcDeadlineOptions`: `{ signal, dialTimeoutMs: 0, responseTimeoutMs: 0 }`. An explicit `0` already means "no cap" to `withRpcDeadlineDefaults` and `processMessage`. The signal comes from an `AbortController` plus a `setTimeout`, not `AbortSignal.timeout` or `AbortSignal.any`, because Hermes provides neither (see the precedent block in `repo/client.ts`). Abort it with a reason that names the peer, the protocol and the budget. The helper returns a disposer that clears the timer, and the timer is `unref`'d where available.
- `clusterLatestCallback`: pass those options to `requestBlock`, built from `consensusConfig.cohortQueryTimeoutMs`. This is the same resolved number `queryClusterForLatest` deadlines with, so both fire together. The coordinator's `withDeadline` stays: it is what classifies a late peer as silent. The added signal makes the stream get torn down at that moment instead of running on to the 10 s response deadline. The three-way contract is unchanged: transport errors and the abort still reject, and reject means silent.
- `fetchArchiveFromPeer`: replace the `Promise.race` against a timer with the same options. A timeout rejects into the existing `catch`, which returns `undefined`, so the contract is unchanged ("a timed-out fetch resolves to no archive"). The "Cleared on either outcome" timer comment moves to the helper's disposer.
- Correct the comments that claim `negotiateFully: false` saves a round trip: the `Libp2pKeyPeerNetwork.connect` docblock, the `OpenProtocolStreamOptions.negotiateFully` doc, and the module NOTE in `cohort-topic/stream-util.ts`. On this libp2p version the option is accepted and ignored. Keep passing it; it costs nothing and takes effect if libp2p honours it again. The accepted tradeoff in `stream-util.ts` keeps its decision; only its premise changes, since omitting the flag currently costs nothing. The premise spec is the tripwire for that.
- Docs: `docs/transactions.md` says the field "sets both per-peer deadlines", which was false above 3 s. After this change it is true, so state that nothing inside the request is shorter, and say the round-trip guidance should count two round trips on a reused connection (negotiation plus request). Update `docs/debugging.md`'s `silent` row and `noArchive` note to match. Check `packages/db-p2p/docs/cluster.md` §`cohortQueryTimeoutMs`.

Not in scope, and handled by `declared-link-round-trip-derives-every-dial-deadline`: the defaults that other RPC clients use (cluster consensus, dispute, repo, pushes) and libp2p's connection deadlines. On a 3 s round-trip link those still fail at 3 s, so writes on such a link stay broken until that ticket lands. This ticket makes the configured read budget authoritative on its own.

`RestorationCoordinator.queryPeer` also calls `requestBlock` with no options. It has no per-peer budget of its own to pass down, so the other ticket's derived defaults cover it.

## Tests

No new default-suite test: the premise spec pins the mechanism, and the change is wiring. If the implementer wants end-to-end confirmation, a real-socket spec at 1600 ms one-way (connection open takes about 7 s on direct TCP, and each RPC about 6.4 s) gated on `RUN_LONG_TESTS=1` is acceptable. It should show that `clusterLatestCallback` with a 7000 ms budget answers where it used to fail at 3 s. Do not add it to the default suite.

## TODO

- Add the budget-to-options helper in `rpc-deadline.ts` (Hermes-safe, disposer, reason names peer, protocol and budget).
- Use it in `clusterLatestCallback` and `fetchArchiveFromPeer`; drop the `Promise.race` in the latter.
- Correct the three `negotiateFully` comments.
- Update docs/transactions.md, docs/debugging.md and packages/db-p2p/docs/cluster.md; run `yarn lint:docs`.
- `yarn workspace @optimystic/db-p2p build`, then that package's `test`; run `yarn test:integration` for db-p2p if the read-repair integration specs touch these callbacks.
