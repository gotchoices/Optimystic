description: Give every storage backend a "make everything written so far safe on disk" step and a plain statement of what that step protects against, without changing what any backend does on disk yet. The next ticket makes the node call it once per group of writes.
architecture: packages/db-p2p/docs/storage.md#invariants
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p/src/storage/store-durability.ts (new), packages/db-p2p/src/index.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p/docs/storage.md, packages/db-p2p-storage-fs/README.md, packages/db-p2p-storage-ns/README.md, packages/db-p2p/readme.md
----

# Raw storage can be flushed

Reported in GitHub #37 (kjeib). First half of the seam the original plan ticket `storage-flushes-once-per-write-group` described: this ticket adds the operation and the contract to the storage interfaces and every backend; `storage-flushes-once-per-write-group` (prereq on this one) makes `StorageRepo`, `applyInvalidation` and the under-replication ledger call it. **No backend's on-disk behaviour changes here** — every flush is a no-op, documented as what it is. `file-storage-pays-one-fsync-per-write-group` and `mobile-and-browser-storage-keep-the-durability-window` later give flush real work.

## Why

Today a write is "whatever the backend makes it at the moment the call resolves": the file backend fsyncs every value (two fsyncs per file, dozens per commit), and LevelDB, IndexedDB and SQLite never wait for the disk. Nothing lets the node say "this group of writes is finished, make it safe now". Once it can, the file backend can pay one sync per group instead of one per file, and the other backends can be made durable at a known point.

## Interface

New file `packages/db-p2p/src/storage/store-durability.ts`, exported from `packages/db-p2p/src/index.ts` beside `store-identity`:

```ts
/**
 * What a write survives once a `flush()` called after it has resolved.
 * - 'none'          — nothing survives a restart (in-memory).
 * - 'process-crash' — survives this process crashing; NOT an operating-system crash or power cut.
 * - 'power-loss'    — survives a power cut or operating-system crash.
 */
export type StoreDurability = 'none' | 'process-crash' | 'power-loss';
```

`RawStoreDriver` (`packages/db-p2p/src/storage/raw-store-driver.ts`) and `IRawStorage` (`packages/db-p2p/src/storage/i-raw-storage.ts`) both gain, **required**:

```ts
flush(): Promise<void>;
readonly durability: StoreDurability;
```

Required, not optional, so a wrapper that forgets to forward either does not type-check. Update the closing `NOTE:` in `RawStoreDriver` (which says forwarding the optional members is unenforced) to say these two are required for exactly that reason.

`IKVStore` (`packages/db-p2p/src/storage/i-kv-store.ts`) gains `flush?(): Promise<void>` — **optional**, because hosts implement that interface outside this repository. Absent means "every write is already as durable as it will ever be when it resolves". No KV store in this repository gains one in this ticket: for each of them absence is the accurate statement today (`FileKVStore` fsyncs every `set`; the LevelDB, IndexedDB and SQLite KV stores have nothing a flush could add yet; `MemoryKVStore` keeps nothing).

## The contract

Write this once, in full, on `RawStoreDriver`; `IRawStorage` and `IKVStore.flush` point to it; `packages/db-p2p/docs/storage.md` states it as a sixth invariant.

1. A write method resolves once its effect is visible to every later read in this process.
2. Once a `flush()` called after the write resolved has itself resolved, the write survives every crash this store's `durability` names.
3. **What survives any crash is a prefix of the resolved writes, in the order they resolved.** No write survives while one that resolved before it is lost.
4. A `flush()` covers every write resolved before it was called, including writes made by other callers; concurrent flushes may share one sync.
5. A rejected `flush()` is a storage fault. After one, the store rejects every later write and flush until it is reopened, because a retried sync can report success for data the operating system already dropped.

Rule 3 is what keeps the existing crash-recovery reasoning in `BlockStorage` and `StorageRepo` valid once writes stop being synced one at a time; the step orders it protects are listed by `storage-flushes-once-per-write-group`. Rules 4 and 5 bind backends that do real work (the next tickets); every flush in this ticket trivially satisfies them.

## Each backend in this ticket

| Driver | `flush()` | `durability` | Why |
|---|---|---|---|
| `MemoryStoreDriver` | resolves | `'none'` | nothing survives a restart |
| `FileStoreDriver` (`packages/db-p2p-storage-fs/src/file-storage.ts`) | resolves | `'power-loss'` | every value is fsynced (file and directory) as it is written. `NOTE:` at the site: renames (promote) and unlinks (pending/materialized deletes) are not directory-synced, so a power cut can lose a promote or a delete while keeping the metadata write after it; `file-storage-pays-one-fsync-per-write-group` closes that |
| `LevelDBStoreDriver` (rn) | resolves | `'process-crash'` | default write options hand writes to the OS without syncing |
| `IndexedDBStoreDriver` (web) | resolves | `'process-crash'` | one implicit transaction per write, default (relaxed, in current browsers) durability |
| `SqliteStoreDriver` (ns) | resolves | `'process-crash'` | WAL mode with `synchronous = NORMAL` (`applySchema` in `packages/db-p2p-storage-ns/src/db.ts`) |

Each no-op carries a one-line comment saying it is a no-op and why, and the rn/web/ns ones name `mobile-and-browser-storage-keep-the-durability-window`.

Forwarding:

- `KvRawStorage` (`packages/db-p2p/src/storage/kv-raw-storage.ts`): `flush()` returns `this.driver.flush()`; `durability` is copied from the driver in the constructor. `MemoryRawStorage`, `CachedRawStorage`, `FileRawStorage`, `LevelDBRawStorage`, `IndexedDBRawStorage` and `SqliteRawStorage` all extend it and inherit both.
- `CachedStoreDriver` (`packages/db-p2p/src/storage/cached-store-driver.ts`): forwards both to `inner`. It is write-through and holds no dirty state, so flushing it means flushing the inner driver — say so in one line.
- `RawStorageDriverAdapter` (`packages/db-p2p/src/storage/cached-raw-storage.ts`): forwards both to the wrapped `IRawStorage`.
- `withReadCache` hands out a `CachedRawStorage`, which inherits through `KvRawStorage`; nothing to add.
- Test doubles that implement the interfaces directly get both members: `CrashingRawStorage` (`packages/db-p2p/test/mid-ddl-crash.spec.ts`), `CountingStoreDriver` (`packages/db-p2p/test/support/cache-test-helpers.ts`, forward to its inner driver), `GatedStoreDriver` and `FaultyStoreDriver` (`packages/db-p2p/test/cached-raw-storage.spec.ts`). `yarn build` (tsc over `src` and `test`) finds any other typed object literal.

## Visible on a running node

In `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`), right after `resolveStorage`, log once on the existing `wiringLog` (`node-wiring`) channel the resolved storage's `durability`, phrased for an operator, e.g. `storage: a flushed write survives %s` — and for `'none'`, that nothing survives a restart. `durability-window-scales-with-cohort-size` builds on this line (it logs a backend that cannot sync); keep it a single line from one place.

## Verification

- **One conformance case** in `runRawStorageConformance` (`packages/db-p2p/src/testing/raw-storage-conformance.ts`): every write resolved before `flush()` is read back by a fresh store over the same location. Writes to cover: metadata, a revision, two pendings with one promoted and the other deleted, a committed transaction, a proof, a materialized block, and a materialized delete (`saveMaterializedBlock` with no block). After reopen, each written thing is present, each deleted thing absent, and the promoted pending is in the transactions store and not the pending store.
  - `ConformanceHarness` gains `reopen?: () => Promise<IRawStorage>`: close whatever the current storage holds open and return a fresh storage over the same location; `cleanup` still removes the location and closes the reopened handle.
  - Do not make the case skip itself when `reopen` is absent (backlog `debt-a-test-can-quietly-decide-not-to-run`). Instead `runRawStorageConformance` takes a third optional argument, `{ persistent: true }`; only then is the case registered, and it fails loudly if the harness supplied no `reopen`. The memory, cached and kernel suites (`packages/db-p2p/test/kv-raw-storage.spec.ts`, `cached-raw-storage.spec.ts`, `shared-cache-pool.spec.ts`) pass nothing.
  - Persistent suites: fs (`new FileRawStorage(base)` again); LevelDB via `classic-level` (close the handle, reopen at the same directory — LevelDB holds a lock); IndexedDB via `fake-indexeddb` (close the db, reopen it by the same name through the package's own opener); SQLite via `node:sqlite` — its conformance harness is in-memory today, so make that suite's harness open a file-backed database in a temp directory (cleanup closes it and removes the directory) so it can reopen.
  - It passes trivially for every backend here. It is the contract the file backend's log (`file-storage-pays-one-fsync-per-write-group`) must keep, which is why it pays for itself.
- No other new tests: forwarding is enforced by the types.

## Docs

- `packages/db-p2p/docs/storage.md`: change "These five properties" to six and add `### 6.` stating the contract above, with the per-backend table (driver, what a write waits for today, what `flush()` does, `durability`). Under `### 3. Raw Storage Interface (IRawStorage)`, one bullet naming `flush` and `durability`. The ordering list and "who calls flush" are added by `storage-flushes-once-per-write-group`; do not write them here.
- `packages/db-p2p-storage-fs/README.md`, `packages/db-p2p-storage-ns/README.md`, `packages/db-p2p/readme.md` mention fsync / durability / `synchronous`; make sure nothing there contradicts the table (and name `durability` where a reader would look for it).
- Run `yarn lint:docs`.

## Edge cases & interactions

- **A wrapper that forgets to forward** — impossible by type (both members required). Verified by `yarn build`.
- **`durability` must not change over a store's life** — it is fixed at construction like `storeIdentity`; say so in the doc comment. Verified by inspection.
- **Shared cache** (`withReadCache` dedupe): two consumers flushing one shared `CachedRawStorage` both reach the one inner driver — correct under rule 4. Inspection.
- **`CachedStoreDriver.close` withholds closing in some cases** (see its site): unrelated to flush; do not add flush-on-close here.
- **Host-implemented `IRawStorage`** outside this repo now fails to compile until it adds `flush` and `durability`. Accepted (no backwards compatibility yet, per AGENTS.md); `IKVStore` keeps it optional for that reason.
- **The upgrade fixtures** (`packages/upgrade-check`) are unaffected: nothing on disk changes. `yarn test` there confirms.

## TODO

- Add `store-durability.ts` and export it; add `flush` + `durability` to `RawStoreDriver` and `IRawStorage`, optional `flush` to `IKVStore`, with the contract text; update the forwarding `NOTE:`.
- Implement in `KvRawStorage`, `MemoryStoreDriver`, `CachedStoreDriver`, `RawStorageDriverAdapter`, and the four backend drivers with the values and comments above.
- Add both members to the test doubles; `yarn build` from root until clean.
- Log the durability once at node start.
- Add `{ persistent: true }` + `reopen` to the conformance suite and the reopen case; supply `reopen` in the fs, LevelDB, IndexedDB and SQLite suites (SQLite harness becomes file-backed).
- Docs: storage.md invariant 6 + table + interface bullet; reconcile the three readmes; `yarn lint:docs`.
- Run `yarn test` for db-p2p and the four storage packages, and `yarn typecheck`.
