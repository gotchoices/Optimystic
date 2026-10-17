description: A node cuts off incoming liveness pings after a fixed 10 seconds that nobody can change, so on a slow link it drops connections that the other side was configured to wait 30 seconds for. Let embedders set that limit, and by default keep it above the node's own declared ping deadline.
architecture: packages/db-p2p/readme.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/connection-monitor.ts, packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts, packages/db-p2p/readme.md, .release-notes.pending.md
difficulty: easy
repro: verified
----

# Ping handler timeout below the connection-monitor deadline

Reported by Sereus (`../sereus/tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md`, repro verified 2026-10-17 on two bare libp2p 3.3.11 nodes over a 150 ms-latency serial WebSocket: answering-side handler timeout 100 ms dropped the connection within 14 s, 10 000 ms kept it; on their 20 ms-per-frame link, 8 and 11 `aborting connection due to ping failure` events per ~2 minutes, every one a stream reset or unexpected EOF, none a timeout). Sereus's relay already works around it with `ping({ timeout: 60_000 })`. Its slow-link scenario arms are blocked on this.

## Cause (confirmed by reading the installed code)

- `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`) registers the ping service bare: `ping: ping()`, under the existing "constructed bare" `NOTE:` comment.
- `@libp2p/ping` 3.1.13, `PingService.handlePing` (`node_modules/@libp2p/ping/dist/src/ping.js`): every inbound `/ipfs/ping/1.0.0` stream gets `AbortSignal.timeout(this.timeout)`, and on abort calls `stream.abort(new TimeoutError(...))`. `this.timeout = init.timeout ?? TIMEOUT`, with `TIMEOUT = 10000` in its `constants.js`. Note the timer covers the whole stream life — echo, waiting for the pinger to close its side, and the final `stream.close` — so a slow outbound queue on the answering node eats it.
- The pinging node's `ConnectionMonitor` (libp2p `connection-monitor.js`) waits under its `AdaptiveTimeout` (`@libp2p/utils` `adaptive-timeout.js`: `DEFAULT_MIN_TIMEOUT = 5_000`, `DEFAULT_MAX_TIMEOUT = 60_000`). When the answering node resets the stream first, the monitor sees `StreamResetError`/unexpected EOF, which it cannot tell from a dead peer, and aborts the whole connection. So the declared `pingTimeout` of 30 s is capped at the remote's 10 s handler timeout — the same shape as the interval cap that `NodeOptions.connectionMonitor`'s doc and `test/connection-monitor-ping-overlap.spec.ts` already describe, from the other end of the stream.

## Design

New `NodeOptions.pingHandlerTimeoutMs?: number` — how long this node lets an inbound ping stream live before aborting it. Passed as `ping({ timeout })`.

Resolution (one small pure function, beside the other deadline resolvers in `packages/db-p2p/src/rpc-deadline.ts`, e.g. `resolvePingHandlerTimeoutMs(declared, connectionMonitor)`):

- Declared → validate like the other timeouts: finite, > 0, ≤ 2^31 − 1 (reuse `validDeclaredMs` with `MAX_TIMER_DELAY_MS`, field name `pingHandlerTimeoutMs`), and use it as given. Do not silently raise it; an embedder who sets it low has decided.
- Undeclared, and `connectionMonitor.pingTimeout.maxTimeout` declared → `min(2^31 − 1, max(10_000, 2 × maxTimeout))`. Twice the deadline is strictly above it, matches the margin Sereus deployed (60 s for a 30 s deadline), and covers the handler's timer also spanning the stream close. The relation assumes the remote's monitor is configured like this node's — the same "both ends alike" assumption the `connectionMonitor` doc already makes; say so in the option's doc.
- Otherwise → `@libp2p/ping`'s own 10 000 ms (pass nothing, or the constant — keep behaviour identical to today).

Note on the third case: an unconfigured libp2p monitor's adaptive deadline may rise toward its 60 s default `maxTimeout` for one slow ping, so even a stock pair can in principle hit the 10 s handler cap. The ticket deliberately leaves the undeclared default at 10 s (no behaviour change for unconfigured nodes); record that as a `NOTE:` tripwire at the resolver ("if stock-config deployments report reset-driven aborts, derive from libp2p's default max too").

Also update the existing "constructed bare" `NOTE:` at `ping: ping()` — it is no longer bare; the `maxOutboundStreams: 1` premise is unchanged (don't touch `maxOutboundStreams`).

## Test

In `packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts` (or a sibling describe in it), pin "the handler timeout is never the first deadline to fire":

- Pure assertions on the resolver: for a declared `maxTimeout` (e.g. 30 000, and one below 5 000) the default exceeds it; with no `pingTimeout` it is 10 000; an explicit value is returned as is; non-finite / ≤ 0 / > 2^31 − 1 throws.
- One real-node arm showing the value reaches the service: listener built with an explicit small `pingHandlerTimeoutMs` (e.g. 300 ms); dialer opens a raw `/ipfs/ping/1.0.0` stream, sends 32 bytes, never closes; observe the listener aborts it at ≥ 300 ms and well under the 10 s library default. Keep it fast; don't add a slow-link simulation.

No test for the readme/release-notes wiring.

## TODO

- Add `pingHandlerTimeoutMs` to `NodeOptions` with a doc comment next to `connectionMonitor` (cause, default rule, both-ends assumption, cost: a stalled inbound ping stream is held up to this long — bounded by `@libp2p/ping`'s `maxInboundStreams`).
- Add the resolver in `rpc-deadline.ts` with validation and the tripwire `NOTE:`; call it in `createLibp2pNodeBase` and pass `ping({ timeout })`; update the `NOTE:` at the ping service.
- Extend `test/connection-monitor-ping-overlap.spec.ts` as above (and its header comment, which lists the premises it pins).
- Document in `packages/db-p2p/readme.md`'s React Native / patient connection monitor section (beside `pingInterval has to be longer than the deadline`): the answering side's handler timeout is the third bound, and the default now follows the declared deadline.
- Add a line under Unreleased in `.release-notes.pending.md`.
- Run `yarn build` then `yarn test` in `packages/db-p2p`; `yarn lint:docs` for the readme citations.
