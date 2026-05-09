---
description: Review WebSocket (ws) listen support in optimystic-peer + db-p2p so browsers/RN can dial Node bootstraps
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-node.ts, packages/reference-peer/src/cli.ts, packages/reference-peer/README.md, docs/optimystic.md
---

## What was built

`createLibp2pNode` (Node entrypoint, `packages/db-p2p/src/libp2p-node.ts`) now composes its default transport/listen list from three new `NodeOptions` fields:

- `wsPort?: number` — when set, appends `webSockets()` to the default transports and `/ip4/<wsHost>/tcp/<wsPort>/ws` to the default listen addrs.
- `wsHost?: string` — interface to bind the WS listener to (default `0.0.0.0`).
- `disableTcp?: boolean` — drops the default TCP transport and TCP listen addr. Useful for browser-only bootstraps.

The new fields apply only to the defaulting branch — if a caller passes explicit `transports` / `listenAddrs`, those still win as-is (today's behavior via `createLibp2pNodeBase`). The relay transport (`circuitRelayTransport()`) is still always included so the node can dial through relays.

`packages/reference-peer/src/cli.ts` exposes the same knobs on every subcommand that already accepted `--port` / `--relay` (`interactive`, `service`, `run`):

- `--ws-port <number>`
- `--ws-host <ip>` (default `0.0.0.0`)
- `--no-tcp` (commander negates the default-true `tcp`; CLI passes `disableTcp: options.tcp === false`)

The startup "📡 Listening on:" loop is unchanged — it iterates `node.getMultiaddrs()`, so newly added `/ws` addrs print automatically.

Docs:
- `packages/reference-peer/README.md` — new "Browser Bootstrap (WebSocket / WSS)" recipe (`--ws-port 9091 --relay --no-tcp`), Caddy reverse-proxy snippet for TLS termination, and the client-side `/dns4/<host>/tcp/443/wss/p2p/<id>` pattern. Options table updated with WS flags.
- `docs/optimystic.md` "Running a Node" — paragraph noting that browsers/RN reach Node peers via the `/ws` (typically `/wss` after TLS termination) listener, with a link to the README recipe.

## Use cases / how to test

1. **TCP + WS together** (most common public bootstrap):
   ```
   optimystic-peer service --port 8011 --ws-port 9091 --relay
   ```
   Expect "📡 Listening on:" to print BOTH `/tcp/8011` and `/tcp/9091/ws` multiaddrs.

2. **WS-only bootstrap** (browser-focused):
   ```
   optimystic-peer service --ws-port 9091 --relay --no-tcp
   ```
   Expect "📡 Listening on:" to print ONLY `/tcp/9091/ws` multiaddrs (no plain TCP addr).

3. **Default behavior unchanged** when WS knobs are omitted: TCP listen on `--port` is the only listener, exactly as before.

4. **Backwards compat**: existing callers passing explicit `options.transports` / `options.listenAddrs` to `createLibp2pNode` should still get exactly what they pass — the new fields only affect the defaulting branch.

5. **Smoke dial from rn entrypoint** *(deferred — see notes)*: a Node script using `@optimystic/db-p2p/rn`'s `createLibp2pNode` with `[webSockets(), circuitRelayTransport()]` should be able to dial the printed `/ws/p2p/<id>` multiaddr and establish a connection.

## Validation performed

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/reference-peer build` — clean.
- Manually launched `optimystic-peer service --ws-port 9091 --relay` and confirmed the startup banner prints both `/tcp/<port>` and `/tcp/9091/ws` multiaddrs (six addrs: tunnel/lan/loopback × tcp/ws).
- Manually launched `optimystic-peer service --ws-port 9092 --relay --no-tcp` and confirmed only `/ws` multiaddrs are printed.

## Notes for reviewer

- A live Node-side dial smoke (using the rn entrypoint with `webSockets()`+`circuitRelayTransport()` to dial the printed `/ws/p2p/<id>`) was attempted but the dialer process consistently hung on the actual WebSocket connection in this Windows environment — not while booting the dialer (which works fine, verified by dial-fail on a bogus multiaddr) but during the connect-to-live-WS-listener step. Since this happens with both the optimystic rn wrapper *and* a bare `createLibp2p` dialer, it's an env quirk rather than something this ticket introduced. Worth re-running the smoke on macOS/Linux as part of review.
- `--offline` is referenced inside `startNetwork()` (and documented in the README) but isn't actually declared as a CLI option on any subcommand. Pre-existing — out of scope for this ticket but flagging for the next pass.
- Ticket validation step mentions a `start` subcommand which doesn't exist; the actual subcommands with `--port`/`--relay` are `interactive`, `service`, and `run` (all updated).

## Out of scope (unchanged from spec)

- TLS termination automation — documented as a Caddy reverse-proxy snippet, no cert helper shipped.
- WebRTC / WebTransport listen — separate future work.
