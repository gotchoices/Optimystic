description: Every request between two machines used to open a new stream, which costs a full network round trip before the request is even sent. Each node now keeps one already-opened stream ready per peer and protocol while traffic is flowing, so the next request skips that round trip; this needs a review pass and a field re-measure.
architecture: docs/internals.md#commit-path-distributed-consensus
files: packages/db-p2p/src/network/prepared-streams.ts (new), packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts, packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts, docs/debugging.md, docs/transactions.md, docs/internals.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/readme.md
----

# A request reuses a pre-negotiated stream — review handoff

GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29), question 1. Siblings: plan ticket `feat-fewer-consensus-calls-per-write`, backlog `feat-a-cohort-consult-batches-blocks-per-peer`.

## What changed

Opening a libp2p protocol stream costs one link round trip even on an open connection, because multistream-select waits for the remote's echo of the protocol id (`@libp2p/multistream-select` 7.0.28 ignores `negotiateFully: false`). Every request in this package was one request on one fresh stream, so it paid two round trips. Now:

- **`PreparedStreams`** (`packages/db-p2p/src/network/prepared-streams.ts`, new) holds at most one already-negotiated stream, and at most one background open in flight, per (peer, protocol). `take` hands a ready stream out (never waits, never dials); `replenish` starts a background open if none is ready or in flight; `close` tears everything down. A held stream is closed gracefully and not replaced after 30 s unused (`PREPARED_STREAM_IDLE_MS`), dropped the moment it closes or the remote half-closes it, and re-checked at `take` (open both ways, connection open, younger than the idle time, not on a relayed connection while a direct one now exists). `isPreparedStream(stream)` marks streams the pool handed out (a `WeakSet`).
- **`openProtocolStream`** gained `allowDial?: boolean` (default `true`). With `false` the dial path is left out, and an open with no open connection rejects at once with `NoOpenConnectionError` (`.code` `NO_OPEN_CONNECTION`) — previously the path list always ended in a dial, so an empty list would never have settled. `discardStream` is now exported for the pool.
- **`Libp2pKeyPeerNetwork.connect`** checks an already-aborted signal first, then takes from the pool when one was supplied; either way it calls `replenish` after handing a stream out. The pool is a new trailing optional constructor argument (the tenth); every other construction behaves exactly as before.
- **`ProtocolClient.processMessage`** was split into `openRequestStream` (dial deadline, unchanged behaviour) and `exchange` (send, read first reply, close). When the stream came from the pool and the exchange fails before any reply byte arrives — for any reason other than this request's own response deadline or the caller's abort — it re-sends once on a stream from a new `connect`, under the same caller signal, inside what is left of the same response deadline. `dial:ok` now logs `prepared=true|false`; the re-send logs `prepared:resend peer protocol reason` before its own `dial` line.
- **`createLibp2pNodeBase`** builds one pool per node for the repo, cluster, sync and block-transfer protocols (`preparedStreamProtocols`), with the node's `linkDeadlines` and a peer-suffixed `open-protocol-stream` logger for the background opens, and closes it in a stop wrapper installed immediately after construction (so startup rollback unwinds it). Dispute, cohort-topic, reactivity and FRET streams are untouched.
- Docs: `docs/debugging.md` (`protocol-client` row, new `prepared-stream` row, `open-protocol-stream` row, the `silent` row), `docs/transactions.md` § *When to raise `cohortQueryTimeoutMs`*, the matching passage in `packages/db-p2p/docs/cluster.md`, the slow-links paragraph in `packages/db-p2p/readme.md`, the `cohortQueryTimeoutMs` docblock in `packages/db-core/src/cluster/structs.ts`, the `withinRequestBudget` docblock, and a new bullet in `docs/internals.md` § Inbound Stream Authorization (authorization is decided when a stream opens, so a revoked peer's held streams stay usable until they expire).

## Tests added

- `test/stream-open-costs-a-round-trip.spec.ts`, third case "with a prepared stream, a request after the first pays only its own round trip": over the 200 ms-each-way delay proxy, through a real `Libp2pKeyPeerNetwork` with a pool, the first request takes at least two round trips and the second at least one and less than two. The two existing cases (the libp2p premise) are unchanged; the docblock now says the pool is the in-repo answer.
- `test/half-open-connection-does-not-strand-a-peer.spec.ts`, new describe "when a prepared stream is held on a connection that then goes half-open": the first request leaves a stream prepared on the newer of two connections, that connection is made half-open, and the next request takes the dead prepared stream, waits until the replacement open condemns the connection (at least the dead-connection delay — which proves the prepared stream was really taken), re-sends, and is answered in under the dead-connection delay plus the hedge delay. The existing harness covered it with no new scaffolding beyond a small `ProtocolClient` subclass. The debug log of a run shows exactly `dial:ok prepared=true` → `open-stream:connection-dead` → `prepared:resend` → `dial:ok prepared=true` → `response`.

Both specs were run four times; stable.

## Validation run

- `packages/db-p2p`: `yarn build` clean, `yarn test` 3287 passing / 70 pending, `yarn test:integration` 50 passing / 2 pending.
- `packages/quereus-plugin-optimystic`: `yarn test:integration` 1007 passing / 8 pending (it drives real meshes through `connect`).
- Root: `yarn check:rn` passed, `yarn lint:docs` passed, `eslint` clean on every touched source and spec file. The full root `yarn lint` and the plugin's plain `yarn test` were not run.
- `packages/db-core/src/cluster/structs.ts` changed (a comment only), so db-core must be rebuilt before any dependent package's tests run; the build-freshness guard enforces it.

## Known gaps and judgment calls for the reviewer

- **Tenth constructor parameter.** The NOTE on `Libp2pKeyPeerNetwork`'s constructor said to convert to an options bag "before a tenth parameter in any case". The ticket explicitly allowed a trailing optional argument and said not to reshuffle; I followed the ticket and rewrote the NOTE (now "before an eleventh"). Weigh whether the conversion should be filed now.
- **A request issued in the same instant as the previous reply can miss the prepared stream.** The replacement's negotiation travels just ahead of the previous request on the wire, so its echo arrives just before that request's reply, but the pool only holds it after libp2p's `peerStore.merge` resolves. The round-trip spec therefore pauses a quarter round trip between its two requests. Production sequences (pend, then commit) do work between requests, but a tight back-to-back caller can see `prepared=false`. The field re-measure below will show whether this matters.
- **Additions beyond the ticket's text:** a `prepared-stream:refused peer protocol reason` debug line when `take` rejects a held stream; eviction on the stream's `remoteCloseWrite` event (closing our end at once) as well as on `close`; the pool's own lines go to a `prepared-stream` namespace (peer-suffixed), while the background opens' `open-stream:connection-dead` lines keep the `open-protocol-stream` namespace.
- **Re-send timing:** the re-send's `connect` gets a fresh dial deadline; only its exchange is bounded by what remains of the original response deadline. Worst case for a re-sent request is therefore one extra dial deadline beyond today's.
- **`first-byte` log moved** from the first decoded frame to the first raw chunk off the stream (the same signal that decides whether a re-send is allowed). Its timings can read slightly earlier than before.
- **`ProcessMessageOptions`** is a new exported type from `protocol-client.ts`, which `index.ts` and `rn.ts` re-export.
- **By inspection only**, as the ticket specified: `NoOpenConnectionError` on an empty path list, idle expiry, eviction on close, the DCUtR refusal, `close()` cancelling background opens, the self guard, concurrent requests to one key. No unit tests were written for these.
- **Re-delivery tolerance** of every operation on the four protocols is taken from the ticket's analysis (batch retries already re-send; cluster records merge idempotently; pend/commit at the action's own revision are no-ops). It was not re-verified per operation here. If an operation turns out not to tolerate it, narrow `ProtocolClient.mayResend`, not the pool.

## Ask: field re-measure

Please ask the reporter of #29 to re-run `message-latency.mjs` on a relayed pair with `DEBUG=optimystic:db-p2p:protocol-client*`. Expected: `dial:ok` near 0 ms with `prepared=true` on every request after the first of a write (the first of a write after a quiet spell still shows `prepared=false` and the old cost), and a write dropping from about 8 relay round trips to about 4.
