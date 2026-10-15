# @optimystic/db-p2p-storage-fs

Node.js filesystem storage backend for Optimystic peers. Provides:

- **`FileRawStorage`** — implements `IRawStorage` so a Node peer persists block
  metadata, revisions, pending transactions, committed transactions, commit
  proofs, and
  materialized blocks durably across restarts.
- **`FileKVStore`** — implements `IKVStore` for node-local state that must
  survive a restart: the under-replication ledger (which blocks the node
  acknowledged before every cohort member held them), and the persistent
  transaction state used to recover crashed two-phase commits.

This package targets plain Node.js. Use the sibling adapter for other
environments:

- `@optimystic/db-p2p-storage-ns` — NativeScript (iOS/Android, SQLite)
- `@optimystic/db-p2p-storage-rn` — React Native (MMKV)
- `@optimystic/db-p2p-storage-web` — Browser (IndexedDB)

## Install

```bash
yarn add @optimystic/db-p2p-storage-fs @optimystic/db-p2p @optimystic/db-core
```

## Usage

```ts
import { FileRawStorage, FileKVStore } from '@optimystic/db-p2p-storage-fs';
import { createLibp2pNode } from '@optimystic/db-p2p';

const rawStorage = new FileRawStorage('/var/lib/my-peer/data');
const kvStore    = new FileKVStore('/var/lib/my-peer/data');

const libp2p = await createLibp2pNode({
  bootstrapNodes: [/* … */],
  networkName: 'my-network',
  storage: rawStorage,
  kvStore,
});
```

Both constructors take a single `basePath` — the directory under which all
data is stored. They can share the same `basePath` in practice because their
top-level names do not collide: block data lives under `<blockId>/`
subdirectories (block ids are content-address hashes), while KV data lives
under directories named by the first segment of each key (a `/`-separated key
becomes nested subdirectories — e.g. `coordinator/key1` → `coordinator/key1.json`).
Sharing is safe only as long as no block id equals a KV key's first segment;
give them separate `basePath`s if you cannot guarantee that. The KV keys the
node itself writes all start with a fixed literal segment (`under-replicated/`
for the ledger), and `FileRawStorage.listBlockIds` yields only directories that
contain a `meta.json`, so a KV directory is never mistaken for a block. KV
bytes do count toward `FileRawStorage.getApproximateBytesUsed` when the path is
shared.

Without a `kvStore`, the node falls back to an in-memory store and logs a
`node-wiring` warning: what the ledger records is then lost on restart.

## On-disk layout

```
<basePath>/
  <blockId>/
    meta.json                — BlockMetadata (JSON)
    revs/<rev>.json          — ActionId for that revision number
    pend/<id>.json           — pending Transform (two-phase commit, before promotion)
    actions/<id>.json        — committed Transform
    proofs/<rev>.json        — BlockCommitProof retained for that revision
    blocks/<id>.json         — materialized IBlock snapshot
  <key-segment>/
    <key-segment>.json       — FileKVStore value; key "/" separators become subdirectories
  write-ahead.log            — groups committed but not yet replayed into the tree
  store.lock                 — { pid, hostname } of the process holding the store
```

Action ids that contain a colon (e.g. `tx:abcd1234`) are percent-encoded in
filenames (`tx%3Aabcd1234.json`) for Windows compatibility; the storage layer
encodes and decodes transparently so callers always work with the canonical
id form.

## Write-ahead log

`FileRawStorage` holds each group of writes in memory and, at the group's
`flush()`, appends the whole group to `<basePath>/write-ahead.log` as one
record — a length, a CRC-32, then each put or delete with its path — and waits
for the disk once. Only then are the group's files written to their canonical
paths in the tree, without waiting. A tree file therefore never holds content
whose log record is not durable, and the next open replays the log in order
before serving anything: a crash loses only the groups after the last durable
record, whole groups only, never half of one. A record cut short by the crash,
or one whose checksum fails, ends the replay there. The log is not yet
checkpointed, so it grows for the store's life and is emptied by a reopen;
`file-store-checkpoint-and-shared-log` adds the checkpoint and moves
`FileKVStore` onto the same log. Until then `FileKVStore` still writes each
value to a `.tmp` sibling and renames it into place (`atomic-write.ts`).

## Durability

`FileRawStorage` reports `durability: 'power-loss'`: one sync of the log per
flushed group makes the group survive a power cut, and the tree is rebuilt from
the log on the next open. Directories are not synced on the write path at all
(the log covers them); the replay syncs every file and directory it touched,
file syncs only on Windows. See
[storage.md §6](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved).

Opening a store takes `<basePath>/store.lock`, which records the holder's
`{ pid, hostname }`. A lock naming a live process on this machine refuses the
open with `StoreLockedError` from every operation; a lock left by a process that
has exited, or by another machine, is stale and replaced. Two `FileRawStorage`
over one directory in one process share one log and one lock. `close()` flushes
what is still held and, for the last store over the directory, closes the log
and removes the lock.

## Identity

Unlike the `ns`/`rn`/`web` adapters, this package ships **no** identity module
and no `loadOrCreateFSPeerKey` helper. The reference peer that uses this adapter
does not persist its libp2p private key, so an fs-backed node gets a fresh
ephemeral peer id on every restart. Adding durable identity is a separate
feature — see Known limitations below.

## Tests

```bash
yarn test          # mocha, minimal reporter
yarn test:verbose  # mocha, spec reporter
```

Two layers run here, both over a per-test `fs.mkdtemp` fixture with `afterEach`
cleanup:

- **Shared conformance suite** — `runRawStorageConformance('FileSystem', …)` from
  `@optimystic/db-p2p/testing/conformance`, the one cross-backend parity target. It proves the
  fs backend (`KvRawStorage` over `WriteGroupDriver` over a `FileBatchBackend`)
  behaves identically to every other backend: round-trips, `listRevisions`
  ordering, promote atomicity + the exact missing-pend error, clone-on-store/read
  (structural via the byte boundary), drain-before-yield iteration, a
  `BlockStorage` parity slice, and the flush-then-reopen case.
- **fs-only tests** (`node:assert`) — the behaviors the shared suite can't cover:
  what the log leaves in the tree and what a reopen replays
  (`test/file-write-log.spec.ts` for a damaged log, a failed apply, a failed sync
  and the lock; `test/fsync-count.spec.ts` for one sync per `StorageRepo` group),
  torn-file corruption tolerance, `readdir` error discrimination, colon-encoded
  filenames + the POSIX legacy raw-colon fallback, the directory-based
  `listBlockIds` meta-gate, and `FileKVStore.list`/`delete`.

## Known limitations

**The lock protects one machine.** `store.lock` refuses a second live process
on the same host; it cannot tell a live process on another machine from a dead
one, so two machines over one network share can both open the store. That was
never supported (Invariant 5 in
[storage.md](../db-p2p/docs/storage.md#5-a-store-is-owned-by-exactly-one-process)).
`FileKVStore` takes no lock until it moves onto the shared log.

**Ephemeral peer identity.** There is no `loadOrCreateFSPeerKey` equivalent.
A Node peer backed by `FileRawStorage` gets a new libp2p peer id each restart.
If your use case requires a stable, restart-surviving identity, a future
`feat-fs-peer-identity` feature should add the key-persistence helper — it is
deliberately out of scope here.
