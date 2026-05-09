# @optimystic/db-p2p-storage-web

IndexedDB-backed storage backend for Optimystic browser peers. Provides:

- **`IndexedDBRawStorage`** — implements `IRawStorage` so a browser node persists
  block metadata, revisions, pending transactions, committed transactions, and
  materialized blocks across page reloads.
- **`IndexedDBKVStore`** — implements `IKVStore` for the persistent transaction
  state used to recover crashed two-phase commits.
- **`loadOrCreateBrowserPeerKey`** — generates an Ed25519 libp2p private key on
  first run and persists it in the same IndexedDB database, giving the browser
  peer a stable, reload-surviving identity.

This package is browser-only — it imports no Node built-ins. Counterparts:

- `@optimystic/db-p2p-storage-rn` — React Native (MMKV)
- `@optimystic/db-p2p-storage-fs` — Node filesystem

## Install

```bash
yarn add @optimystic/db-p2p-storage-web @optimystic/db-p2p @optimystic/db-core
```

`@optimystic/db-p2p` is consumed via its `react-native` / `./rn` entry point so
the Node-only filesystem code does not get bundled into the browser:

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
```

## Usage

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import {
  openOptimysticWebDb,
  IndexedDBRawStorage,
  IndexedDBKVStore,
  loadOrCreateBrowserPeerKey,
} from '@optimystic/db-p2p-storage-web';

const db = await openOptimysticWebDb();          // single shared handle
const rawStorage = new IndexedDBRawStorage(db);  // → IRawStorage
const kvStore = new IndexedDBKVStore(db);        // → IKVStore (txn recovery)
const privateKey = await loadOrCreateBrowserPeerKey(db);

const libp2p = await createLibp2pNode({
  bootstrapNodes: [/* … */],
  networkName: 'my-network',
  privateKey,
});
```

The same `IDBPDatabase` handle is shared by all three consumers — IndexedDB
permits concurrent transactions across disjoint object stores, so the storage
layer parallelises naturally.

## Persistence semantics

The package opens a single IndexedDB database (`optimystic` by default) with
six object stores:

| Store          | Key                  | Value                  |
|----------------|----------------------|------------------------|
| `metadata`     | `blockId`            | `BlockMetadata`        |
| `revisions`    | `[blockId, rev]`     | `ActionId`             |
| `pending`      | `[blockId, actionId]`| `Transform`            |
| `transactions` | `[blockId, actionId]`| `Transform`            |
| `materialized` | `[blockId, actionId]`| `IBlock`               |
| `kv`           | `key`                | `string` or `Uint8Array` |

`listRevisions` and `listPendingTransactions` use real IndexedDB range cursors
— never `getAllKeys()` + JS filter — so list latency stays bounded as the store
grows. `promotePendingTransaction` runs as a single `readwrite` transaction
spanning `pending` and `transactions`, so the move is atomic across crashes.

`getApproximateBytesUsed()` returns `(await navigator.storage.estimate()).usage`,
which is **per-origin**, not per-database. That is adequate for `StorageMonitor`
— which uses the figure as an advisory ring-selection input — but is not a
precise per-database accounting.

## Identity

`loadOrCreateBrowserPeerKey(db, keyName?)` writes the libp2p private key as
raw protobuf bytes (`Uint8Array`) under `keyName` in the `kv` store
(default `peer-private-key`). IndexedDB stores typed arrays natively, so no
base64 round-trip is needed. To rotate the identity, delete that one key:

```ts
await db.delete('kv', 'peer-private-key');
```

To wipe the entire backing store (debugging / dev reset):

```ts
indexedDB.deleteDatabase('optimystic');
```

## Tests

`yarn test` runs the spec suite under [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb)
in Node so CI doesn't need a real browser. Production code only uses the
IndexedDB W3C API, so fake-indexeddb is a faithful behavioural surrogate.
