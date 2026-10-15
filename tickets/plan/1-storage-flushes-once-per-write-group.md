description: Storage cannot be told "this group of writes is finished, make it safe on disk now", so each storage backend either waits for the disk on every single file or never waits at all. Add that one step, and have the node take it once at the end of every group of writes whose outcome it is about to report to other machines.
architecture: packages/db-p2p/docs/storage.md#invariants
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/repo/kv-under-replication-ledger.ts, packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/testing/reactivity-mesh-harness.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/leveldb-kv-store.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/indexeddb-kv-store.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/sqlite-kv-store.ts, packages/db-p2p/docs/storage.md, docs/correctness.md, docs/internals.md
----

# Storage flushes once per write group

Reported in GitHub #37 (kjeib). This ticket is the seam; `file-storage-pays-one-fsync-per-write-group` uses it to cut the file backend's cost, and `mobile-and-browser-storage-keep-the-durability-window` uses it to make the other backends durable. It changes no backend's behaviour on disk.

## What is wrong now

The storage interfaces have one durability rule, and it is implicit: a write is whatever the backend makes it at the moment the call resolves. That produces two opposite problems.

1. **The file backend pays for durability once per file.** `atomicWriteFile` in `packages/db-p2p-storage-fs/src/atomic-write.ts` writes a temp file, fsyncs it, renames it, then fsyncs the directory, for every value it stores. A node applies one pend as two such writes per block (`BlockStorage.savePendingTransaction`: the metadata with the pending record's claim, then the record) and one commit as four per block (`StorageRepo.internalCommit`: the materialized block, the revision record, the metadata `BlockStorage.setLatest` writes, the commit proof), plus a rename and an unlink. That is twelve fsyncs per block per write, one after another; six to twelve blocks per small SQL transaction gives the 72–144 fsyncs per commit #37 counted (the block count is inferred from that match, not measured). `FileKVStore.set` adds two more per under-replication ledger entry.
2. **The other three backends never wait for the disk**, and nothing lets the node ask them to (LevelDB with default write options, IndexedDB with default durability, SQLite with `synchronous = NORMAL`). See `durability-window-scales-with-cohort-size` for what that costs.

The writes already arrive in groups. Every write to block storage happens inside one of a few `StorageRepo` methods in `packages/db-p2p/src/storage/storage-repo.ts` — `pend`, `commit`, `cancel`, `saveReplicatedBlock`, `recoverBlock`, and the read-driven promotion and coverage restore inside `get` — or in `applyInvalidation` (`packages/db-p2p/src/dispute/invalidation.ts`), always under the block write latches, and the caller reports the outcome to other machines only after the method returns. The storage interfaces have no way to hear where a group ends.

## What to add

- `flush(): Promise<void>` on `RawStoreDriver` (`packages/db-p2p/src/storage/raw-store-driver.ts`) and on `IRawStorage` (`packages/db-p2p/src/storage/i-raw-storage.ts`), required. Optional on `IKVStore` (`packages/db-p2p/src/storage/i-kv-store.ts`), because hosts implement that interface outside this repository; absent there means "every write is already as durable as it will ever be when it resolves".
- Proposed contract, for the interface comments and `packages/db-p2p/docs/storage.md`:
  - A write method resolves once its effect is visible to every later read in this process.
  - Once a `flush()` called after the write resolved has itself resolved, the write survives every crash this backend can survive.
  - **What survives any crash is a prefix of the resolved writes, in the order they resolved.** No write survives while one that resolved before it is lost.
- The third rule is what keeps the existing crash-recovery reasoning valid once writes are no longer synced one at a time. Every "if the process crashes between these two steps" argument in `BlockStorage` and `StorageRepo` assumes a later step cannot be on disk while an earlier one is not; the orderings it protects are listed below.
- Recommended in the same change: a declared, read-only capability on each driver saying what its flush achieves (`'none' | 'process-crash' | 'power-loss'`, name to taste), forwarded like `storeIdentity`, and logged once at node start beside the existing `node-wiring` lines. It makes the per-backend table below visible on a running node instead of living only in a comment.
- `KvRawStorage` forwards `flush` to its driver. Every wrapper forwards it: `CachedStoreDriver` (`packages/db-p2p/src/storage/cached-store-driver.ts`, which holds no dirty state, so flushing it means flushing the inner driver), `RawStorageDriverAdapter` and `CachedRawStorage` (`packages/db-p2p/src/storage/cached-raw-storage.ts`), and the shared cache `withReadCache` hands out. Being required, a wrapper that forgets it does not type-check — which the NOTE at the end of `RawStoreDriver` says is not true of the optional members.

## Who calls it

- Each `StorageRepo` method that wrote anything calls flush exactly once: after releasing its latches, so a concurrent group on the same blocks is not held behind the disk and several groups can share one sync, and before it emits change events and returns. That includes the exits that fail after writing something (a commit that landed some blocks and then hit a fault; the missing-pend throw after `dropUnpromotablePendings`), and `get` only when it promoted or restored something.
- `StorageRepo` does not hold the raw storage; it builds a `BlockStorage` per block from a factory (`createLibp2pNodeBase` in `packages/db-p2p/src/libp2p-node-base.ts`, the two test harnesses, the conformance suite, and the local transactor in `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`). Recommended: hand `StorageRepo` the store's flush explicitly (a required constructor argument or the raw storage itself), so a new construction site cannot skip it silently. Planner's choice.
- `applyInvalidation` flushes after its compensating writes and before it reports.
- `KvUnderReplicationLedger` (`packages/db-p2p/src/repo/kv-under-replication-ledger.ts`) flushes its store after any call that wrote. `CoordinatorRepo.noteReplicationShortfall` records the shortfall before it answers the writer, and the ledger exists so that the record outlives a restart.
- `PersistentTransactionStateStore` (only wired when a host passes `NodeOptions.transactionStateStore`) writes fire-and-forget and promises nothing before it replies; it needs nothing of its own.
- A flush that fails is a storage fault: the method throws. For `commit` that is the path a raw-storage error already takes through `ClusterMember.applyConsensusOperation` (propagate, roll back the executed marker, retry). A backend whose sync failed refuses later writes and flushes until it is reopened (the file backend's rule in `file-storage-pays-one-fsync-per-write-group`), so a retry cannot report success over writes that may be gone.

## What each backend's flush does in this ticket

| Backend | What a write waits for today | `flush()` here |
|---|---|---|
| memory (`MemoryStoreDriver`) | nothing; nothing survives a restart | no-op |
| fs (`FileStoreDriver`, `FileKVStore`) | an fsync of the file and its directory, per value; renames and unlinks are not directory-synced | no-op until `file-storage-pays-one-fsync-per-write-group` replaces per-file syncing |
| rn (`LevelDBStoreDriver`, `LevelDBKVStore`) | LevelDB with default write options: handed to the OS, not synced | no-op, documented as surviving a process crash only |
| web (`IndexedDBStoreDriver`, `IndexedDBKVStore`) | one implicit IndexedDB transaction per write, default durability (relaxed in current browsers) | same |
| ns (`SqliteStoreDriver`, `SqliteKVStore`) | SQLite in WAL mode with `synchronous = NORMAL` (`applySchema` in `packages/db-p2p-storage-ns/src/db.ts`) | same |

A no-op must be documented as what it is. On rn, web and ns, writes reach the operating system when they resolve and survive a crash of the process, not a power cut or an operating-system crash.

## Orderings crash recovery relies on

These are the step orders the code states as load-bearing. Today each holds because every step is synced before the next starts (two exceptions noted). After this seam, the prefix rule is what holds them, and the reviewer of every backend's flush checks them.

1. **Claim before record.** `BlockStorage.savePendingTransaction` writes the slot and base the record claims into the block's metadata before the pending record itself, so a crash between them leaves an inert claim and never a claim-less record, which every reader treats as the strongest reservation (`isReservationAgainst` in `packages/db-p2p/src/storage/pending-claim.ts`).
2. **One block's commit, in order** (`StorageRepo.internalCommit`): materialized block, revision record, promote (pending to committed), `setLatest` (latest, ranges, lineage floor, the action's claim dropped, dead claims swept), proof, prune of the prior materialization. `latest` must never be on disk naming a revision whose record or transform is not. The prune must never be on disk without the new materialization and `setLatest`, or the block has no materialization left. The only partial states the retry path heals are the two the code names: revision saved but not promoted (Crash-D2), and promoted with `setLatest` lost (Crash-D3, healed by `BlockStorage.recover` from `StorageRepo.commit`).
3. **Promote is one atomic move** (Invariant P in `docs/repository.md`): never the pending and the committed record together, never neither.
4. **Log tail first** (`tailFirst` in `storage-repo.ts`): a member that holds a committed non-tail block of an action also holds the action's committed log tail. `Collection.bootstrapContext` relies on it.
5. **Forward writes** (`BlockStorage.saveForwardRevision`, for replicas and tombstones): revision record, transform, materialization and proof before the metadata that advances `latest`, and the same action's pending record deleted no later than that metadata.
6. **Coverage restore** (`BlockStorage.restoreRevision`): the restored records before the `ranges` entry that claims them.
7. **Delete before the claim is dropped** (`BlockStorage.deletePendingTransaction`, `refuseMissingBase`, `dropUnpromotablePendings`): the record's removal before the metadata write that drops its claim; the reverse would leave a claim-less record.
8. **Across stores:** the durable executed marker (`markExecuted` in `ClusterMember.handleConsensus`) after the apply it describes, and the under-replication entry after the commit it describes. The two stores are two durability domains; these hold because `StorageRepo` flushes before it returns and the second write is issued afterwards.

Orders 3 and 7 are not guaranteed on the file backend today: the promote is a bare rename and the deletes are bare unlinks, none directory-synced, while the metadata write after them is synced. See the defect section of `file-storage-pays-one-fsync-per-write-group`.

## Edge cases & interactions

- **Concurrent groups.** Latches are released before the flush, so a second group on the same block can read the first group's writes before they are durable and build on them. That is safe under the prefix rule (the second group's writes are later, so they cannot survive without the first's), and it is what lets one sync serve several groups. Verify by inspection of each backend's flush.
- **Visible before durable.** Between a write resolving and its flush, readers in this process, and through them other machines, can see it. Today the same window exists for the duration of one rename; it now spans a group. What a read can expose is consensus-decided content or a pending record, and what a crash takes back is always a later suffix: a vote built on a record's absence stays valid when the record is lost, and one built on its presence was a refusal. Record this as an accepted property in storage.md.
- **The read-path re-cache** in `BlockStorage.materializeBlock` writes a materialization outside any group. It needs no flush (it can be recomputed) and becomes durable with the next one.
- **Change events** fire after the flush, so nothing announces a commit this node could still lose.
- **Test doubles that implement `IRawStorage` or `RawStoreDriver` directly** (`packages/db-p2p/test/mid-ddl-crash.spec.ts`, `packages/db-p2p/test/support/cache-test-helpers.ts`, any typed object literal) need a `flush`; that is the point of making it required.
- **The drain's ledger writes** (`UnderReplicationDrain`) are off the commit path; they flush too, so the ledger never reports a peer satisfied that a restart forgets.

## Verification

- One conformance case in `runRawStorageConformance` (`packages/db-p2p/src/testing/raw-storage-conformance.ts`): every write resolved before `flush()` is read back by a fresh store over the same location. That needs an optional `reopen` on `ConformanceHarness`, supplied by the persistent backends' suites (fs; LevelDB via `classic-level`; SQLite via `node:sqlite`; IndexedDB via `fake-indexeddb`); the memory suite omits it. It passes trivially for every backend in this ticket and is the contract the file backend's log must keep.
- Who calls flush is wiring, checked by review against the list above, not by tests.

## Docs

- `packages/db-p2p/docs/storage.md`: a sixth invariant stating the contract, the per-backend table, and the ordering list.
- `docs/correctness.md` Theorem 6 says log entries "are written via batch write with fsync", which is true of the file backend only; say what each backend does and point to the decision. §1.2 says a recovering node "restores its persisted per-cluster coordinator state"; that happens only when `NodeOptions.transactionStateStore` is supplied, and no default wiring supplies it (the NOTE on `resolveKvStore` in `packages/db-p2p/src/libp2p-node-base.ts` says so).
- `docs/internals.md` Commit Path: one line saying each storage apply ends with one flush.
