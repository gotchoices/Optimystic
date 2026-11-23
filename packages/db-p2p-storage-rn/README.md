# @optimystic/db-p2p-storage-rn

React Native LevelDB storage backend for `@optimystic/db-p2p`. Lets a React
Native peer persist Optimystic block data across app restarts using an
on-device LevelDB. Provides:

- **`LevelDBRawStorage`** — implements `IRawStorage` so an RN node persists
  block metadata, revisions, pending transactions, committed transactions,
  commit proofs, and materialized blocks.
- **`LevelDBKVStore`** — implements `IKVStore` for the persistent
  transaction state used to recover crashed two-phase commits.
- **`LevelDBPieceStore`** — implements `IPieceStore`, the node's store of
  blob pieces (`node.blobs`), in the same LevelDB.
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
  levelDbNodeStorage,
  loadOrCreateRNPeerKey,
} from '@optimystic/db-p2p-storage-rn';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';

const db = openOptimysticRNDb({
  openFn: (name, createIfMissing, errorIfExists) =>
    new LevelDB(name, createIfMissing, errorIfExists),
  WriteBatch: LevelDBWriteBatch,
});
const storage = levelDbNodeStorage(db);   // all three of the node's stores over it
const privateKey = await loadOrCreateRNPeerKey(db);

const libp2p = await createLibp2pNode({
  bootstrapNodes: [/* … */],
  networkName: 'my-network',
  privateKey,
  storage,
});
```

Use the Node-free `/rn` entry point of `@optimystic/db-p2p` so the Node-only
TCP transport doesn't get bundled into the React Native app.

**The location is one open database.** `levelDbNodeStorage` builds the block store
(`LevelDBRawStorage`), the key-value store (`LevelDBKVStore`) and the piece store
(`LevelDBPieceStore`) over the handle you pass, one ordered keyspace partitioned
by a leading tag byte. The three therefore report one store identity, and the
block store's byte count, which covers the whole database, already measures both
the piece range and the key-value store's keys: that is what makes the node count
its blob pieces once rather than reporting itself fuller than it is, and its own
key-value bookkeeping at all rather than leaving it unmeasured. The factory
asserts it of all three before it returns.

There is **no free-space figure**: this package is handed an already-open handle,
not a path, and the binding exposes no free-space call, so
`getApproximateBytesFree` is omitted entirely rather than stubbed at 0 — 0 would
read as "full". A host that knows the device's figure supplies it to the node
itself.
The three classes stay exported for a caller that needs one on its own.

**The handle stays yours.** The node closes no store it was handed, so close the
storage after `stop()`; `storage.close()` never closes the handle, which you may
be sharing with `loadOrCreateRNPeerKey`, so close that last:

```ts
await libp2p.stop();
await storage.close();   // commits what the kv store and the block store still hold
await db.close();
```

`storage.close()` closes the two stores that hold writes in memory: the key-value
store commits what it still holds and disarms its timer, and the block store does
the same after dropping its read cache and releasing the cache pool's claim on the
handle. There is nothing to call on the piece store: each put is written as it is
made, so it has neither a `close` nor a flush with work to do. A write a store
still holds when the handle is closed under it is lost, and a timer it still has
armed would fire on a closed handle.

Call `levelDbNodeStorage` **once** per handle. The block store's read cache claims
the handle in its cache pool, so a second call over the same handle while the
first is open throws (`two caches over one backing store never converge`). That
refusal is deliberate: two storages over one store each hold writes the other
cannot see, which is what
[storage.md §1. Every write to a store goes through `IRawStorage`](../db-p2p/docs/storage.md#1-every-write-to-a-store-goes-through-irawstorage)
rules out. Close the first before opening another, including when a node over the
handle stops and starts again in the same process.

## Persistence semantics

Everything lives in one LevelDB database (`optimystic` by default), one
ordered byte keyspace partitioned by a leading tag byte (`src/keys.ts`).
`LevelDBRawStorage` is the shared `KvRawStorage` kernel over a read cache
(`CachedStoreDriver`) over a `WriteGroupDriver` over a `JournalBatchBackend`
over a `LevelDBJournalStore`: the kernel owns all JSON serialization, so the seven
block-storage stores hold opaque kernel-encoded values, written as UTF-8 bytes
and read back as text (see *Reads decode text in native code* below). The keys,
the bytes, and the logical types the kernel decodes them back into are
unchanged from earlier builds, so data written by one reads unchanged, and a
database an earlier build wrote has no journal, so the first open over it
applies nothing.

| Tag | Store | Key suffix | Decoded (logical) type |
|-----|-------|------------|------------------------|
| `0x01` | `metadata` | `blockId` | `BlockMetadata` |
| `0x02` | `revisions` | `blockId`, rev (8 bytes big-endian) | `ActionId` |
| `0x03` | `pending` | `blockId`, `actionId` | `Transform` |
| `0x04` | `transactions` | `blockId`, `actionId` | `Transform` |
| `0x05` | `materialized` | `blockId`, `actionId` | `IBlock` |
| `0x06` | `proofs` | `blockId`, rev (8 bytes big-endian) | `StoredProofEntry`: a reference to a `0x08` entry (a whole `BlockCommitProof` when an earlier build wrote it) |
| `0x07` | `journal` | the record's sequence (8 bytes big-endian), or nothing for the applied-through mark | a journal record as bytes, or the number of the last record applied — owned by `LevelDBJournalStore` |
| `0x08` | `commitProofs` | the proof's `messageHash`, UTF-8, with no `blockId` envelope | `BlockCommitProof` |
| `0x09` | `pieces` | `0x00` then the piece id, UTF-8, for the piece; `0x01` then the piece id for its length | the piece's raw bytes; its length, 4 bytes big-endian — owned by `LevelDBPieceStore` |
| `0x10` | `kv` | the key, UTF-8 | a string (not kernel-backed) |
| `0x20` | `identity` | the key name, UTF-8 | raw protobuf bytes of the private key |

`listRevisions` and `listPendingTransactions` are range-bounded native scans,
drained before any result is yielded so a native iterator never stays open
across a consumer's `await`. `promotePendingTransaction` records two entries of
one write group — the committed row's put and the pending row's delete — applied
in that group's batch, so the move is atomic across crashes.

## Reads decode text in native code

Every stored value but a blob piece is JSON text or an action id, written as
`TextEncoder` output (native in Hermes). Every read of one — a block, a
transform, metadata, a proof, a revision's action id, a key-value record — asks
`rn-leveldb` for the value as a string (`getStr`, and `valueStr` on an
iterator), which the binding decodes from UTF-8 in native code. No read reaches
a JavaScript `TextDecoder`, which Hermes provides only as a polyfill and which a
device profile of an offline save on an older phone measured as the largest
single cost of the save (GitHub #51). Values are held as text all the way up: the read cache and the
write group's in-memory overlay hold the string, so a cache hit is the string
and one `JSON.parse`, and text becomes bytes only when a group is written to
LevelDB.

Blob pieces are the exception. A piece is raw bytes, not text, even when its
bytes happen to be valid UTF-8, so `LevelDBPieceStore` reads one with
`getBuf`, and nothing else reads a piece at all: `has`, the listing and the
byte count read the 4-byte length key stored beside each piece. The block
store's byte count (`getApproximateBytesUsed`) measures the piece range the same
way, so it covers the whole database without reading a blob through the
binding, and the two stores report one identity, so the node counts the pieces
once.

The read cache is part of the storage, not something to add: the node's own
cache (`withReadCache`) would front the storage through an adapter that carries
bytes, bringing back two JavaScript decodes per cold read. `LevelDBRawStorage`
reports itself read-cached, so the node and the Quereus plugin use it as it is.
Do not wrap it in a cache of your own: `CachedRawStorage` over it throws
(`redundant read cache`); a host that wraps every storage should pass one that
reports `readCached` through unchanged, as `withReadCache` does.
It shares a memory budget with every other cache in the process
(`defaultCachePool()`, 8 MB on React Native by default); pass `readCachePool`
to use a pool of your own, and `readCacheLabel` to name the storage in the
pool's statistics (`'leveldb'` by default):

```ts
const rawStorage = new LevelDBRawStorage(db, { readCachePool: pool, readCacheLabel: 'blocks' });
```

The binding's decoder and `TextDecoder` agree on every value this package
stores, since `TextEncoder` output is always valid UTF-8, with one difference:
`TextDecoder` drops a leading byte-order mark and the binding keeps it. JSON
never starts with one; an action id can, since whoever originates a write
chooses it, and it now reads back as written, as it already did from the cache
and the overlay. Existing databases need no migration.

**The `TextDecoder` polyfill is still required.** `multiformats` and `cborg`
construct one when they load, and this package still decodes keys with it:
block and action ids out of a key in a listing (`listPendingTransactions`,
`listBlockIds`, the key-value store's `list`), since a key is binary and the
binding's text reads are defined only for UTF-8. Once `rn-leveldb` can sync a
batch, journal recovery at open will decode each journal record's keys with it
too, at open only.

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

`LevelDBPieceStore` holds nothing in memory: each `put` is one batch, the
piece and its length together, synced where the handle can sync, and `flush()`
has nothing left to do. LevelDB syncs only the log file a synced write lands
in, and at a 4 MiB write buffer a run of 256 KiB pieces moves to a new log file
every few pieces, so one synced write at the flush would not cover the pieces
before it. `rn-leveldb` cannot sync yet, so on a phone the piece store reports
`'process-crash'` and a stored piece survives the app crashing, not the phone
losing power, exactly as the block store. A `delete` is never synced: one a
power cut undoes leaves a piece no blob names, which the blob service's next
sweep removes. The piece store has not run on a device; its suite runs over
`classic-level`.

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
