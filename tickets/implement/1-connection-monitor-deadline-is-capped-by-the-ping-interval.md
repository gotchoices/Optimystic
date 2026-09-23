description: The readme and the `connectionMonitor` doc comment tell a slow-phone deployment to raise `pingTimeout.minTimeout` to 30 s. With the default 10 s ping interval that doesn't work: a node that runs the ping service allows one outbound ping stream per connection, so the next ping fails as soon as the previous one is still waiting. The monitor treats that failure as a timeout and aborts the connection. The effective deadline is therefore capped at the ping interval, and the documented setting gives a phone 10 s, not 30.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionMonitor` doc comment; `ping: ping()` in services)
  - packages/db-p2p/readme.md (the React Native paragraph on `connectionMonitor`)
  - packages/db-p2p/test/connection-monitor-node-wiring.spec.ts
source: sereus review of libp2p 3.1.3, reproduced on two local nodes; optimystic's own measurement at scratchpad/libp2p-monitor-test saw the pile-up but ran without the ping service
----
# The connection monitor's deadline is capped by its ping interval

## What happens

The connection monitor pings on the protocol `/${protocolPrefix ?? 'ipfs'}/ping/1.0.0`, so by default `/ipfs/ping/1.0.0`. Every optimystic node also registers the `@libp2p/ping` service (`ping: ping()` in `createLibp2pNodeBase`) on that same protocol, with `maxOutboundStreams: 1` (`MAX_OUTBOUND_STREAMS` in `@libp2p/ping` 3.0.10). The monitor opens a new ping stream every `pingInterval`, whether or not the last one has answered. So while one ping is still waiting on a slow peer, the next one fails with `TooManyOutboundProtocolStreamsError`. The monitor's catch cannot tell that from a timeout and aborts the connection when `abortConnectionOnPingFailure` is on.

The effective deadline is therefore `min(deadline, pingInterval)`. Sereus reproduced this on two local libp2p 3.1.3 nodes: interval 300 ms with deadline 900 ms aborted; interval 900 ms kept the connection. Our own measurement (3.3.11, in the session scratchpad) saw three pings in flight to a stalled peer, but its monitoring node did not run the ping service, so the limit never applied.

Our docs recommend `pingTimeout: { minTimeout: 30_000, maxTimeout: 600_000 }` without touching `pingInterval`, so a deployment that follows them still gets a 10 s effective deadline. Sereus now ships `pingInterval: 35_000` with the deadline pinned at 30 s (`minTimeout` = `maxTimeout`).

## What to do

- **Confirm on our stack first:** a small spec or a scratch run on two optimystic nodes, with a remote that stalls its ping answer past `pingInterval` but under `minTimeout`. It should show the abort, with the `TooManyOutboundProtocolStreamsError` cause. Keep the spec only if it is cheap and stable (see the existing wiring spec's timing approach). Otherwise record the reproduction in the ticket and the doc comment.
- **Correct both docs:** a patient deadline needs `pingInterval` longer than it, because a node that runs the ping service allows one outbound ping per connection and an overlapping ping aborts the connection. Give the working shape, e.g. `{ pingInterval: 35_000, pingTimeout: { minTimeout: 30_000, maxTimeout: 30_000 } }`. Say that a dead peer is then reclaimed within about `pingInterval + minTimeout`. Also correct the "a dead peer is dropped after ten minutes" reading if either doc implies it. Measured at 3.3.11: a frozen peer was dropped at `minTimeout` plus the wait for the next ping, 34.6 s with min 30 s / max 600 s.
- **Update the version note:** on libp2p 3.3.x the deadline adapts, but only for one ping. The EMA span (5 s) is shorter than the ping interval, so the next fast success resets it to `minTimeout`. Intermittent stalls are still dropped (4 of 4 in the measurement). Fold that into the existing tripwire `NOTE:` so the 3.3 move does not over-promise.
- Our default stays unchanged (unset means libp2p's defaults). Do not raise `maxOutboundStreams` on our ping service as a workaround without asking. It would change what every node accepts from applications' own pings, and it is a separate decision.
