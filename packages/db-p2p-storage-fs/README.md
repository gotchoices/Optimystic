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

Both write through one write-ahead log per directory (below).

This package targets plain Node.js. Use the sibling adapter for other
environments:

- `@optimystic/db-p2p-storage-ns` — NativeScript (iOS/Android, SQLite)
- `@optimystic/db-p2p-storage-rn` — React Native (LevelDB)
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

// … and on shutdown, after the node has stopped:
await libp2p.stop();
await kvStore.close();
await rawStorage.close();
```

The node never closes a store it was handed, so close both after `stop()`.
Closing flushes what the store still holds and, for the last store over the
directory, checkpoints the write-ahead log and removes the lock. A store that is
never closed loses nothing it flushed, but leaves a log for the next open to
replay and a lock the next open replaces as stale.

Both constructors take a `basePath` — the directory under which all data is
stored — and an optional options object:

| Option | Default | What it does |
| --- | --- | --- |
| `idleFlushMs` | 1000 | How long a write may wait for a `flush()` before the store flushes it itself |
| `checkpointBytes` | 16 MiB | Checkpoint the log once its records reach this size |
| `checkpointIdleMs` | 5000 | Checkpoint the log this long after its last append |

The two checkpoint settings belong to the directory's one log, so they are the
first-opened store's; a store opened beside it with different values logs them
on the `optimystic:db-p2p-storage-fs:write-log` channel and shares the open
log's.

The two stores can share the same `basePath` in practice because their
top-level names do not collide: block data lives under `<blockId>/`
subdirectories, while KV data lives under directories named by the first
segment of each key (a `/`-separated key becomes nested subdirectories — e.g.
`coordinator/key1` → `coordinator/key1.json`). Sharing is safe only as long as
no block id's first segment (a block id containing `/` nests the same way)
equals a KV key's first segment; give them separate `basePath`s if
you cannot guarantee that. The KV keys the node itself writes all start with a
fixed literal segment (`under-replicated/`, `coordinator/`, `participant/`,
`executed/` — db-p2p's `NODE_KV_NAMESPACES`), and `FileRawStorage.listBlockIds`
skips those root directories, so a KV key is never mistaken for a block. KV bytes do count
toward `FileRawStorage.getApproximateBytesUsed` when the path is shared. Over
one `basePath` the two share one log, one lock and one checkpoint.

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
  <seg>/<seg>/               — a block id containing "/" (e.g. `default/app/Ledger`) nests one directory per segment
    meta.json                — and holds the same files as above; it can contain another block's directory
    index/<seg>/meta.json    —   (e.g. `default/app/Ledger/index/LedgerLatest`)
  <key-segment>/
    <key-segment>.json       — FileKVStore value; key "/" separators become subdirectories
  write-ahead.log            — groups written since the last checkpoint
  write-ahead.log.sealed     — the log a checkpoint is syncing the tree under; present only during one, or after a crash in one
  store.lock                 — { pid, hostname } of the process holding the store
```

Action ids that contain a colon (e.g. `tx:abcd1234`) are percent-encoded in
filenames (`tx%3Aabcd1234.json`) for Windows compatibility; the storage layer
encodes and decodes transparently so callers always work with the canonical
id form.

## Write-ahead log

Each store holds its writes in memory and, at a `flush()`, appends everything
written since the last flush to `<basePath>/write-ahead.log` as one record — a
length, a CRC-32, then each put or delete with its path. A flush given no
window (`withinMs` absent or 0) then waits for the disk once, and that sync
covers every record appended before it. A flush given a window resolves as soon
as the record is appended; the log syncs by the earliest deadline any waiting
record was given, so many groups share one sync. A group that arrives to find
an earlier deadline already passed makes the sync itself before it resolves,
whatever its own window, so a disk that falls behind slows the writers rather
than widening the window. Only after the sync are the files written to their
canonical paths in the tree, without waiting. A tree file therefore never holds
content whose log record is not durable, and the next open replays the log in
order before serving anything.

**What a crash loses.** A crash of the process loses nothing a flush resolved:
every record is in the operating system's hands before its flush resolves, and
the next open replays it. A power cut or operating-system crash loses at most
the groups still inside their window — whole groups only, never half of one,
and always the last ones: the log is one sequence, and a record cut short, or
one whose checksum fails because a later page of the log was written while an
earlier one was not, ends the replay there, so what survives is a prefix of the
groups in flush order.

**Checkpoint.** The log does not grow for ever. A checkpoint seals the log —
renames it to `write-ahead.log.sealed` and starts an empty one, which new
writes go to at once — then syncs every file written since the last checkpoint
and every directory whose entries changed, then deletes the sealed segment. It
runs when the log reaches `checkpointBytes`, `checkpointIdleMs` after the last
append, and when the last store over the directory closes. Only the seal waits
in line with writes; the syncs run beside them. A crash during a checkpoint
leaves the sealed segment behind, and the next open replays it before the
current log. A checkpoint that fails latches the store failed, like a failed
flush, because a half-synced tree under a discarded log could not be recovered.

## Durability

`FileRawStorage` reports `durability: 'power-loss'`, and a resolved
`FileKVStore.flush()` promises the same: a flushed group survives a power cut
once its window has passed, or at once for a flush given none, and the tree is
rebuilt from the log on the next open. `whenDurable()` resolves once every group
flushed so far is synced. The log is synced once per strict group and once per
window for the relaxed groups appended inside it; a strict flush also covers
every relaxed group waiting, which is how a strict flush of one store makes the
other store's earlier groups durable too. The write path syncs nothing else.
Directories are synced at the checkpoint (and at open, by the replay), not per
write; on Windows, where a directory cannot be synced, only files are. See
[storage.md §6](../db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved).

The idle checkpoint, `checkpointIdleMs` after the last append, syncs whatever is
waiting before it seals the log, so a record waits at most the shorter of its
window and that setting; the default 5 s equals the longest window the node
computes. A sync that started after a deadline it covered — the disk, or the
log's queue, fell behind — is logged once per such episode as `window-overrun`
on the `optimystic:db-p2p-storage-fs:write-log` channel, with how late it
started and how many groups it covered.

A solo node's write therefore costs three syncs: its pend, its commit, and the
under-replication entry it records, since the ledger flushes after every call
that wrote, and every one of those flushes is strict. A write a cohort agreed to
is flushed with the window its cohort allows, so a member applying many such
writes pays one sync per window instead. GitHub issue #37 measured more than
seventy syncs for one solo write before the log.

Opening a store takes `<basePath>/store.lock`, which records the holder's
`{ pid, hostname }`. A lock naming a live process on this machine refuses the
open with `StoreLockedError` from every operation; a lock left by a process that
has exited, or by another machine, is stale and replaced. Every store over one
directory in one process shares one log and one lock.

**Downgrading.** A build older than the log reads the tree and ignores
`write-ahead.log`, so it sees only what the tree held: after an unclean stop it
loses the groups the log held and the tree did not, and a later upgrade back
would replay that stale log over what the older build wrote meanwhile. A clean
`close()` checkpoints first, leaving an empty log. To downgrade after an
unclean stop, open and close the store once with this build first.

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
  (`test/file-write-log.spec.ts` for a damaged log, a failed apply, a failed sync,
  the sync a relaxed group defers and what hastens it, the checkpoint and its
  crash cases, and the lock; `test/fsync-count.spec.ts`
  for one sync per `StorageRepo` group), torn-file corruption tolerance,
  `readdir` error discrimination, colon-encoded filenames + the POSIX legacy
  raw-colon fallback, the directory-based `listBlockIds` meta-gate, `FileKVStore`
  listings over unflushed writes and the log it shares with `FileRawStorage`,
  and the under-replication ledger over `FileKVStore`.

## Known limitations

**The lock protects one machine.** `store.lock` refuses a second live process
on the same host; it cannot tell a live process on another machine from a dead
one, so two machines over one network share can both open the store. That was
never supported (Invariant 5 in
[storage.md](../db-p2p/docs/storage.md#5-a-store-is-owned-by-exactly-one-process)).

**Ephemeral peer identity.** There is no `loadOrCreateFSPeerKey` equivalent.
A Node peer backed by `FileRawStorage` gets a new libp2p peer id each restart.
If your use case requires a stable, restart-surviving identity, a future
`feat-fs-peer-identity` feature should add the key-persistence helper — it is
deliberately out of scope here.
