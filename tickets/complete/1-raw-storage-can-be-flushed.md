description: Every storage backend now has a "make everything written so far safe on disk" step and a fixed statement of which crashes a flushed write survives; no backend's on-disk behaviour changed, every flush is still a no-op, and a node logs the statement once at start-up.
architecture: packages/db-p2p/docs/storage.md#invariants
files: packages/db-p2p/src/storage/store-durability.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/test/storage-monitor.spec.ts, packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/readme.md, packages/db-p2p-storage-fs/README.md, packages/db-p2p-storage-ns/README.md
----

# Raw storage can be flushed

GitHub #37. First half of the seam: the operation and its contract exist on every storage interface and backend. `storage-flushes-once-per-write-group` (prereq on this) makes `StorageRepo`, `applyInvalidation` and the under-replication ledger call it; `file-storage-pays-one-fsync-per-write-group` and `mobile-and-browser-storage-keep-the-durability-window` later give flush real work.

## What was built

- `StoreDurability = 'none' | 'process-crash' | 'power-loss'` in `packages/db-p2p/src/storage/store-durability.ts`, exported from both `src/index.ts` and `src/rn.ts` (the entry-parity spec demands the second).
- `RawStoreDriver` and `IRawStorage` gained **required** `flush(): Promise<void>` and `readonly durability: StoreDurability`. The five-rule flush contract is written once, in full, on `RawStoreDriver.flush`; `IRawStorage.flush` and `IKVStore.flush` point to it. The closing forwarding `NOTE:` on `RawStoreDriver` now says these two are required precisely because forwarding the optional members is unenforced.
- `IKVStore` gained **optional** `flush?()` (absent = every write is already as durable as it gets). No KV store in the repo implements it.
- Backends, each flush a commented no-op:

  | Driver | `durability` |
  |---|---|
  | `MemoryStoreDriver` | `'none'` |
  | `FileStoreDriver` | `'power-loss'`, with a `NOTE:` that promote's rename and the pending/materialized unlinks are not directory-synced (and on win32 no directory is synced at all, since `fsyncDir` skips it) |
  | `LevelDBStoreDriver` | `'process-crash'` |
  | `IndexedDBStoreDriver` | `'process-crash'` |
  | `SqliteStoreDriver` | `'process-crash'` |

  The rn/web/ns no-op comments name `mobile-and-browser-storage-keep-the-durability-window`; the fs `NOTE:` names `file-storage-pays-one-fsync-per-write-group`.
- Forwarding: `KvRawStorage` copies `durability` from the driver in its constructor and returns `driver.flush()`, and every `*RawStorage` class inherits both. `CachedStoreDriver` and `RawStorageDriverAdapter` forward both to what they wrap.
- Node start-up: `logStorageDurability` in `packages/db-p2p/src/libp2p-node-base.ts`, called right after `resolveStorage`, writes one `node-wiring` line from a `Record<StoreDurability, string>` (for example `storage: a flushed write survives a power cut or operating-system crash`; for `'none'`: `storage: in memory — nothing written survives a restart`). Its doc comment says it is the one place this is reported. `durability-window-scales-with-cohort-size` should extend this function.
- Test doubles: `CrashingRawStorage` routes `flush` through its `invoke` so a crash plan can target it. `CountingStoreDriver` counts `'flush'`, which is in neither `READ_METHODS` nor `WRITE_METHODS`, so existing ratios are unchanged. `GatedStoreDriver`, `FaultyStoreDriver` and the plugin's `LaggingRawStorage` forward both members. The `StorageMonitor` stub gets `flush: reject` plus `durability: 'none'`. `yarn typecheck` found `LaggingRawStorage`; `yarn build` alone does not type-check the tsup-built plugin's specs.

## Test added (one behaviour, four runs)

- Conformance case `every write resolved before flush() is read back by a fresh store over the same location` in `runRawStorageConformance`. It writes metadata, a revision, two pendings (one promoted, one deleted), a committed transaction, a proof, a materialized block, and a materialized block that is then deleted. It then flushes, reopens, and asserts each written thing is present, each deleted thing absent, and the promoted pending is in transactions and not in pending.
  - `ConformanceHarness.reopen?` and a third argument `ConformanceOptions { persistent?: true }`. The case is registered only under `persistent`, and it **throws** (it does not skip) when the harness has no `reopen`.
  - Registered `{ persistent: true }` by fs (a second `FileRawStorage` over the same dir), LevelDB (closes the handle, then `openAtPath`), IndexedDB (closes, then reopens the same name through `openOptimysticWebDb`) and SQLite. The **SQLite conformance harness is now file-backed** in a temp dir (`openTestFileDb`), so every SQLite conformance case now runs over a WAL file instead of `:memory:`; cleanup closes whichever handle is open and removes the dir. The memory, cached and kernel suites pass nothing.
  - It passes trivially today. It is the contract the file backend's write log must keep.
- No other tests: forwarding is enforced by the types.

## Validation run

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs`: all clean.
- `db-p2p`: 3309 passing, 70 pending, 1 failing. The failure was the entry-parity spec (store-durability missing from `rn.ts`); after the fix only the parity spec was re-run (9 passing), not the whole suite.
- fs 80 passing / 1 pending (the existing win32 `this.skip()`); rn 54; web 53; ns 59; `upgrade-check` 101; `quereus-plugin-optimystic` 1015 passing / 14 pending, plus smoke ok. `--grep flush` confirmed the new case runs once in each of the four persistent suites.
- **Not run:** `yarn check:rn` (Metro + hermesc). `rn.ts` gained only `export * from './storage/store-durability.js'`, a type-only module that compiles to an empty one, so the risk is low but unverified. `yarn test:integration` was not run either.

## Docs

- `packages/db-p2p/docs/storage.md`: "five properties" changed to six, a new `### 6. A write survives a crash once a flush() called after it has resolved` (the contract, the per-backend table, the file backend's gap, the start-up log line, the conformance case), and a Durability bullet under `### 3. Raw Storage Interface`. Invariant 5's "other four invariants" is now "other invariants". The write-ordering list and "who calls flush" are deliberately left for `storage-flushes-once-per-write-group`.
- `packages/db-p2p-storage-fs/README.md`: "Every write" changed to "Every value write" (promote and deletes do not go through `atomic-write.ts`), and a new Durability section. `packages/db-p2p-storage-ns/README.md`: a durability paragraph under the pragmas. `packages/db-p2p/readme.md`: the `IRawStorage` bullet names `durability` per backend and links §6.

## For the reviewer — known gaps and judgement calls

- `durability: 'power-loss'` on the fs backend is a claim with a documented hole (renames, unlinks, and every directory on win32); the ticket asked for that value plus the `NOTE:`. Check that the `NOTE:` wording is accurate enough for whoever implements the write log.
- The rule 3 (prefix) claim for the `'process-crash'` backends under an OS crash rests on how their write-ahead logs recover (LevelDB log and SQLite WAL both stop at the first bad record). I did not verify this against IndexedDB's relaxed durability.
- Subclasses of `KvRawStorage` must never redeclare `durability` as a plain field. `useDefineForClassFields` is on, so the redeclaration would clobber the value the base constructor set (the same trap `CachedRawStorage` documents for `readCached`). None do; this is inspection-only.
- The IndexedDB conformance cleanup still only closes the database; it never deletes it. That is pre-existing, and harmless under `fake-indexeddb`.
- Test logs: `tickets/.logs/raw-storage-can-be-flushed.*.test.log`.

## Review findings

Read the diff of `ticket(implement): raw-storage-can-be-flushed` first, then the handoff above.

**Checked, and nothing to change:**
- Interface and forwarding: `flush` and `durability` are required on `RawStoreDriver` and `IRawStorage`, optional on `IKVStore`. `KvRawStorage`, `CachedStoreDriver` and `RawStorageDriverAdapter` copy `durability` once at construction and forward `flush`. No subclass of `KvRawStorage` redeclares `durability`, so the `useDefineForClassFields` trap the handoff named does not occur. `withReadCache` dedupe means two consumers flushing one shared store both reach the one inner driver, which rule 4 allows.
- The start-up line: `logStorageDurability` runs once, right after `resolveStorage`, from one place, through an exhaustive `Record<StoreDurability, string>`.
- Conformance case: it is registered only under `{ persistent: true }` and throws when no `reopen` is supplied, so it never quietly skips (backlog `debt-a-test-can-quietly-decide-not-to-run`). It covers every write kind the plan listed. The four harnesses close before reopening, and LevelDB has to, because it holds a lock on its directory. Moving the SQLite harness onto a file costs nothing measurable (59 cases in about 270 ms).
- Tests: the one new case pins the contract the file backend's write log will have to keep. The test-double changes are forwarding the type checker requires. Nothing to cut.
- The values: SQLite in WAL mode with `synchronous = NORMAL`, and LevelDB with `sync: false`, both survive a process crash and not an OS crash, so `'process-crash'` is right for each. IndexedDB at default durability gets the same value.
- `rn.ts` export parity: the full db-p2p suite now passes, including the entry-parity spec the implementer had only re-run on its own.

**Found and fixed in this pass (minor):**
- The file backend's durability `NOTE:` missed a gap. `atomicWriteFile` creates missing directories with a recursive `mkdir`, then syncs only the written file's own directory and never the parent that gained the new entry. A power cut can therefore drop a new block's directory, and every synced file in it. The directory sync is also best-effort (a failure is ignored). I extended the `NOTE:` at `FileStoreDriver.durability`, the "file backend's gap" paragraph in `packages/db-p2p/docs/storage.md`, and the Durability section of `packages/db-p2p-storage-fs/README.md`. The same gap is appended as a third arm in `file-storage-pays-one-fsync-per-write-group`: its checkpoint must also sync the parent of every directory it creates.
- Rule 3 (what survives any crash is a prefix) is not established for the LevelDB and IndexedDB backends under an OS crash. This is the gap the handoff flagged. LevelDB's recovery under default options skips a damaged log record and keeps reading the records after it, and browsers promise nothing about relaxed transactions. SQLite's write-ahead log stops at the first bad frame, so SQLite is fine. I added `NOTE:`s at `durability` on `LevelDBStoreDriver` and `IndexedDBStoreDriver`, and a "Rule 3 past the crashes a store names" paragraph to storage.md §6. I also appended the evidence to `mobile-and-browser-storage-keep-the-durability-window`, which already owns write order across a power cut. `repro: static` (from LevelDB's `DBImpl::RecoverLogFile`); not reproduced.

**Major findings filed:** none. Both gaps above are already owned by planned tickets, and I added each as an arm there rather than filing a new ticket.

**Tripwires:** none new beyond the two `NOTE:` additions above, which record known gaps with an owning ticket.

**Left alone:** the IndexedDB conformance cleanup still never deletes its database. That predates this ticket and is harmless under `fake-indexeddb`.

**Validation (this pass):** `yarn build`, `yarn lint` and `yarn lint:docs` are clean. db-p2p: 3310 passing, 70 pending. fs: 80 passing, 1 pending (the existing win32 skip). rn: 54. web: 53. ns: 59. I did not re-run `yarn typecheck`, because this pass changed only comments and docs. I did not run `yarn check:rn` or `yarn test:integration` either, as the handoff already noted.
