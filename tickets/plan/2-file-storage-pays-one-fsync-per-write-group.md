description: The Node file storage waits for the disk twice for every file it writes, so one small commit waits dozens of times in a row — about a second per commit on a Mac. Record each group of writes in one append-only log file and wait for the disk once per group, keeping the same crash safety and the same readable file layout.
prereq: storage-flushes-once-per-write-group
architecture: packages/db-p2p/docs/storage.md#4-file-based-storage-filerawstorage
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/src/index.ts, packages/db-p2p-storage-fs/README.md, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/test/under-replication-ledger.spec.ts, packages/db-p2p/src/unref-timer.ts, packages/db-p2p/docs/storage.md, docs/repository.md, packages/reference-peer/src/cli.ts, packages/upgrade-check/readme.md
difficulty: hard
----

# File storage pays one fsync per write group

GitHub #37 (kjeib). Builds on the `flush()` seam from `storage-flushes-once-per-write-group`.

## The cost

#37 measured, on one Node node and on two talking to each other:

| | macOS, APFS SSD | Linux ext4 (2-core VM) |
|---|---|---|
| one atomic 2 KB write as the store does it | 40.0 ms (0.64 ms without fsync) | 1.9 ms (0.29 ms without) |
| three one-row inserts in one transaction | 1,406–2,849 ms (memory storage: 7–17 ms) | 66–168 ms (memory: 22–50 ms) |
| fsyncs per three-insert commit | 72–144 | 72–155 |

On the Mac, the directory fsync is half of each write (tmp + fsync + rename alone: 21.0 ms). Node's fsync on macOS is a full drive-cache flush (`F_FULLFSYNC`, in libuv's `uv__fs_fsync`), which is why one sync costs about 20 ms there.

The count follows from the code. `atomicWriteFile` (`packages/db-p2p-storage-fs/src/atomic-write.ts`) does a file fsync and a directory fsync per value. Per block, a pend writes two values (metadata with the record's claim, then the pending record, in `BlockStorage.savePendingTransaction`) and a commit writes four (materialized block, revision record, metadata in `BlockStorage.setLatest`, proof), in sequence: twelve fsyncs per block per write. A node writing alone also records an under-replication entry per block through `FileKVStore.set`, two more.

## Why the fsyncs cannot simply be issued together at the end

#37's first suggestion is to write every file of a group unsynced, then fsync them all and each directory once. That gives one wait instead of dozens only if nothing must reach the disk before something else, and several things must (the ordering list in `storage-flushes-once-per-write-group`). Until the last sync returns, the operating system may write the group's files in any order, so a power cut mid-group can leave a `meta.json` naming revision N with no `revs/N.json`, or a pruned prior materialization with no new one, and nothing in the code heals those states. Honouring the orders with batched syncs takes one barrier per dependency step (three or more per commit), each still one fsync per file, so the count does not fall. Whether concurrent fsyncs of different files overlap on APFS is not measured.

## Design (from research; the planner confirms and splits)

A redo log per store directory.

1. **Writes go to memory and to a pending batch, not to the tree.** Each driver write (`putMetadata`, `putRevision`, `putPending`, `deletePending`, `putTransaction`, `putProof`, `putMaterialized`, `deleteMaterialized`, `promote`) records its effect in an in-memory overlay (key to bytes, or deleted) and appends it to the batch. Reads consult the overlay first, then the tree. `promote` is recorded as its result — put the committed transform with the pending record's bytes, delete the pending record — so it stays one atomic move.
2. **`flush()`** takes the batch, appends it to the log file as one framed record (length, checksum, entries), fsyncs the log, then applies the entries to the tree as ordinary writes without fsync, and drops each from the overlay once applied unless a later write replaced it. Writes that arrive during the sync go into the next batch, so concurrent groups share one sync. Flush may resolve as soon as the log is durable and let the tree apply finish afterwards; the overlay serves reads until it has.
3. **The tree only ever holds writes whose log record is durable.** This is the write-ahead rule. It is what makes the surviving state after a crash a prefix of the writes: replaying the durable log over the tree reproduces every write up to the last durable record, and no later write ever reached the tree.
4. **Opening replays.** The constructor stays synchronous (hosts build stores inside providers, e.g. `storage: { provider: scope => new FileRawStorage(...) }`), so the first operation awaits a one-time recovery: read records until the first that is short or fails its checksum, apply them in order (puts and deletes are idempotent overwrites), fsync every file and directory replay touched, then truncate the log. The reader is strict — a format version at the head of the file, every length checked against the bytes present, stop at the first bad record — not a tolerant parser.
5. **Checkpoint.** When the log passes a size threshold, on an idle timer, and on close: fsync every tree file and directory written since the last checkpoint, concurrently and off the commit path, then truncate the log (or rotate to a new segment first, so groups keep appending while the old segment's files are synced). The set of files written since the last checkpoint is held in memory; after a crash, replay rewrites all of them and syncs them before truncating. The idle timer also flushes writes that no group flushed (the read-path re-cache in `BlockStorage.materializeBlock`, fire-and-forget state writes). Timers are unref'd (`packages/db-p2p/src/unref-timer.ts`).
6. **`FileKVStore` uses the same mechanism.** Where it shares a base path with `FileRawStorage` — the reference peer does (`packages/reference-peer/src/cli.ts`) — both should write through one log, so one sync covers a commit and its ledger entry. A per-directory registry, keyed like `FileStoreDriver`'s store identity, also makes two `FileRawStorage` objects over one directory in one process share one log and overlay instead of interleaving two writers into one file.
7. **Tree writes no longer need a temp file and a rename.** A torn tree file can only belong to a record that is durable, and replay rewrites it; in-process readers never see one, because the overlay keeps the entry until its write completes. Keep the "corrupt JSON reads as missing" guard for stores written by older builds.

**Build the overlay once, in `db-p2p`, not inside the fs driver.** Steps 1–3 are not specific to files: hold a group's writes in memory, serve reads from them, and at `flush()` hand the whole group to the backend as one batch that it commits atomically and durably. The mobile and browser backends need exactly that too (`mobile-and-browser-storage-lose-acknowledged-writes-on-power-loss`): LevelDB has `WriteBatch` with `sync`, SQLite a transaction under `synchronous = FULL`, IndexedDB one `readwrite` transaction with `durability: 'strict'`, and committing each group as one synced batch also avoids two hazards that syncing a marker after unsynced writes runs into — the LevelDB vendored by `gotchoices/rn-leveldb` closes its old log file without syncing it when it switches to a new one (`DBImpl::MakeRoomForWrite` in `cpp/leveldb/db/db_impl.cc`), and IndexedDB does not promise that a strict transaction makes earlier relaxed ones durable. So: a driver wrapper beside `CachedStoreDriver` in `packages/db-p2p/src/storage/`, over a small backend contract (commit this batch atomically and durably; read a key; list a range), with the file backend's contract implemented by the log, tree apply and replay above. Files have no native atomic batch, which is the only reason this backend needs a log of its own.

## Defect this closes (same code)

`FileStoreDriver.promote` in `packages/db-p2p-storage-fs/src/file-storage.ts` is a bare `fs.rename`, and `FileStoreDriver.deletePending` and `deleteMaterialized` are bare `fs.unlink`s; none syncs the directory, while the metadata write that follows each is synced. POSIX does not make a rename or unlink durable until its directory is synced. On ext4 and XFS a later fsync of any file also commits earlier changes to other directories in practice (their journals commit in order), so the gap is closed there; POSIX does not promise it and not every file system does it (btrfs, APFS and NTFS were not checked). Where it is not closed, a power cut can keep the new `meta.json` — latest at revision N, the action's claim dropped — and lose the rename or unlink:

- `pend/<action>.json` is back beside the committed revision, with no claim in the metadata. `isReservationAgainst` (`packages/db-p2p/src/storage/pending-claim.ts`) treats a claim-less record as the strongest reservation, so this member votes `held` against every later write to the block. In a cohort of two or three, where every member must approve, nobody can write that block again; the only cleanup would be backlog `debt-unpromotable-pending-records-need-a-sweep`.
- A reverted promote also leaves revision N with no committed transform. Once a later commit prunes N's materialization, a read at N fails with "Missing action".

`repro: static` — from reading `promote`, `deletePending` and `atomicWriteFile`; not reproduced with a power cut. The log closes it by construction: the rename and the unlink become entries of an atomic record. If the log is declined, the standalone fix is to fsync `pend/` and `actions/` after the promote rename and the directory after each unlink, two to three more fsyncs per block per commit.

## Requirements

- Crash guarantees equal to or stronger than today's per-file syncing: what survives a power cut is a prefix of the writes, in order; a flushed group is all-or-nothing.
- At most one fsync per `flush()` on the commit path, independent of how many blocks or files the group touched. Tree-apply and checkpoint syncs stay off it.
- The tree layout in `packages/db-p2p-storage-fs/README.md` is unchanged and stays readable by eye. A store written by an older build opens with no log and reads as before (the `packages/upgrade-check` fs fixtures).
- Node on win32 (no directory fsync — `fsyncDir` already skips it there), macOS and Linux.
- A failed fsync of the log puts the store in a failed state: every later write and flush throws until the store is reopened. After a failed fsync the kernel may have dropped the dirty pages, so a retried fsync can report success for data that is gone.

## Edge cases & interactions

- Torn final record (crash mid-append): replay stops before it; that group is absent and every earlier one present. Test.
- Crash after the log sync, before the tree apply: replay applies the group. Test, by failing the tree write and reopening.
- Crash during a checkpoint, before truncation: replay re-applies harmlessly. Truncation only after every file the truncated records touched is synced.
- New block directories are created by the tree apply, and recreated by replay.
- Reads during the window: point reads check the overlay; `rangeRevisions`, `listPendingActionIds`, `listBlockIds` and `FileKVStore.list` merge overlay puts and deletes with the directory listing, and a record deleted in the overlay must not reappear from the tree.
- `listBlockIds` gates on `meta.json`; a block whose metadata exists only in the overlay is still listed.
- Overlay size: under the default policy it holds only unflushed or unapplied groups. A background-flush mode (backlog `feat-a-node-can-be-declared-to-flush-storage-in-the-background`) would hold up to its loss window; bound it.
- `approximateBytesUsed` now counts the log file; harmless.
- Two processes over one directory are already unsupported (Invariant 5 in `packages/db-p2p/docs/storage.md`) and become more dangerous: one process's replay can overwrite the other's tree. Take an exclusive lock on the log file, or do the proper-lockfile TODO on `FileStoreDriver` alongside.
- The conformance `reopen` case must close the first store (releasing its registry entry) before opening the second, or it reads the shared overlay and proves nothing.
- Downgrade: an older build ignores the log, so after an unclean stop it loses groups not yet applied to the tree. A clean close checkpoints first. Not a compatibility promise (AGENTS.md), but say it in the README.
- Upgrade-check: a fixture written by this build may contain an unapplied log (the writer leaves an append in flight), which exercises replay; the harness needs no change.

## Alternatives considered

- One barrier per commit without a log: see above.
- Dropping the directory fsync: halves the cost on macOS, but leaves the rename that publishes each file non-durable on POSIX — the defect above, everywhere.
- A Node store over `node:sqlite`, reusing `SqliteRawStorage` from `db-p2p-storage-ns`: one sync per transaction, but `node:sqlite` is synchronous, so each sync (about 20 ms on macOS) would stall the event loop the libp2p node runs on, and the readable layout is gone.
- LevelDB on Node (`classic-level`, which the rn package's tests already use) under the rn package's driver: atomic batches and one sync per batch with no new design, at the price of a native dependency and the readable layout. A reasonable separate backend if wanted; it does not fix this one.

## Verification

- **fsync-count contract test**, using #37's technique (wrap `fs.promises.open` and count `FileHandle.sync`): a `StorageRepo` pend and a commit over N blocks each issue at most one fsync, for N = 1 and N = 8, and a group that writes nothing issues none.
- The replay tests above, and group atomicity: a group whose record never reached the log leaves nothing behind.
- The conformance suite, including the `reopen` case from `storage-flushes-once-per-write-group`.
- `packages/upgrade-check` passes over the existing fs fixtures.

Expected effect, from counts rather than timing: each machine applies one pend and one commit per write, so 2 fsyncs per write (3 on a node writing alone, which also records its shortfall) instead of the 72–155 measured. At #37's measured cost of about 20 ms per fsync on APFS, that is about 40–60 ms of disk wait per write instead of about a second; re-measure with #37's `commit-cost.mjs`.

## Sizing and docs

Probably three implement tickets: (a) the write-group overlay as a `db-p2p` driver wrapper over a batch-commit contract, with its read merging and the conformance `reopen` case; (b) the file backend's batch commit — log, tree apply, replay — with the fsync-count contract and replay tests; (c) `FileKVStore` on the shared log, checkpoint and rotation, the idle timer, and docs. Docs to update: the README "Atomic writes" and "On-disk layout" sections (and its sibling list, which calls the rn backend "MMKV"; it is LevelDB), the file layout in `packages/db-p2p/docs/storage.md`, and the "single rename on the filesystem backend" wording of Invariant P in `docs/repository.md`.
