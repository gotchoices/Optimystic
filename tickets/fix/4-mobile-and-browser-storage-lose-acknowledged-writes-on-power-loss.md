description: On phones and in browsers, a write the network has been told is saved can disappear if the device loses power or its operating system crashes within the next few seconds; if that device then writes alone before it reconnects, its copy of the data splits from its partner's for good.
prereq: decide-what-a-node-must-have-on-disk-before-it-reports-holding-a-write, storage-flushes-once-per-write-group, file-storage-pays-one-fsync-per-write-group
architecture: docs/correctness.md#theorem-6-durability
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p-storage-rn/src/rn-opener.ts, packages/db-p2p-storage-rn/src/leveldb-like.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/leveldb-kv-store.ts, packages/db-p2p-storage-rn/src/identity.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/indexeddb-kv-store.ts, packages/db-p2p-storage-web/src/identity.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/sqlite-kv-store.ts, packages/db-p2p-storage-ns/src/identity.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/docs/storage.md
repro: static
----

# Mobile and browser storage lose acknowledged writes on power loss

Raised by GitHub #37 (kjeib), which noticed it for the React Native store; the browser and NativeScript stores are in the same state. Whether these backends must survive a power cut is the subject of `decide-what-a-node-must-have-on-disk-before-it-reports-holding-a-write`; under its proposed answer, and under `docs/correctness.md` Theorem 6 as written, they must.

## What happens

None of the three backends ever asks the operating system to put a write on stable storage:

- **React Native** (`packages/db-p2p-storage-rn`): `RNLevelDBAdapter` in `src/rn-opener.ts` calls the binding's `put`, `delete` and `write(batch)`. In `gotchoices/rn-leveldb` 3.11 (`cpp/react-native-leveldb.cpp`), all three use LevelDB's default `leveldb::WriteOptions()`, whose `sync` is false, and no JavaScript method accepts a sync flag. LevelDB's own documentation: with `sync = false`, "if the machine crashes, some recent writes may be lost" (a process crash loses nothing).
- **Browser** (`packages/db-p2p-storage-web`): `IndexedDBStoreDriver` writes through `idb`'s `db.put` / `db.delete`, one implicit transaction per write, with no `durability` option. Current browsers default to "relaxed" durability (Chrome since 121; Firefox and Safari already), under which a transaction completes once its data reaches the OS.
- **NativeScript** (`packages/db-p2p-storage-ns`): `applySchema` in `src/db.ts` runs SQLite in WAL mode with `PRAGMA synchronous = NORMAL`. SQLite's documentation: a WAL commit under NORMAL "might roll back following a power loss or system crash".

Their key-value stores (`LevelDBKVStore`, `IndexedDBKVStore`, `SqliteKVStore`) and identity helpers (`loadOrCreateRNPeerKey`, `loadOrCreateBrowserPeerKey`, `loadOrCreateNSPeerKey`) write the same way.

The node reports these writes to other machines as held (pend accepted, commit held, shortfall recorded). Three consequences:

1. **Only copy lost.** A write acknowledged `local` — a phone alone, or a phone whose backup is offline — exists only on the phone and is gone after a power cut within the window before the OS writes it out.
2. **A permanent fork from one power cut.** Step by step, on a two-member cohort of a phone P and a backup B:
   1. Write W1 commits revision N of block X on both members; acknowledged `full`.
   2. Before P's OS has written W1 to flash, P loses power (or hard-resets). LevelDB recovers without W1.
   3. P restarts while B is offline. Once B is not in P's routing view, P's cohort for X is P alone, so P serves its own copy (revision N−1) and commits alone (`CoordinatorRepo.pendSolo` and `commitSolo` in `packages/db-p2p/src/repo/coordinator-repo.ts`).
   4. The app writes W2, built on revision N−1, as revision N of X; acknowledged `local`, with B named as owed.
   5. B returns. The under-replication drain pushes W2's X to B. B already holds revision N (W1's), so `StorageRepo.saveReplicatedBlock` keeps its own copy and accepts the push as a no-op; the drain counts B as holding W2, clears the entry and fires the full-replication event for a write B does not hold.
   6. P and B now hold different content under revision N. P's next change to X declares a content digest computed on W2's content; B previews it against W1's and votes reject (`content-digest-mismatch`), and in a cohort of two every member must approve, so no later write to X succeeds. Repair sees two claims at one revision and cannot tell which is right (backlog `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort`).
   This is the forked state backlog `partition-healing` owns; losing the write is a way into it that needs no partition when W1 was made.
3. **Correlated loss.** Machines that lose power together (one household circuit) can lose an acknowledged write from every holder; the decision ticket tabulates how many holders that takes per cohort size.

## Expected behaviour (under the decision's proposed answer)

Each backend makes a write group durable before the node reports it, with one synchronous native write per group. Recommended shape: put the backend behind the write-group overlay that `file-storage-pays-one-fsync-per-write-group` builds in `db-p2p` (writes held in memory and served from there until `flush()`, then committed as one batch), and implement its batch commit with the backend's own atomic, synced batch:

- **React Native:** one LevelDB `WriteBatch` written with `sync = true`. The binding must expose a synchronous write first — `gotchoices/rn-leveldb` 3.11 has none — which is a change and release outside this repository; then the `RNLevelDBNative` and `LevelDBLike` interfaces here, and the `classic-level` test surrogate (its `batch` already accepts `sync`). Writing unsynced and then syncing a marker is not enough: the LevelDB that binding vendors closes its old log file without syncing it when it switches to a new one (`DBImpl::MakeRoomForWrite` in `cpp/leveldb/db/db_impl.cc` of `gotchoices/rn-leveldb`), so a later synchronous write would not cover unsynced writes left in the old file. With every native write a synced batch, no unsynced write is ever left behind.
- **Browser:** one `readwrite` transaction over the stores the group touched, opened with `{ durability: 'strict' }` (Chrome 83+, Firefox 126+, Safari 15+; older browsers ignore the hint and stay relaxed, which the startup log line should say). One transaction per group also makes the group atomic; a strict marker transaction after relaxed ones would rely on cross-transaction ordering the IndexedDB specification does not promise.
- **NativeScript:** one transaction per group, committed under `PRAGMA synchronous = FULL` (in WAL mode that commit syncs the WAL file). Sequence with backlog `feat-nativescript-storage-moves-to-sqlite-4` (GitHub #38), which changes the plugin's open, transaction and threading behaviour; its `batch()` fits this directly.
- The KV stores (`LevelDBKVStore`, `IndexedDBKVStore`, `SqliteKVStore`) share their backend's database handle; their writes join the same groups, or flush the same way. Each identity helper flushes after writing a new key, so a power cut right after first start cannot give the node a different peer id next time.
- A write group that is buffered and not yet flushed is lost by a process crash, where today each write survives one. That is the prefix rule at work (nothing in an unflushed group was reported yet), but it is a change in what a process crash costs and belongs in the per-backend table in `packages/db-p2p/docs/storage.md`.

If the decision instead keeps these platforms relaxed, this ticket narrows to documenting the guarantee per backend; the decision ticket explains why the obvious ways of closing the fork without syncing do not close it.

## What would confirm it

Not reproduced. A two-node in-process mesh (`packages/db-p2p/src/testing/mesh-harness.ts` can restart a node over its preserved storage and make a node unreachable) with a raw-storage double that models a relaxed store: writes are visible at once, and a `powerLoss()` call discards everything written since the last real sync, keeping a prefix. For a store that never syncs, everything since a chosen point. Run steps 1–6 and assert that P and B then hold different action ids for revision N of X. With the double syncing at every flush, the same steps must keep W1 on P. The double can be built over `MemoryStoreDriver` and is reusable by backlog `feat-a-node-can-be-declared-to-flush-storage-in-the-background`.

Per-backend checks that the flush really syncs need the real engines: `classic-level` for LevelDB (its `put`/`batch` accept `sync`), `node:sqlite` for SQLite (already the ns test driver), and a manual or device check for browsers, since `fake-indexeddb` has no durability.

## Edge cases

- The LevelDB log-file switch above: any native write made outside a synced batch (a direct `put` left in a driver, the identity helper) brings the hazard back, so every write goes through a group.
- Cost on devices is unmeasured: one synchronous write per group, two or three per user write. Measure on a phone before and after.
- Browser storage can be evicted under storage pressure unless the page holds persistent storage (`navigator.storage.persist()`); eviction loses everything, not just recent writes. Adjacent, out of scope.
- `packages/upgrade-check` has a LevelDB fixture, which must keep passing; the batched commit changes how writes reach the database, not the keys or values stored, so a database an older build wrote opens unchanged.
