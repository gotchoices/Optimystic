description: Storage writes are held in memory and served from there until the node says the group of writes is finished, then handed to the backend as one batch to make safe on disk in a single step. This is the shared half of making file storage wait for the disk once per commit instead of dozens of times, and the phone and browser backends will commit their groups through the same seam.
prereq: storage-flushes-once-per-write-group
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/batch-backend.ts, packages/db-p2p/src/storage/write-group.ts, packages/db-p2p/src/storage/write-group-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/src/index.ts, packages/db-p2p/test/write-group-driver.spec.ts, packages/db-p2p/docs/storage.md
difficulty: hard
----

# Write-group overlay driver

First of three tickets from `file-storage-pays-one-fsync-per-write-group` (GitHub #37). The research and the reasons for the design are in that ticket's `complete/` record; this one builds the backend-independent part. `file-storage-commits-groups-through-a-log` gives the file backend a batch commit, and `file-store-checkpoint-and-shared-log` finishes the file backend and the docs.

## What to build

A `RawStoreDriver` wrapper, `WriteGroupDriver` in `packages/db-p2p/src/storage/write-group-driver.ts`, beside `CachedStoreDriver`, over a new contract `BatchBackend` in `packages/db-p2p/src/storage/batch-backend.ts`:

```ts
export type StoreKey =
	| { store: 'metadata'; blockId: BlockId }
	| { store: 'revisions' | 'proofs'; blockId: BlockId; rev: number }
	| { store: 'pending' | 'transactions' | 'materialized'; blockId: BlockId; actionId: ActionId };
/** `value` absent means delete. */
export interface BatchEntry { key: StoreKey; value?: Uint8Array }
export interface BatchBackend {
	readonly durability: StoreDurability;
	get(key: StoreKey): Promise<Uint8Array | undefined>;
	/** Ascending `[rev, value]` for present revs in `[lo, hi]`, fully drained. */
	rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]>;
	listPendingActionIds(blockId: BlockId): Promise<ActionId[]>;
	/** Apply every entry, in order, atomically and as durably as `durability` says, before resolving. Rejecting is a storage fault. */
	commit(entries: readonly BatchEntry[]): Promise<void>;
	storeIdentity?(): StoreIdentity;
	listBlockIds?(): AsyncIterable<BlockId>;
	approximateBytesUsed?(): Promise<number>;
	close?(): Promise<void>;
}
```

The driver keeps an **overlay** (canonical key string → bytes, or a deletion marker, with the sequence number of the batch that holds it) and an **open batch** (entries in resolution order). Every write — `putMetadata`, `putRevision`, `putPending`, `deletePending`, `putTransaction`, `putProof`, `putMaterialized`, `deleteMaterialized` — records its effect in both and resolves at once, so a write never waits for the disk. `promote` reads the pending bytes (overlay, else backend), throws the exact `Pending action <actionId> not found for block <blockId>` message when absent, and records its result: put `transactions` with those bytes, delete `pending`. Point reads consult the overlay first, including a deletion marker, which answers `undefined` without asking the backend.

Keep the key-agnostic part — the overlay map, the open batch, flush chaining, the failure latch and the idle timer — in a class `WriteGroup` in `packages/db-p2p/src/storage/write-group.ts` over string keys and a `commit(entries)` callback. `WriteGroupDriver` layers `StoreKey` canonicalization and the listing merges on it. `file-store-checkpoint-and-shared-log` reuses `WriteGroup` for `FileKVStore`, whose keys are strings.

**`flush()`** is the group commit. With an empty open batch and no commit in flight it resolves at once, so a group that wrote nothing costs no sync. Otherwise it seals the open batch, chains its commit behind the commit in flight (batches commit one at a time, in sequence, which is what makes what survives a crash a prefix), and resolves when that commit resolves. A write arriving while a commit is in flight goes into the next batch; a `flush()` arriving then waits for the in-flight commit and then for the next, so concurrent groups share one sync (rule 4 of the flush contract on `RawStoreDriver.flush`). When a commit resolves, every overlay entry whose batch sequence is that batch's is dropped; one a later write replaced stays. A rejected commit latches the driver failed: every later write and flush rejects with a `StoreFailedError` carrying the cause (rule 5). Reads keep working.

**Idle flush.** Writes nothing flushed — the read path's re-cache in `materializeBlock`, fire-and-forget state writes — must not sit in memory for ever. The first entry into an open batch arms an unref'd timer (`armUnrefTimer` from `packages/db-p2p/src/unref-timer.ts`, option `idleFlushMs`, default 1000) that calls `flush()`; a failure there latches the store failed and is logged.

**Listings merge overlay and backend.** `rangeRevisions`: backend rows plus overlay puts in range, ordered, reversed when asked (revisions are never deleted). `listPendingActionIds`: backend ids minus overlay deletions plus overlay puts. `listBlockIds`, when the backend has it: backend ids plus every block whose metadata is in the overlay, deduplicated. Two `RawStoreDriver` rules hold for the merged listings too: drain before yield, and a record deleted in the overlay never reappears from the backend.

**`close()`**: flush once more, cancel the idle timer, then close the backend. Forward the optional members (`storeIdentity`, `listBlockIds`, `approximateBytesUsed`, `close`) exactly as `CachedStoreDriver` does; `durability` is the backend's.

## Contract changes around it

- `IRawStorage` gains an optional `close?(): Promise<void>`; `KvRawStorage` wires it when the driver has one, under the same feature-detection rule as `listBlockIds` (no stub). `CachedRawStorage` and `CachedStoreDriver` already forward or withhold `close` deliberately; leave their choices. The conformance `reopen` case must call `storage.close?.()` on the first store before `harness.reopen()`, or on a file backend it would read the first store's overlay and prove nothing.
- Add a test-only `MemoryBatchBackend` under `packages/db-p2p/src/testing/` (a `BatchBackend` over maps, with an optional hook to make `commit` reject or record its batches). Register `runRawStorageConformance('WriteGroupDriver over memory', …)` with it.
- Update the driver table and the "who calls flush" text in `packages/db-p2p/docs/storage.md` Invariant 6 to say which writes now wait in memory, and export the new modules from `packages/db-p2p/src/index.ts`.

## Edge cases & interactions

- A `flush()` with nothing to commit, called while a commit is in flight: wait for that commit (its batch holds every write resolved before this call). Test.
- Two groups flushing while one commit is in flight share the next commit: exactly two backend commits for three flushes. Test with the memory backend's batch recorder.
- A write made after a batch is sealed but before its commit resolves is not dropped from the overlay when that commit resolves. Test by writing the same key twice across a parked commit.
- Overlay deletion then backend presence: `getPending` answers `undefined`, `listPendingActionIds` omits it. Test.
- `promote` of a record whose pending write is still only in the overlay. Covered by conformance's promote case over the memory backend, since nothing is flushed there.
- Rejected commit: later writes and flushes throw `StoreFailedError`; the overlay is not dropped. Test.
- Failure inside the idle flush: same latch, one log line. By inspection.
- Overlay size is bounded by unflushed groups under the current policy (`StorageRepo` flushes every group). A background-flush mode (`durability-window-scales-with-cohort-size`) must bound it; say so in a `NOTE:` at the map.
- `rangeRevisions` with `reverse` and overlay rows in range: order after merging, not before. Test.
- `close()` racing a commit in flight: close waits for it, then flushes the remainder once. By inspection.

## Verification

- `yarn workspace @optimystic/db-p2p build`, then its `yarn test` (the conformance suites, the new `write-group-driver.spec.ts`, and `storage-repo.spec.ts`'s flush cases, which must keep passing unchanged).
- `yarn lint`, `yarn lint:docs`.

## TODO

- `batch-backend.ts`: `StoreKey`, `BatchEntry`, `BatchBackend`, and a `canonicalStoreKey(key): string` helper.
- `write-group.ts`: overlay map, open batch, sequenced commit chain, failure latch (`StoreFailedError`), idle timer, `close`.
- `write-group-driver.ts`: `RawStoreDriver` over `WriteGroup` + `BatchBackend`, listing merges, optional forwarding.
- `IRawStorage.close?` and `KvRawStorage` wiring; conformance `reopen` case closes first.
- `src/testing/memory-batch-backend.ts` and its conformance registration; `test/write-group-driver.spec.ts` for the cases above.
- Exports, `storage.md` Invariant 6 text, `yarn lint:docs`.
