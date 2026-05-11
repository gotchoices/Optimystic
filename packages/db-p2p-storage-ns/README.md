# @optimystic/db-p2p-storage-ns

SQLite-backed storage backend for Optimystic NativeScript peers (iOS and
Android, native — not React Native). Provides:

- **`SqliteRawStorage`** — implements `IRawStorage` so a NativeScript node
  persists block metadata, revisions, pending transactions, committed
  transactions, and materialized blocks across app restarts.
- **`SqliteKVStore`** — implements `IKVStore` for the persistent transaction
  state used to recover crashed two-phase commits.
- **`loadOrCreateNSPeerKey`** — generates an Ed25519 libp2p private key on
  first run and persists it as a BLOB in the same SQLite database, giving
  the NativeScript peer a stable, restart-surviving identity.

This package targets NativeScript apps (iOS + Android via the
[`@nativescript-community/sqlite`](https://github.com/nativescript-community/sqlite)
plugin). It cannot run in plain Node, browsers, or React Native — use the
sibling adapter for each of those:

- `@optimystic/db-p2p-storage-fs` — Node filesystem
- `@optimystic/db-p2p-storage-rn` — React Native (MMKV)
- `@optimystic/db-p2p-storage-web` — Browser (IndexedDB)

## Install

```bash
yarn add @optimystic/db-p2p-storage-ns @optimystic/db-p2p @optimystic/db-core \
         @nativescript-community/sqlite
```

`@nativescript-community/sqlite` is a peer dependency — the host app pins the
version it needs (same approach as `react-native-mmkv` for the RN package).

Use the Node-free `/rn` entry point of `@optimystic/db-p2p` so the Node-only
TCP transport doesn't get bundled into the NativeScript app:

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
```

## Usage

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import {
  openOptimysticNSDb,
  SqliteRawStorage,
  SqliteKVStore,
  loadOrCreateNSPeerKey,
} from '@optimystic/db-p2p-storage-ns';

const db = await openOptimysticNSDb();           // single shared handle
const rawStorage = new SqliteRawStorage(db);     // → IRawStorage
const kvStore = new SqliteKVStore(db);           // → IKVStore (txn recovery)
const privateKey = await loadOrCreateNSPeerKey(db);

const libp2p = await createLibp2pNode({
  bootstrapNodes: [/* … */],
  networkName: 'my-network',
  privateKey,
});
```

The same handle is shared by all three consumers. SQLite serializes writes
inside a single connection; reads/writes are short-lived enough that
single-connection contention is a non-issue for a client peer.

## Persistence model

The package opens a single SQLite database (`optimystic.sqlite` by default
in the NativeScript app's documents directory) with six tables:

| Table          | Key                              | Value                            |
|----------------|----------------------------------|----------------------------------|
| `metadata`     | `block_id`                       | `BlockMetadata` (JSON)           |
| `revisions`    | `(block_id, rev)`                | `action_id`                      |
| `pending`      | `(block_id, action_id)`          | `Transform` (JSON)               |
| `transactions` | `(block_id, action_id)`          | `Transform` (JSON)               |
| `materialized` | `(block_id, action_id)`          | `IBlock` (JSON)                  |
| `kv`           | `key`                            | `s_val` (TEXT) or `b_val` (BLOB) |

Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = OFF`.
Schema is versioned via `PRAGMA user_version`.

`listRevisions` and `listPendingTransactions` issue bounded
`SELECT … ORDER BY` queries — never `SELECT * FROM <table>` + JS filter —
so list latency stays bounded as the tables grow.
`promotePendingTransaction` runs as a single `BEGIN; INSERT…; DELETE…; COMMIT;`
inside `SqliteDb.transaction(fn)`, so the move is atomic across crashes —
unlike the MMKV adapter, which has to maintain a separate pending-index row.

`getApproximateBytesUsed()` returns `page_count × page_size` from PRAGMAs.
This is the SQLite database-file footprint; it is **not** a per-block figure.
That's adequate for `StorageMonitor` — which uses the value as an advisory
ring-selection input.

## Identity

`loadOrCreateNSPeerKey(db, keyName?)` writes the libp2p private key as raw
protobuf bytes (`Uint8Array`) into the `kv` table's `b_val` column under
`keyName` (default `peer-private-key`). SQLite stores BLOBs natively — no
base64 round-trip. To rotate the identity, delete that one row:

```ts
await db.prepare('DELETE FROM kv WHERE key = ?').run('peer-private-key');
```

To wipe the entire backing store (debugging / dev reset), delete the
underlying SQLite file.

## Tests

`yarn test` runs the spec suite under Node's built-in `node:sqlite` driver
(Node 22+ — default-enabled on Node 23+). Production code only depends on
the package-private `SqliteDb` interface, so the Node driver is a faithful
behavioural surrogate for the NativeScript plugin. The suite never imports
`@nativescript-community/sqlite`, so the plugin's native bindings don't need
to be installed to run tests.
