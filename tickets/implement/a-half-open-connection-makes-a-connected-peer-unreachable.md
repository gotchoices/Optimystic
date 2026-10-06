description: When this node holds two connections to a peer and the first is dead on the far side but still listed as open here, every request to that peer waits out its deadline on the dead one even though the second connection works. Make opening a stream fall back to the other connections (and a fresh dial), and close a connection that has proven dead, so one dead connection cannot cut a node off from a peer it is connected to.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/dial-options-single-site.spec.ts, packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts, docs/debugging.md
difficulty: hard
repro: verified
----

# A half-open connection makes a connected peer unreachable

GitHub: [#32](https://github.com/gotchoices/Optimystic/issues/32)

## The defect

`openProtocolStream` in `packages/db-p2p/src/network/open-protocol-stream.ts` is the one place db-p2p opens a protocol stream (`Libp2pKeyPeerNetwork.connect` and the cohort-topic `requestResponse` / `sendOneWay` helpers in `packages/db-p2p/src/cohort-topic/stream-util.ts` all go through it). It picks exactly one connection and never tries another:

```ts
const open = conns.filter(c => c?.status === "open" && typeof c?.newStream === "function");
const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
if (chosen) return await chosen.newStream([protocol], streamOptions);
```

A **half-open** connection is one the remote has already dropped while this side still lists it as `open`. `newStream` on it sends the multistream-select proposal and waits for an acknowledgement that never comes, until the caller's signal fires. A second, live connection to the same peer is never tried, and every retry picks the same dead connection until libp2p's connection monitor (ping every `pingInterval`, default 10 s, plus its timeout) finally aborts it.

Half-open WebSocket connections are routine with `@libp2p/websockets` <= 10.1.21 (the version pinned here): on abort it sends the reset with `websocket.close(1006)`, which Node's WebSocket rejects, so the far side never learns. That half is upstream; this ticket is about not letting it strand a peer.

Field effect (reporter, cadre-core 1.13.0 / db-p2p 1.11.0): a joiner's first WebSocket to the founder aborted on the joiner's side ~300 ms after connecting (a 4 MiB read-buffer overflow on a busy event loop) and the joiner re-dialed. The founder then held two inbound `open` connections from the joiner, the dead one first. The founder's next read consulted the joiner, `openProtocolStream` picked the dead connection, the consult timed out, `queryClusterForLatest` counted the joiner silent, the silence verdict was `isolated`, and `unavailableReasonFor` (`packages/db-p2p/src/repo/coordinator-repo.ts`) mapped it to `cohort-unreachable`: `BlockUnavailableError` on the founder's first read, 4 of 4 runs.

## Reproduction (in tree, currently failing)

`packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts`, ported from the reporter's flip-on-fix `stale-connection-picker.test.mjs` and asserting the fixed behaviour. Real libp2p, WebSockets on loopback: `b` dials `a`, aborts the socket on its own side via `maConn.abort(...)`, re-dials; `a` lists two `open` connections to `b`. The precondition case (stream on `conns[1]` echoes at once) passes. The `connect()` case fails today:

```
yarn workspace @optimystic/db-p2p test -- --grep "half-open connection"
  1) connect() reaches the peer, and so does a retry:
     AssertionError: expected 'hung' to equal 'echoed'
```

`b` does not listen, so a fresh dial from `a` cannot succeed there: the spec passes only if the open falls back to the second existing connection. Expected run time once fixed: about 2 s (three 500 ms settling sleeps plus the opens). Today it costs about 8 s because each request hangs for its full 3 s.

## Required behaviour

1. **Fallback across connections, then a fresh dial, inside the caller's signal.** When the stream open on the preferred connection has not completed within a short delay (call it the *hedge delay*), start an open on the next open connection to the peer **without cancelling the first**; after every open connection has been tried, start a fresh dial (`dialProtocol` with `force: true` — without `force` libp2p's dialer hands back an existing connection, likely the same dead one). The first stream to open wins. Every other attempt is cancelled, and a stream that a losing attempt manages to open anyway is closed. A non-timeout failure on one path (a reset, `beforeDial`'s `SelfRelayOnlyAddressesError`, a failed dial) moves on to the next path at once instead of waiting for the hedge delay, and only when every path has failed does the call reject — with the caller's own abort reason if the caller's signal fired first (keep the existing `throwIfAborted` contract), otherwise with the most informative path error (prefer the first connection's error; a test should pin which).
   - Hedge rather than abort-and-retry: a merely slow connection keeps its chance, so a short hedge delay costs at most one extra stream negotiation, never a live connection.
   - Order of paths: keep today's preference (direct before limited/relayed). Within a group, newest first is a reasonable tie-break (a re-dial usually replaces a connection that failed), but it is not the fix — the reporter showed a fresh connection can be the dead one.
   - The common single-healthy-connection case must stay one `newStream` call with no extra timers left running (clear the hedge timer on success).
2. **Close a connection that has proven dead.** A connection whose stream open stays pending for a whole *dead-connection delay* is aborted (`connection.abort(err)`, not the graceful `close()`, which can itself wait on the dead peer), so the next request does not choose it. Log it once per connection under the `optimystic:db-p2p` logger namespace used nearby (proposed event name `open-stream:connection-dead`, fields: peer, protocol, connection id, direction, `limited`, how long it was pending) and add the line to `docs/debugging.md`.
   - This judgment must not depend on the caller's deadline: a caller's 1 s cohort-consult deadline is not evidence a connection is dead. Run the condemnation timer on an internal signal so the attempt can keep going for the dead-connection delay after the caller has its answer or has given up. Bound everything by that delay so nothing outlives it.
   - It is the same class of judgment libp2p's connection monitor already makes (a ping that does not answer within its timeout aborts the connection), made sooner and on evidence the request path already holds.
3. **Deadlines come from the declared link round trip.** Stream negotiation costs one link round trip even on an open connection (`stream-open-costs-a-round-trip.spec.ts`). Proposed:
   - hedge delay = `max(HEDGE_FLOOR_MS, 1.5 × linkRoundTripMs)`, floor around 250 ms. It must be well under `DEFAULT_COHORT_QUERY_TIMEOUT_MS` (1000 ms, db-core) so an undeclared-link cohort consult can still finish on the second connection inside its own deadline — that is exactly the field failure.
   - dead-connection delay = the RPC dial deadline (`LinkDeadlines.dialTimeoutMs`: `max(3000, 11 × linkRoundTripMs)`), the bound this package already uses for "one connection open plus negotiation".
   - Add both to `LinkDeadlines` / `resolveLinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts` with the same derivation comment style, and export undeclared defaults for callers built without a node (the cohort-topic helpers in `stream-util.ts`, and tests).
   - Thread them into `Libp2pKeyPeerNetwork` from `createLibp2pNodeBase` (it already resolves `linkDeadlines`). The constructor has seven positional parameters and a `NOTE:` saying an eighth is the revisit point; either take that revisit (options bag) or give the key network a narrow setter / `openStream` deadlines object — implementer's call, record the choice. `stream-util.ts`'s helpers should also get the node's values where their callers can supply them; where not, the undeclared defaults.
   - Known residual to state in the doc comment: on a declared slow link a cohort consult (3 round trips) that meets a dead-first pair spends 1.5 on the hedge, then 1 negotiating and 1 for the request on the live connection, so that one consult can still miss; the dead connection is then aborted within the dial deadline and the next consult succeeds.
4. **Stays the single stream-open site.** All of this lives in `openProtocolStream`; `test/dial-options-single-site.spec.ts` must keep passing unchanged. `runOnLimitedConnection: true` must ride every path, the fresh dial included, and `beforeDial` must still run only before a fresh dial, never on reuse. Imports stay type-only or pure (the module is reachable from `src/rn.ts`); importing constants from `rpc-deadline.ts` is fine if that module stays free of node-only code (check `yarn check:rn`).

## Rejected direction

Teaching the cohort consult in `CoordinatorRepo.queryClusterForLatest` to tell "could not open a stream" from "opened, no answer" so one dead connection does not produce `isolated`: not doing it. Both mean the node could not hear from that peer for this read, and the fail-closed rule in docs/internals.md (*A block read has three answers*: silence must still flag, because the silent peer could be the sole holder) applies to both alike. Fixing the stream open removes the cause; relabelling the symptom would weaken the rule for every other way a stream open fails.

## Interactions

- Backlog `feat-fewer-relay-round-trips-per-write-and-read` proposes reusing streams. If that lands, a reused stream on a dead connection has the same failure; its design must route through the same dead-connection judgment.
- `ProtocolClient.processMessage` (`packages/db-p2p/src/protocol-client.ts`) wraps `connect` in its dial deadline; nothing there should need to change, but confirm `DialTimeoutError` is still what a caller sees when every path is slow.

## Tests

- The repro spec above must pass (and run in ~2 s).
- One unit spec in `test/open-protocol-stream.spec.ts` over the existing connection stubs for the branching logic the real-network spec cannot reach cheaply: a stub connection whose `newStream` never settles followed by a healthy one (hedges, wins on the second, closes nothing yet), the dead-connection delay elapsing (the hung connection is aborted exactly once), a rejecting first connection (moves on without waiting for the hedge), all paths failing (rejects with the caller's reason when aborted, else the pinned error), and a stream opened late by a losing attempt being closed. Use short injected delays; no fake timers are needed if the delays are options.
- Do not add a test per derived constant; extend the existing `resolveLinkDeadlines` coverage only if it enumerates fields.

## TODO

- Add hedge and dead-connection delays to `LinkDeadlines` / `resolveLinkDeadlines` with undeclared defaults.
- Rework `openProtocolStream`: ordered paths, hedged attempts, fresh dial with `force: true` last, first-wins with loser cleanup, condemnation on an internal timer with `connection.abort`, log event.
- Thread the node's values into `Libp2pKeyPeerNetwork.connect` and, where possible, the cohort-topic stream helpers; record the constructor-parameter choice.
- Update the `openProtocolStream` docblock (selection, fallback, condemnation, the slow-link residual) and the `connect` docblock in `libp2p-key-network.ts`.
- Add the log event to `docs/debugging.md`.
- Make `half-open-connection-does-not-strand-a-peer.spec.ts` pass; add the unit cases to `open-protocol-stream.spec.ts`; run the db-p2p suite, `yarn typecheck` after build, and `yarn check:rn`.
