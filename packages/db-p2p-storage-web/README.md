# @optimystic/db-p2p-storage-web

IndexedDB-backed storage backend for Optimystic browser peers. Provides:

- **`IndexedDBRawStorage`** — implements `IRawStorage` so a browser node persists
  block metadata, revisions, pending transactions, committed transactions,
  commit proofs, and materialized blocks across page reloads, each group of
  writes journaled and applied as one transaction.
- **`IndexedDBKVStore`** — implements `IKVStore` for the persistent transaction
  state used to recover crashed two-phase commits.
- **`loadOrCreateBrowserPeerKey`** — generates an Ed25519 libp2p private key on
  first run and persists it in the same IndexedDB database, giving the browser
  peer a stable, reload-surviving identity.

This package is browser-only — it imports no Node built-ins. Counterparts:

- `@optimystic/db-p2p-storage-rn` — React Native (LevelDB)
- `@optimystic/db-p2p-storage-ns` — NativeScript (SQLite)
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

Close the storage and the key-value store before the handle, and the handle last:

```ts
await rawStorage.close();   // applies what it still holds, disarms its timers
await kvStore.close();      // commits what it still holds, disarms its timer
db.close();
```

Neither `close()` closes the shared handle. A write a store still holds when the
handle is closed under it is lost, and a timer it still has armed would fire on
a closed handle.

## Persistence semantics

The package opens a single IndexedDB database (`optimystic` by default) with
eight object stores. `IndexedDBRawStorage` is the shared `KvRawStorage` kernel
over a `WriteGroupDriver` over a `JournalBatchBackend` over an
`IndexedDBJournalStore`: the kernel owns all JSON/UTF-8 serialization, so the
six block-storage stores hold opaque kernel-encoded `Uint8Array` bytes rather
than live objects. The keys and the logical types the kernel decodes them back
into are unchanged from earlier builds, so data written by one reads unchanged:

| Store          | Key                  | Stored value | Decoded (logical) type |
|----------------|----------------------|--------------|------------------------|
| `metadata`     | `blockId`            | `Uint8Array` | `BlockMetadata`        |
| `revisions`    | `[blockId, rev]`     | `Uint8Array` | `ActionId`             |
| `pending`      | `[blockId, actionId]`| `Uint8Array` | `Transform`            |
| `transactions` | `[blockId, actionId]`| `Uint8Array` | `Transform`            |
| `proofs`       | `[blockId, rev]`     | `Uint8Array` | `BlockCommitProof`     |
| `materialized` | `[blockId, actionId]`| `Uint8Array` | `IBlock`               |
| `journal`      | `seq` (a number), or `'applied-through'` | a `JournalRecord` by structured clone, or the number of the last record applied | — (owned by `IndexedDBJournalStore`) |
| `kv`           | `key`                | `string` or `Uint8Array` | — (not kernel-backed) |

`listRevisions` and `listPendingTransactions` use real IndexedDB range cursors
— never `getAllKeys()` + JS filter — so list latency stays bounded as the store
grows. `promotePendingTransaction` records two entries of one write group — the
committed row's put and the pending row's delete — applied in that group's
transaction, so the move is atomic across crashes.

`getApproximateBytesUsed()` returns `(await navigator.storage.estimate()).usage`,
which is **per-origin**, not per-database. That is adequate for `StorageMonitor`
— which uses the figure as an advisory ring-selection input — but is not a
precise per-database accounting.

## Durability

A write resolves into memory and is served from there; `flush()` hands every
write made since the last flush to the journal backend as **one group**, so a
group lands whole or not at all. IndexedDB can make one transaction durable
(`durability: 'strict'`: the transaction completes only once the browser has
put it on the disk) but promises nothing about the order relaxed transactions
reach the disk, so the backend journals rather than committing groups directly:

- a strict `flush()` (no `withinMs`, or 0) applies the group — and every group
  journaled and not yet applied — as one strict transaction over the six data
  stores and `journal`, and resolves once that transaction has completed;
- a relaxed `flush({ withinMs })` — what a node uses for a write its cohort
  also holds, see [storage.md §How long a write may wait for its sync](../db-p2p/docs/storage.md#how-long-a-write-may-wait-for-its-sync) —
  appends the group as one journal record in one relaxed transaction on
  `journal` alone and resolves; one strict apply by the earliest deadline, or a
  strict flush before then, applies every record appended since the last apply,
  in order, and deletes them. `whenDurable()` resolves once the groups flushed
  so far are applied.

Every apply carries every byte it applies, and the backend applies one at a
time, so what a power cut leaves is a prefix of the groups: a journal record the
browser did not keep is a missing number, and recovery at the next open applies
the consecutive run before it and discards everything after it (details in
[storage.md §6, *The journal backend*](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved)).

Whether a transaction can be strict is the browser's: `IndexedDBRawStorage`
reports `durability: 'power-loss'` where the browser honours the option (Chrome
83+, and Firefox and Safari in their current releases, detected once at
construction by `supportsStrictDurability`), and `'process-crash'` where it
ignores it. In the latter the backend journals nothing and applies each group
at once as one relaxed transaction, and the node's start-up line says such a
store cannot keep the window.

What a crash loses, with strict transactions:

| Crash | Lost |
|---|---|
| the tab, or the browser's process | a group not yet flushed, still in memory; nothing a flush has resolved for: a completed transaction survives the page, so a journaled group is applied at the next open |
| a power cut or operating-system crash | at most the groups still inside their window, always the most recent ones, each whole; nothing a strict flush has resolved for, and nothing once the window has passed |

Without strict transactions the first row holds and the second does not: a
power cut may lose any write the operating system has not written out, and may
keep a later group while losing an earlier one.

Two things sit outside this. Browser storage can be **evicted** under storage
pressure, which loses the whole database, unless the page holds persistent
storage (`navigator.storage.persist()`); that is the host's decision and the
backend cannot tell the difference between eviction and a database that was
never written. And two tabs over one database run two nodes over one store,
which [storage.md §5](../db-p2p/docs/storage.md#5-a-store-is-owned-by-exactly-one-process)
forbids and nothing here enforces.

A failed transaction latches the storage: every later write, flush and
`whenDurable()` rejects with `StoreFailedError` until the page reopens the store
(rule 5 of the flush contract,
[storage.md §6](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved)).

`IndexedDBKVStore` writes through a `WriteGroup` over its keys the same way:
`set` and `delete` resolve into memory, and `flush()` commits everything since
the last flush as one `readwrite` transaction on `kv`, strict where the browser
supports it — every flush of this store is strict, so nothing of it is ever
journaled. `whenDurable()` and `close()` are the group's.

## Identity

`loadOrCreateBrowserPeerKey(db, keyName?)` writes the libp2p private key as
raw protobuf bytes (`Uint8Array`) under `keyName` in the `kv` store
(default `peer-private-key`), in one transaction that is strict where the
browser supports it, so a power cut right after first start cannot give the
node a different peer id next time. IndexedDB stores typed arrays natively, so
no base64 round-trip is needed. To rotate the identity, delete that one key:

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
IndexedDB W3C API, so fake-indexeddb is a faithful behavioural surrogate — with
one gap: it has no disk, so it keeps the durability a transaction asked for and
does nothing with it, and does not advertise the option on
`IDBTransaction.prototype`. The tests pass `strictDurability: true` to take the
path a strict-capable browser takes, and check which durability each
transaction asked for, not what a disk did. That a strict transaction survives
a power cut rests on the browser; a device, or a manual check in one, is the
only real test of it.
