# Optimystic Reference Peer (CLI)

A developer-friendly CLI for running an Optimystic peer over libp2p and exercising collections and distributed transactions.

This tool supports:
- Interactive mode (join the network, then issue commands)
- Single-action mode (start → perform action → optionally stay connected)
- Single-node (no bootstrap) and multi-node (with bootstrap) flows
- Memory or file-backed storage

---

## Prerequisites
- Node.js 20+
- Yarn 1.x (workspaces)

From the repo root:

```sh
# Build p2p and the CLI (recommended sequence)
yarn --silent workspace @optimystic/db-p2p build
yarn --silent workspace @optimystic/reference-peer build
```

You can also build just the CLI:

```sh
yarn --silent workspace @optimystic/reference-peer build
```

---

## Quick Start

After building, the CLI is available as `yarn optimystic-peer` from the workspace root, or you can run `node packages/reference-peer/dist/src/cli.js` directly.

### Start the first node (no bootstrap)
This starts a libp2p node and drops you into interactive mode.

```sh
yarn optimystic-peer interactive --port 8011 --network optimystic
```

You will see listening multiaddrs like:

```
/ip4/127.0.0.1/tcp/8011/p2p/<PEER_ID>
```

Share one of these with other peers as a `--bootstrap` address.

### Start a second node (join via bootstrap)

```sh
yarn optimystic-peer interactive \
  --port 8021 \
  --network optimystic \
  --bootstrap "/ip4/127.0.0.1/tcp/8011/p2p/<PEER_ID>"
```

`--bootstrap` accepts a comma-separated list for multiple addresses.

---

## Browser Bootstrap (WebSocket / WSS)

Browsers (and the Sereus RN reference app) cannot dial raw TCP. Run a public bootstrap that listens on `/ws` and acts as a circuit-relay so browser peers can reach each other:

```sh
yarn optimystic-peer interactive \
  --ws-port 9091 \
  --relay \
  --no-tcp \
  --network optimystic \
  --announce-addr /dns4/bootstrap.example.com/tcp/443/wss
```

Browsers usually need WSS (TLS-terminated WebSocket) — terminate TLS in front of the peer with a reverse proxy. Caddy makes this a one-liner:

```caddy
bootstrap.example.com {
  reverse_proxy /* localhost:9091
}
```

(nginx works too; the only requirement is that it forwards the `Upgrade: websocket` request to the peer.) `--announce-addr` tells the peer to advertise the public `wss` address instead of the bound `0.0.0.0:9091` one. Without it the peer still *works* when dialed at the public address, but everything it says about itself — identify responses, relay reservations, DHT provider records — points at the unreachable bind address, so peers that learn about it indirectly cannot reach it. With the flag set, the startup banner and `--announce-file` report the announced address rather than the bound one. Clients dial:

```
/dns4/bootstrap.example.com/tcp/443/wss/p2p/<PEER_ID>
```

Notes:
- `--relay` is what lets two browser peers (each unable to accept inbound connections) talk to each other through this node.
- Drop `--no-tcp` if you want a single bootstrap that serves both Node-side TCP peers and browser/RN WebSocket peers. In that case use `--append-announce-addr` instead of `--announce-addr` to advertise the public `wss` address *in addition to* the bound TCP one, rather than replacing it.
- `--announce-addr` / `--append-announce-addr` are repeatable for multiple public addresses.
- You can combine `--ws-port` with `--port` — the "📡 Listening on:" startup line prints `node.getMultiaddrs()`, which is the *advertised* set: the bound listen addresses normally, but the `--announce-addr` set instead once that flag is given (`--append-announce-addr` adds to the bound ones rather than replacing them). Same for what `--announce-file` writes.

---

## Mesh Orchestrator (local multi-node)

`packages/reference-peer/src/mesh.ts` (built to `packages/reference-peer/dist/src/mesh.js`) launches a small local mesh of headless service peers and writes their info to `.mesh/node-*.json`. Useful for testing discovery/bootstrapping and for the provided VS Code launch profiles.

Run after building:

```sh
# Defaults: 2 nodes starting at port 8011
yarn workspace @optimystic/reference-peer mesh

# Configure size and base port
# macOS/Linux
MESH_NODES=3 MESH_BASE_PORT=8011 yarn workspace @optimystic/reference-peer mesh
# Windows (cmd)
set MESH_NODES=3 && set MESH_BASE_PORT=8011 && yarn workspace @optimystic/reference-peer mesh
```

What happens:
- Starts node-1 without bootstrap; writes `.mesh/node-1.json` containing `peerId` and `multiaddrs`
- Starts remaining nodes with `--bootstrap` set to node-1’s addresses
- Uses in-memory storage (`--storage memory`)
- Exits with Ctrl+C

Output file example (`.mesh/node-1.json`):

```json
{
  "peerId": "12D3Koo...",
  "multiaddrs": ["/ip4/127.0.0.1/tcp/8011/p2p/12D3Koo..."],
  "port": 8011,
  "networkName": "optimystic",
  "timestamp": 1700000000000,
  "pid": 12345
}
```

VS Code integration:
- "Optimystic: Start Mesh (N=3) then Debug Peer" runs `dist/mesh.js` with `MESH_NODES=3` and base port `8011`.
- "Optimystic: Debug Interactive Peer (bootstraps to mesh)" launches the CLI with `--bootstrap-file ./.mesh/node-1.json`. The CLI reads that file’s `multiaddrs` and automatically bootstraps.
- The compound "Optimystic: Mesh + Debug Peer" starts both together.

---

## Modes

- **Offline** (`--offline`):
  - Uses an in-process `LocalTransactor` (no network consensus)
  - Great for local development and testing without network overhead
- **Distributed** (default):
  - Uses `NetworkTransactor` with libp2p services for repo and cluster consensus
  - Works with or without `--bootstrap`; without bootstrap the node is isolated until peers connect
  - Suitable for exercising peer-to-peer coordination

Note: the `--offline` flag controls which transactor is used, not the presence of `--bootstrap`. A node started without `--bootstrap` but without `--offline` still uses the `NetworkTransactor` and can accept inbound connections.

---

## Storage Options

- `--storage memory` (default): keeps data in-memory for the process lifetime
- `--storage file` with `--storage-path <dir>`: persists data to disk

Examples:

```sh
# Memory (default)
yarn optimystic-peer interactive --port 8011

# File-backed
yarn optimystic-peer interactive \
  --port 8011 \
  --storage file \
  --storage-path "./.optimystic-storage/node-8011"
```

---

## Interactive Mode

```sh
yarn optimystic-peer interactive [options]
```

Options:
- `-p, --port <number>`: TCP port to listen on (default: 0 = auto)
- `--ws-port <number>`: WebSocket port to listen on (e.g. `9091`); enables a `/ws` listen so browser and React Native peers can dial this node
- `--ws-host <ip>`: Interface for the WS listener (default: `0.0.0.0`)
- `--no-tcp`: Drop the default TCP listen — useful for browser-only bootstraps that listen on `/ws` only
- `-b, --bootstrap <string>`: Comma-separated list of bootstrap multiaddrs
- `--bootstrap-file <path>`: Path to JSON file or directory containing bootstrap addresses (supports `mesh-ready.json` and `node-*.json` formats)
- `-i, --id <string>`: Optional peer id
- `-r, --relay`: Enable relay service (required for browser-only peers to reach each other through this node)
- `-n, --network <string>`: Network name (default: `optimystic`)
- `--fret-profile <profile>`: FRET profile: `edge` or `core` (default: `edge`)
- `-s, --storage <type>`: `memory` | `file` (default: `memory`)
- `--storage-path <path>`: Required when `--storage file`
- `--storage-capacity <bytes>`: Override storage capacity in bytes (used for ring selection / arachnode sizing)
- `--cluster-size <number>`: Desired cluster size per key (positive integer). Overrides the `libp2p-node-base` default (10). Must match peers in the same network — e.g. browser peers built with `clusterSize: 3` need service peers started with `--cluster-size 3`. Accepted by `interactive`, `service`, and `run`.
- `--assumed-cluster-size <number>`: How many peers you assert this deployment genuinely runs (positive integer). This is a *different* question from `--cluster-size`, which is how many copies to keep. Two things read it, and when you leave it unset they fall back to **different** values on purpose:
  - The **membership admission gate**, only when the node has no confident network-size estimate — which is exactly what a partition causes. On that path the declared peer set must be at least 75% of this number. Unset it defaults to 2, so an unconfigured small mesh can still transact; a large deployment should set it to its real cohort size, otherwise a minority side of a partition can still assemble a write.
  - The **read-repair/reconcile corroboration floor**, unconditionally: how many peers must agree before this node adopts a repaired block. Unset it defaults to `--cluster-size` (10 by default) — the strict direction, so a node whose view of the network has been shrunk by a partition (or by an attacker with routing influence) still demands two independent peers rather than trusting one. What the fallback actually costs is only the relaxation *below* two, so the deployment it strands is the **two-machine** one: its single peer can never second itself, and it needs either this flag or an honest `--cluster-size` to repair a damaged block at all. Without one, repairs decline and log `cluster-fetch:no-quorum` every pass, plus `cluster-fetch:repair-deadlock` once per block once the node can *prove* the cohort is too small to reach the quorum however its peers answer. Three machines repairs unconfigured — but with no margin at all, since the reader has exactly two peers and needs both to answer; four or more is the first size that survives one unreachable peer. The node says which situation it is in once at startup, as `repair-fault-tolerance`. See [docs/internals.md](../../docs/internals.md) for the size-by-size table.

  So a small mesh transacts unconfigured; a **two-machine** one also needs one of the two flags to *self-repair*. Setting `--assumed-cluster-size` does not lower the replication factor. Accepted by `interactive`, `service`, and `run`.
- `--super-majority-threshold <number>`: Super-majority threshold as a fraction in (0, 1]. Overrides the `libp2p-node-base` default (0.75, the shared `DEFAULT_SUPER_MAJORITY_THRESHOLD`). Pair with small `--cluster-size` values: `Math.ceil(3 * 0.75) = 3` demands unanimity on a 3-peer cluster, so a 3-peer mesh typically wants `--super-majority-threshold 0.51` (rounds to 2-of-3) to leave one peer of slack. Must match peers in the same network — coordinator-side approvals are counted against this value on every cluster member. Accepted by `interactive`, `service`, and `run`.
- `--announce-file <path>`: Write node info (peerId, multiaddrs) to this JSON file for mesh launchers
- `--announce-addr <multiaddr>`: Multiaddr to advertise INSTEAD OF the listen addrs — for a node behind a NAT/reverse proxy/TLS front that binds one address but is reachable at another (e.g. `/dns4/bootstrap.example.com/tcp/443/wss`). Repeatable; when set, replaces the advertised set entirely
- `--append-announce-addr <multiaddr>`: Multiaddr to advertise IN ADDITION TO the listen addrs. Repeatable; ignored while `--announce-addr` is set
- `--offline`: Use local transactor instead of network transactor (no distributed consensus)

Once started, you’ll see a prompt:

```
🎮 Interactive mode started. Type "help" for commands, "exit" to quit.
optimystic>
```

Available interactive commands:
- `help` – Show command help
- `create-diary <name>` – Create a diary collection
- `add-entry <diary> <content>` – Append an entry
- `list-diaries` – List created diaries in this session
- `read-diary <name>` – Stream all entries
- `exit` / `quit` – Disconnect and exit

---

## Service Mode (Headless)

```sh
yarn optimystic-peer service [options]
```

Starts a headless service node with no interactive prompt. The node stays alive until killed. Useful for mesh nodes in launch profiles and automated testing.

Accepts the same network/storage options as interactive mode (except `--offline`).

---

## Single-Action Mode

```sh
yarn optimystic-peer run --action <action> [options]
```

Actions:
- `create-diary` requires `--diary <name>`
- `add-entry` requires `--diary <name>` and `--content <text>`
- `list-diaries`
- `read-diary` requires `--diary <name>`

Common options:
- `--stay-connected` – remain connected and switch to interactive mode after the action
- All network/storage options available in interactive mode are supported here, too

Examples:

```sh
# Create a diary and disconnect
yarn optimystic-peer run \
  --action create-diary \
  --diary my-diary \
  --port 8001

# Add an entry
yarn optimystic-peer run \
  --action add-entry \
  --diary my-diary \
  --content "Hello, Optimystic!" \
  --port 8002

# Read entries
yarn optimystic-peer run \
  --action read-diary \
  --diary my-diary \
  --port 8003

# List and then stay connected to keep working
yarn optimystic-peer run \
  --action list-diaries \
  --stay-connected \
  --port 8004
```

---

## Troubleshooting

- "Bootstrap requires a list of peer addresses"
  - Omit `--bootstrap` when starting the first node
  - Ensure you’ve rebuilt the packages so bootstrap discovery is conditional
- "_started not set"
  - Fixed: custom libp2p services now pass only the required `logger` and `registrar`
  - Rebuild `@optimystic/db-p2p` and `@optimystic/reference-peer`
- No peers found in distributed mode
  - Verify `--bootstrap` addresses are correct and reachable
  - You can provide multiple bootstrap addresses (comma-separated)
- Data not persisting across restarts
  - Use `--storage file --storage-path <dir>` to persist locally

---

## Testing

The reference peer includes integration tests that exercise the full distributed stack:

```sh
# Build dependencies first
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/reference-peer build

# Run the mocha test suite (3-node mesh)
yarn workspace @optimystic/reference-peer test

# Run the standalone quick test script (for debugging)
yarn workspace @optimystic/reference-peer test:quick

# Run with debug logging
yarn workspace @optimystic/reference-peer test:quick:debug
```

The test suite (`test/distributed-diary.spec.ts`) spins up a 3-node mesh with real libp2p connections and tests:
- Cross-node diary creation and access
- Distributed entry propagation across all nodes
- Storage consistency verification
- Concurrent writes from multiple nodes

See [test/README.md](./test/README.md) for debugging tips and VS Code launch configurations.

---

## Notes
- In offline mode, operations execute locally (no network coordination). This is ideal for development.
- In distributed mode (default), operations are coordinated via libp2p protocols for repo and cluster.
- Multiaddrs printed at startup can be used as bootstrap addresses for subsequent nodes.

---

## Development

Rebuild after making changes:

```sh
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/reference-peer build
```

After building, the CLI is available as:

```sh
# From workspace root (recommended)
yarn optimystic-peer interactive --port 8011

# Or via the start script
yarn workspace @optimystic/reference-peer start -- interactive --port 8011
```

---

## License
This package is part of the Optimystic repository. See the root project for licensing information.
