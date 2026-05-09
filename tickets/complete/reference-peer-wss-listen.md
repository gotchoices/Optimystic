---
description: WebSocket (ws) listen support in optimystic-peer + db-p2p so browsers/RN can dial Node bootstraps
files: packages/db-p2p/src/libp2p-node.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/reference-peer/src/cli.ts, packages/reference-peer/README.md, docs/optimystic.md
---

## What shipped

The Node entrypoint `createLibp2pNode` (`packages/db-p2p/src/libp2p-node.ts`) and the `optimystic-peer` CLI now expose three new defaulting-branch knobs so a single bootstrap can serve browser / React Native peers over WebSockets alongside (or instead of) plain TCP:

- **`wsPort?: number`** — when set, appends `webSockets()` to the default transports and `/ip4/<wsHost>/tcp/<wsPort>/ws` to the default listen addrs.
- **`wsHost?: string`** — interface bound by the WS listener (default `0.0.0.0`).
- **`disableTcp?: boolean`** — drops the default TCP transport and listen addr. Useful for browser-only bootstraps fronted as `/wss`.

The relay transport (`circuitRelayTransport()`) is always included so the node can still dial through relays. These fields apply only when the caller relies on defaulting; explicit `options.transports` / `options.listenAddrs` still win as-is — the base factory's `??` precedence is unchanged.

The CLI mirrors these on every subcommand that already accepted `--port` / `--relay` (`interactive`, `service`, `run`):

- `--ws-port <number>` (validated as a finite, non-negative integer; `0` allowed for auto-assign)
- `--ws-host <ip>` (default `0.0.0.0`)
- `--no-tcp` (commander negates the default-true `tcp`; CLI passes `disableTcp: options.tcp === false`)

The startup "📡 Listening on:" loop iterates `node.getMultiaddrs()`, so newly bound `/ws` addrs print automatically.

## Key files

- `packages/db-p2p/src/libp2p-node.ts` — defaulting branch composes transports + listen addrs from `wsPort`/`wsHost`/`disableTcp`.
- `packages/db-p2p/src/libp2p-node-base.ts` — `NodeOptions` types for the new fields; `?? defaults.*` precedence preserved.
- `packages/reference-peer/src/cli.ts` — three new flags wired into `interactive` / `service` / `run`; `wsPort` parsed and validated; `disableTcp = options.tcp === false`.
- `packages/reference-peer/README.md` — new "Browser Bootstrap (WebSocket / WSS)" recipe with Caddy snippet, client-side `/dns4/<host>/tcp/443/wss/p2p/<id>` example, and updated options tables.
- `docs/optimystic.md` — "Running a Node" paragraph noting that browsers/RN reach Node peers via the `/ws` listener (typically `/wss` after TLS termination).

## Validation

Builds:
- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/reference-peer build` — clean.

Smoke (Windows, against built `dist/`):
- `optimystic-peer service --port 8095 --ws-port 9096 --relay` → "📡 Listening on:" prints 3 `/tcp/8095` addrs **and** 3 `/tcp/9096/ws` addrs (tunnel/lan/loopback × tcp/ws).
- `optimystic-peer service --ws-port 9095 --relay --no-tcp` → only `/tcp/9095/ws` addrs printed (no plain TCP listener).
- `optimystic-peer service --port 8097` (defaults) → only `/tcp/8097` addrs — pre-existing behavior unchanged.

Backwards-compat: callers passing explicit `options.transports` / `options.listenAddrs` to `createLibp2pNode` still get exactly what they pass — the new fields only affect the defaulting branch (verified by reading `libp2p-node-base.ts:185-186`).

## Usage

Browser-focused bootstrap (the `/wss` recipe documented in the README):

```sh
yarn optimystic-peer service --ws-port 9091 --relay --no-tcp
```

…fronted by Caddy for TLS termination:

```caddy
bootstrap.example.com {
  reverse_proxy /* localhost:9091
}
```

…dialed by browser / RN clients as:

```
/dns4/bootstrap.example.com/tcp/443/wss/p2p/<PEER_ID>
```

Mixed bootstrap (Node TCP + browser WS on one peer):

```sh
yarn optimystic-peer service --port 8011 --ws-port 9091 --relay
```

## Notes / known limits

- A live Node-side dial smoke (using the rn entrypoint with `webSockets()` + `circuitRelayTransport()` to dial the printed `/ws/p2p/<id>`) hung on the actual WebSocket connection in the original Windows test environment. The listener side is clearly working (multiaddrs visible, transport bound, dialer fails fast on bogus addrs). This is a dialer-side env quirk — worth re-running the smoke on macOS/Linux opportunistically.
- `--offline` is referenced inside `startNetwork()` and in the README but isn't declared as a CLI option on any subcommand — pre-existing, flagged for a follow-up pass.

## Out of scope

- TLS termination automation — documented as a Caddy reverse-proxy snippet; no cert helper shipped.
- WebRTC / WebTransport listen — separate future work.
