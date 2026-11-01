# @optimystic/db-p2p-storage-rn

React Native LevelDB storage backend for `@optimystic/db-p2p`. Lets a React
Native peer persist Optimystic block data across app restarts using an
on-device LevelDB. Provides:

- **`LevelDBRawStorage`** — implements `IRawStorage` so an RN node persists
  block metadata, revisions, pending transactions, committed transactions,
  commit proofs, and materialized blocks.
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

const db = openOptimysticRNDb({
  openFn: (name, createIfMissing, errorIfExists) =>
    new LevelDB(name, createIfMissing, errorIfExists),
  WriteBatch: LevelDBWriteBatch,
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

The same handle is shared by all three consumers. Close the storage and the
key-value store before the handle, and the handle last:

```ts
await rawStorage.close();   // applies what it still holds, disarms its timers
await kvStore.close();      // commits what it still holds, disarms its timer
await db.close();
```

Neither `close()` closes the shared handle. A write a store still holds when the
handle is closed under it is lost, and a timer it still has armed would fire on
a closed handle.

## Persistence semantics

Everything lives in one LevelDB database (`optimystic` by default), one
ordered byte keyspace partitioned by a leading tag byte (`src/keys.ts`).
`LevelDBRawStorage` is the shared `KvRawStorage` kernel over a
`WriteGroupDriver` over a `JournalBatchBackend` over a `LevelDBJournalStore`:
the kernel owns all JSON/UTF-8 serialization, so the six block-storage stores
hold opaque kernel-encoded bytes. The keys and the logical types the kernel
decodes them back into are unchanged from earlier builds, so data written by
one reads unchanged, and a database an earlier build wrote has no journal, so
the first open over it applies nothing.

| Tag | Store | Key suffix | Decoded (logical) type |
|-----|-------|------------|------------------------|
| `0x01` | `metadata` | `blockId` | `BlockMetadata` |
| `0x02` | `revisions` | `blockId`, rev (8 bytes big-endian) | `ActionId` |
| `0x03` | `pending` | `blockId`, `actionId` | `Transform` |
| `0x04` | `transactions` | `blockId`, `actionId` | `Transform` |
| `0x05` | `materialized` | `blockId`, `actionId` | `IBlock` |
| `0x06` | `proofs` | `blockId`, rev (8 bytes big-endian) | `BlockCommitProof` |
| `0x07` | `journal` | the record's sequence (8 bytes big-endian), or nothing for the applied-through mark | a journal record as bytes, or the number of the last record applied — owned by `LevelDBJournalStore` |
| `0x10` | `kv` | the key, UTF-8 | a string (not kernel-backed) |
| `0x20` | `identity` | the key name, UTF-8 | raw protobuf bytes of the private key |

`listRevisions` and `listPendingTransactions` are range-bounded native scans,
drained before any result is yielded so a native iterator never stays open
across a consumer's `await`. `promotePendingTransaction` records two entries of
one write group — the committed row's put and the pending row's delete — applied
in that group's batch, so the move is atomic across crashes.

## Durability

A write resolves into memory and is served from there; `flush()` hands every
write made since the last flush to the journal backend as **one group**, and
every write this package makes to LevelDB is one `WriteBatch` — the handle
surface has no single put or delete — so a group lands whole or not at all.

What a crash loses today, with `rn-leveldb` 3.11:

| Crash | Lost |
|---|---|
| the app's process | a group not yet flushed, still in memory, whole; nothing a flush has resolved for |
| a power cut or operating-system crash | any write the operating system has not yet written out, whatever the window; a later group may survive while an earlier one is lost |

The second row is the binding's: `rn-leveldb` writes every batch with LevelDB's
default options, which hand the bytes to the operating system without syncing,
and offers no way to ask for a sync. So `LevelDBRawStorage` reports
`durability: 'process-crash'`, the backend applies each group at once as one
unsynced batch and journals nothing, every `flush({ withinMs })` is treated as
strict, and the node's start-up line says such a store cannot keep the window.

The synced path is built, and it runs in this package's suite over
`classic-level`, which can sync. On a handle whose `canSync` is true the
backend journals: a relaxed `flush({ withinMs })` — what a node uses for a write
its cohort also holds, see [storage.md §How long a write may wait for its sync](../db-p2p/docs/storage.md#how-long-a-write-may-wait-for-its-sync) —
appends the group as one journal record in one unsynced batch and resolves,
and one synced batch by the earliest deadline, or a strict flush before then,
applies every record appended since the last apply, in order, sets the
applied-through mark and deletes them. Every apply carries every byte it
applies, so what a power cut leaves is a prefix of the groups: a journal record
LevelDB lost is a missing number, and recovery at the next open applies the
consecutive run before it and discards everything after it (details in
[storage.md §6, *The journal backend*](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved)).
The step that turns it on for phones is upstream: a release of `rn-leveldb`
whose batch write accepts a sync flag (the blocked ticket
`react-native-storage-syncs-once-rn-leveldb-can`). The adapter in this package
then reports `canSync: true`, the storage reports `'power-loss'`, and nothing
above it changes.

A failed batch latches the storage: every later write, flush and
`whenDurable()` rejects with `StoreFailedError` until the app reopens the store
(rule 5 of the flush contract,
[storage.md §6](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved)).

`LevelDBKVStore` writes through a `WriteGroup` over its keys the same way:
`set` and `delete` resolve into memory, and `flush()` commits everything since
the last flush as one batch, synced where the handle can — every flush of this
store is strict, so nothing of it is ever journaled. `whenDurable()` and
`close()` are the group's.

## Identity

`loadOrCreateRNPeerKey(db, keyName?)` writes the libp2p private key as raw
protobuf bytes under `keyName` (default `peer-private-key`) in one batch,
synced where the handle can, so a power cut right after first start cannot give
the node a different peer id next time. LevelDB stores bytes natively, so no
base64 round-trip is needed.

## Debug logging

`DEBUG=` does not work in React Native, and without it every `optimystic:*`
log channel is silently off — so an empty device capture proves nothing.
Turn logging on in code, early in your app's entry point:

```ts
import { enableOptimysticLogging } from '@optimystic/db-core';

enableOptimysticLogging('optimystic:*');
```

It prints one `optimystic logging on: …` confirmation line; look for that
first. See `docs/debugging.md` § "Turning logging on" in the repository for
the `log` option, libp2p's separate switch, and the cost on device.

## Tests

`yarn test` runs the spec suite under `classic-level` in Node, so CI needs no
device. `classic-level` honours LevelDB's `sync` option, so the suite
exercises the journaled, synced path a phone will take once its binding can
sync, and checks which batches were written and whether each asked to sync;
nothing here cuts the power. The phone case is covered by presenting the same
binding as unable to sync.

## Related packages

- **[@optimystic/db-p2p](../db-p2p)** — the distributed layer this backend
  plugs into (repo/cluster/coordination + storage interfaces).
- `@optimystic/db-p2p-storage-fs` — Node filesystem backend.
- `@optimystic/db-p2p-storage-ns` — NativeScript (SQLite) backend.
- `@optimystic/db-p2p-storage-web` — Browser (IndexedDB) backend.
