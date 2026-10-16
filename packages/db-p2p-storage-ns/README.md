# @optimystic/db-p2p-storage-ns

SQLite-backed storage backend for Optimystic NativeScript peers (iOS and
Android, native — not React Native). Provides:

- **`SqliteRawStorage`** — the `IRawStorage` a NativeScript node uses to
  persist block metadata, revisions, pending transactions, committed
  transactions, commit proofs, and materialized blocks across app restarts.
  It is the shared `KvRawStorage` kernel over a `WriteGroupDriver` over
  `SqliteBatchBackend`: the kernel owns all JSON serialization, the driver
  holds each group of writes in memory until it is flushed, and the backend
  applies the group as one SQLite transaction over the six tables.
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

The same handle is shared by all three consumers. SQLite allows at most one
open transaction per connection, so the wrapper serializes every mutating
operation — `exec`, statement `run`, and whole `transaction` bodies — on a
per-connection FIFO mutex. Without it, two concurrent `transaction` bodies
would each `BEGIN` on the shared connection; the second nests, throws, and its
rollback discards the first's still-open writes. Reads (`get`/`all`) stay off
the mutex to preserve read concurrency.

Close the storage before the handle, and the handle last:

```ts
await rawStorage.close();   // flushes what it still holds, syncs it, disarms its timers
await kvStore.flush();
await db.close();
```

`SqliteRawStorage.close()` does not close the shared handle. A write the
storage still holds when the handle is closed under it is lost, and a timer it
still has armed would fire on a closed connection.

## Persistence model

The package opens a single SQLite database (`optimystic.sqlite` by default
in the NativeScript app's documents directory) with eight tables. The six
block-storage tables keep their original columns and keys, but their value
columns are **BLOB**: `SqliteBatchBackend` binds/reads the kernel's raw
`Uint8Array` bytes and the shared `KvRawStorage` kernel owns the JSON/UTF-8
codec. SQLite stores a `Uint8Array` as a BLOB and returns it as a `Uint8Array`,
so bytes round-trip exactly (a TEXT column would risk UTF-8-coercing non-ASCII
JSON bytes). The "Decoded" column is the logical type the kernel decodes back
into; keys stay TEXT/INTEGER.

| Table             | Key                              | Stored value | Decoded (logical) type |
|-------------------|----------------------------------|--------------|------------------------|
| `metadata`        | `block_id`                       | `BLOB`       | `BlockMetadata`        |
| `revisions`       | `(block_id, rev)`                | `BLOB` (`action_id` col) | `ActionId`     |
| `pending`         | `(block_id, action_id)`          | `BLOB`       | `Transform`            |
| `transactions`    | `(block_id, action_id)`          | `BLOB`       | `Transform`            |
| `proofs`          | `(block_id, rev)`                | `BLOB`       | `BlockCommitProof`     |
| `materialized`    | `(block_id, action_id)`          | `BLOB`       | `IBlock`               |
| `kv`              | `key`                            | `s_val` (TEXT) or `b_val` (BLOB) | — (not kernel-backed) |
| `durability_mark` | `id` (always 1)                  | `n` (INTEGER), a counter nothing reads | — (the row a sync commits when it has nothing else to write) |

Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = OFF`.
Schema is versioned via `PRAGMA user_version`.

`listRevisions` and `listPendingTransactions` issue bounded
`SELECT … ORDER BY` queries — never `SELECT * FROM <table>` + JS filter —
so list latency stays bounded as the tables grow.
`promotePendingTransaction` records two entries of one write group — the
committed row's insert and the pending row's delete — applied in that group's
transaction, so the move is atomic across crashes.

`getApproximateBytesUsed()` returns `page_count × page_size` from PRAGMAs.
This is the SQLite database-file footprint; it is **not** a per-block figure.
That's adequate for `StorageMonitor` — which uses the value as an advisory
ring-selection input.

## Durability

`SqliteRawStorage` reports `durability: 'power-loss'`. A write resolves into
memory and is served from there; `flush()` applies every write made since the
last flush as **one SQLite transaction**, so a group lands whole or not at all.
In write-ahead-log mode a commit appends the group's frames to one append-only
log file, each frame checksummed over the frames before it, and recovery stops
at the first bad frame, so what a power cut leaves is a prefix of the committed
groups, in order. Under `synchronous = NORMAL` a commit does not wait for the
disk; a commit under `FULL` syncs the log, and with it every earlier commit on
the database. So:

- a strict `flush()` (no `withinMs`, or 0) commits the group under `FULL` and
  resolves once it is on disk;
- a relaxed `flush({ withinMs })` — what a node uses for a write its cohort
  also holds, see [storage.md §How long a write may wait for its sync](../db-p2p/docs/storage.md#how-long-a-write-may-wait-for-its-sync) —
  commits under `NORMAL` and resolves at once; one `FULL` commit by the earliest
  deadline, or a strict flush before then, syncs every group committed since the
  last sync. `whenDurable()` resolves once the groups flushed so far are synced.

What a crash loses:

| Crash | Lost |
|---|---|
| the app's process | a group not yet flushed, still in memory; nothing a flush has resolved for |
| a power cut or operating-system crash | at most the groups still inside their window, always the most recent ones, each whole; nothing a strict flush has resolved for, and nothing once the window has passed |

`SqliteDb.transaction(fn, { synced: true })` is the primitive: inside the
connection mutex slot it sets `PRAGMA synchronous = FULL`, runs
`BEGIN IMMEDIATE … COMMIT`, and restores `NORMAL` afterwards, after a rollback
too. `syncSqliteDb(db)` is a synced transaction that bumps the one-row
`durability_mark` table, so a sync with no rows of its own still has a frame to
commit; `SqliteKVStore.flush()` runs it when the store wrote since its last
flush, and `loadOrCreateNSPeerKey` runs it after writing a newly generated key,
so a power cut right after first start cannot give the node a different
identity next time.

A failed commit or sync latches the storage: every later write, flush and
`whenDurable()` rejects with `StoreFailedError` until the app reopens the store
(rule 5 of the flush contract,
[storage.md §6](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved)).

## Identity

`loadOrCreateNSPeerKey(db, keyName?)` writes the libp2p private key as raw
protobuf bytes (`Uint8Array`) into the `kv` table's `b_val` column under
`keyName` (default `peer-private-key`), synced before it returns. SQLite stores
BLOBs natively — no base64 round-trip. To rotate the identity, delete that one
row:

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
to be installed to run tests. No test cuts the power: that a committed group
survives one rests on SQLite's write-ahead log, as stated above.
