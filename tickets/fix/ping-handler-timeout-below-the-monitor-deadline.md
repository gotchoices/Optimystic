description: A node answers liveness pings under `@libp2p/ping`'s fixed 10 s handler timeout, which nothing lets an embedder change, so on a slow link the answering node aborts the ping stream before the pinging node's 30 s connection-monitor deadline and the connection is dropped anyway. Add a `NodeOptions` ping handler timeout that defaults to above the declared monitor deadline.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts, packages/db-p2p/readme.md
difficulty: easy
----

# A ping handler's 10 s timeout drops connections the monitor deadline was meant to keep

Reported by Sereus (`../sereus/tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md`, repro verified 2026-10-17); its slow-link scenario arms are blocked on it.

## What happens

`createLibp2pNodeBase` builds the ping service bare (`ping: ping()`). libp2p's connection monitor on node A opens `/ipfs/ping/1.0.0` to node B and waits under A's `connectionMonitor.pingTimeout` (30 s on every Sereus node). On B, `@libp2p/ping`'s inbound handler runs its own `TIMEOUT = 10000` (`@libp2p/ping` 3.1.13) and aborts the stream when it fires. A then gets `StreamResetError`, and the monitor aborts the whole connection, exactly what the 30 s deadline was set to prevent.

Sereus measured it on a 20 ms-per-frame link with a 70% busy event loop: 8 `aborting connection due to ping failure` in 114 s on one arm and 11 in 143 s on another, every one a stream reset or unexpected EOF, none a timeout. Outbound frames waited 10–22 s in the socket queue, so the echo routinely missed B's 10 s. Isolated: two bare libp2p 3.3.11 nodes over a serial 150 ms-latency WebSocket, dialer monitor 8 s interval / 30 s timeout; handler timeout 100 ms dropped the connection within 14 s, 10 000 ms kept it. Sereus's deployed relay already works around the same defect with `ping({ timeout: 60_000 })`.

## Expected

- `NodeOptions` gains a ping handler timeout (proposed `pingHandlerTimeoutMs`), passed as `ping({ timeout })`.
- Default: strictly above the node's declared `connectionMonitor.pingTimeout.maxTimeout` when one is declared (the same relation the existing rule keeps between `pingInterval` and that deadline); `@libp2p/ping`'s 10 s otherwise. Validate it like the other timeouts (finite, > 0, ≤ 2^31−1).
- `test/connection-monitor-ping-overlap.spec.ts` gains the relation "the handler timeout is never the first deadline to fire", for both the default and an explicit value.
- Document the option in `packages/db-p2p/readme.md` beside `connectionMonitor`, and add a line to `.release-notes.pending.md`.

Sereus then sets it at its two node builders; nothing else here needs to change.
