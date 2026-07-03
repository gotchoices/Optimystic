# @optimystic/db-p2p-storage-rn

React Native LevelDB storage backend for `@optimystic/db-p2p`. Lets a React
Native peer persist Optimystic block data across app restarts using an
on-device LevelDB. Provides:

- **`LevelDBRawStorage`** — implements `IRawStorage` so an RN node persists
  block metadata, revisions, pending transactions, committed transactions,
  and materialized blocks.
- **`LevelDBKVStore`** — implements `IKVStore` for the persistent
  transaction state used to recover crashed two-phase commits.
- **`loadOrCreateRNPeerKey`** — generates an Ed25519 libp2p private key on
  first run and persists it in the same LevelDB, giving the RN peer a
  stable, restart-surviving identity.
- **`openOptimysticRNDb` / `wrapRNLevelDB`** — open/wrap helpers that adapt
  the native `rn-leveldb` handle to the internal key/value interface.

## Peer dependency

The native store is [`rn-leveldb`](https://www.npmjs.com/package/rn-leveldb),
declared as a **peer dependency** — the host app installs and pins the
version it needs (same approach as `@nativescript-community/sqlite` for the
`-storage-ns` package). This package never imports `rn-leveldb` directly;
the caller passes the `LevelDB` constructor (wrapped as an open function) in,
which keeps the package's unit tests runnable under plain Node (the tests use
`classic-level` as a Node LevelDB surrogate).

## Usage

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import {
  openOptimysticRNDb,
  LevelDBRawStorage,
  LevelDBKVStore,
  loadOrCreateRNPeerKey,
} from '@optimystic/db-p2p-storage-rn';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';

const db = await openOptimysticRNDb({
  openFn: (name, createIfMissing, errorIfExists) =>
    new LevelDB(name, createIfMissing, errorIfExists),
  writeBatchCtor: LevelDBWriteBatch,
});
const rawStorage = new LevelDBRawStorage(db);   // → IRawStorage
const kvStore = new LevelDBKVStore(db);         // → IKVStore (txn recovery)
const privateKey = await loadOrCreateRNPeerKey(db);

const libp2p = await createLibp2pNode({
  bootstrapNodes: [/* … */],
  networkName: 'my-network',
  privateKey,
});
```

Use the Node-free `/rn` entry point of `@optimystic/db-p2p` so the Node-only
TCP transport doesn't get bundled into the React Native app.

## Related packages

- **[@optimystic/db-p2p](../db-p2p)** — the distributed layer this backend
  plugs into (repo/cluster/coordination + storage interfaces).
- `@optimystic/db-p2p-storage-fs` — Node filesystem backend.
- `@optimystic/db-p2p-storage-ns` — NativeScript (SQLite) backend.
- `@optimystic/db-p2p-storage-web` — Browser (IndexedDB) backend.
