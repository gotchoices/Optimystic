description: When this node holds two connections to a peer and the first one is dead on the far side but still listed as open here, every request to that peer opens its stream on the dead one and waits out its deadline, even though the second connection works. A founder's first read after a sibling joins fails with cohort-unreachable because of it.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts
repro: verified-by-reporter
severity: high
likelihood: normal-use
----

# A half-open connection makes a connected peer unreachable

GitHub: [#32](https://github.com/gotchoices/Optimystic/issues/32)

## What happens

`openProtocolStream` in `packages/db-p2p/src/network/open-protocol-stream.ts` (the one place db-p2p opens a protocol stream; `Libp2pKeyPeerNetwork.connect` uses it, so every repo / sync / cluster request does) picks one connection and never tries another:

```ts
const open = conns.filter(c => c?.status === "open" && typeof c?.newStream === "function");
const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
if (chosen) return await chosen.newStream([protocol], streamOptions);
```

If `chosen` is half-open (the remote dropped it; this side still says `open`), `newStream` hangs until the caller's signal fires. A second, live connection to the same peer is never tried, and every retry picks the same dead connection for as long as libp2p keeps it.

Half-open WebSocket connections are routine with `@libp2p/websockets` <= 10.1.21: an abort sends its reset with `websocket.close(1006)`, which Node's WebSocket rejects, so the remote never learns. That part is upstream libp2p; the defect here is that one dead connection cuts this node off from a peer it is otherwise connected to.

## How it showed up (reporter, cadre-core 1.13.0 / db-p2p 1.11.0, libp2p 3.3.11, Node 22)

Two-node strand, loopback WebSockets, one process. The founder's first read after the joiner arrives fails 4/4:

```
BlockUnavailableError: Block default/app/Network is unavailable (cohort-unreachable): the repo could not determine whether it exists
```

Chain: the joiner dials the founder; ~300 ms later the joiner's WebSocket aborts (`StreamBufferError: Read buffer overflow - 4206004 > 4194304`, both nodes on one busy event loop) without sending a reset, and re-dials. The founder now lists two inbound `open` connections from the joiner, the dead one first. The founder's cluster-fetch asks the joiner for its latest revision; `openProtocolStream` picks the dead connection; the request ends in `request budget exceeded ... sync/1.0.0 after 7000ms`. The joiner's sync handler received 0 requests in that window, while the founder answered the joiner's 178 requests in ~1 ms each. `queryClusterForLatest` counts the joiner silent, the silence verdict is `isolated`, which `unavailableReasonFor` in `packages/db-p2p/src/repo/coordinator-repo.ts` maps to `cohort-unreachable`. Later reads succeed once the dead connection is finally closed.

## Repro

The issue carries a standalone flip-on-fix `node:test` (`stale-connection-picker.test.mjs`, real libp2p + websockets, no cadre): b dials a; `first.maConn.abort(...)` on b's side; b re-dials; a holds two `open` connections; `conns[1].newStream` echoes at once (control); `new Libp2pKeyPeerNetwork(a, 1).connect(b.peerId, ECHO, { signal })` hangs the full 3 s, and a retry hangs again. Port it into `packages/db-p2p/test/` as the reproducing spec, asserting the fixed behaviour. Reporter's control: changing the picker to newest-first makes the request succeed, which shows the choice of connection decides it. Newest-first is not the fix: a fresh connection can be the dead one just as well.

## Directions (settle in implement)

- On a stream-open failure, or on exceeding a short negotiation deadline (the open costs one link round trip, see `stream-open-costs-a-round-trip.spec.ts` and the declared `linkRoundTripMs`), try the other open connections to the peer, then a fresh dial, all inside the caller's overall signal.
- Treat a stream-open timeout on a connection as evidence it is dead and close it, so the next request does not choose it.
- Possibly: let the cohort consult distinguish "could not open a stream" from "opened, no answer", so one dead connection does not produce `isolated`. Weigh against the fail-closed rule in docs/internals.md (silence must still flag).

## TODO

- Port the reporter's repro into a db-p2p spec.
- Fallback across open connections plus close-on-negotiation-timeout in `openProtocolStream`, keeping it the single stream-open site (`test/dial-options-single-site.spec.ts`).
- Update the `openProtocolStream` doc comment and any docs that describe connection reuse.
