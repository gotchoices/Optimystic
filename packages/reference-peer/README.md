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
- `-p, --port <number>`: Port to listen on (default: 0 = auto)
- `-b, --bootstrap <string>`: Comma-separated list of bootstrap multiaddrs
- `--bootstrap-file <path>`: Path to JSON file or directory containing bootstrap addresses (supports `mesh-ready.json` and `node-*.json` formats)
- `-i, --id <string>`: Optional peer id
- `-r, --relay`: Enable relay service
- `-n, --network <string>`: Network name (default: `optimystic`)
- `--fret-profile <profile>`: FRET profile: `edge` or `core` (default: `edge`)
- `-s, --storage <type>`: `memory` | `file` (default: `memory`)
- `--storage-path <path>`: Required when `--storage file`
- `--storage-capacity <bytes>`: Override storage capacity in bytes (used for ring selection / arachnode sizing)
- `--announce-file <path>`: Write node info (peerId, multiaddrs) to this JSON file for mesh launchers
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
