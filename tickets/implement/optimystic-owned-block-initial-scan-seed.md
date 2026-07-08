description: When a node restarts, the resilience monitors that re-replicate and re-home data don't protect blocks already saved on disk until each one is next touched. Add a way to list the stored blocks and, at startup, seed the monitors' tracked set from that list.
prereq:
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/keys.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/db.ts
difficulty: medium
----

# Seed the owned-block tracked set from already-durable storage at startup

## Background

`createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`) maintains **one** shared
`ownedBlocks: Set<string>` (line ~824) that both resilience monitors consume:

- **SpreadOnChurnMonitor** — on a debounced `connection:close`, re-pushes the node's owned blocks to
  expansion-cohort peers so a departing owner doesn't drop a block below its replication floor.
- **RebalanceMonitor** — tracks the blocks this node is responsible for and drives pull-gained /
  push-lost reactions.

The set is fed by exactly one subscription (`ensureOwnedBlockFeed`, line ~836) to
`storageRepo.onAnyCollectionChange`, which fires only on **new** commits and **received replicas**.
Blocks already durable on disk from a previous process run are therefore **not** in the set after a
restart until they happen to be committed or replicated again — so a freshly restarted node
under-protects exactly the data it already holds. The existing code documents this gap as acceptable
(line ~829 comment) and names this ticket as the follow-on.

This ticket closes the gap by (1) adding a "list the block ids I have durably stored" operation to
the storage backends, and (2) scanning that list at startup and adding each id to `ownedBlocks`.

## What "a durable block" means here

Every backend stores per-block state across several logical stores (metadata, revisions, pending
transforms, committed transforms, materialized blocks). The **metadata** store is the right
enumeration source:

- It is keyed **by `blockId` alone** (every other store is keyed by `blockId`+`rev` or
  `blockId`+`actionId`), so its keys are exactly the distinct block ids — no dedup pass needed.
- A metadata record (with its `latest` pointer) is written by `setLatest` on commit and by
  `saveReplica` — i.e. it exists precisely for blocks that have a **committed revision** or a
  **persisted replica**. That is the same population `onAnyCollectionChange` tracks, so the seed and
  the live feed cover the same definition of "owned".
- A block that only has a *pending* transform (pended but never committed) has **no** metadata and
  must NOT be seeded — it is not durable owned data yet. Enumerating metadata keys excludes it for
  free.

Do **not** enumerate the materialized or transactions stores (multiple rows per block → duplicate
ids; and materialized-only / pending-only rows aren't the "owned committed block" population).

## Interface change

Add an **optional** enumeration method to `IRawStorage`
(`packages/db-p2p/src/storage/i-raw-storage.ts`), following the exact precedent of the existing
optional `getApproximateBytesUsed?()` in the same interface:

```ts
/**
 * Enumerate the block ids that currently have durable state in this backend
 * (one id per block that has committed/replicated metadata). Used at node
 * startup to seed the resilience monitors' owned-block tracked set from blocks
 * already on disk from a previous run, so churn-spread / rebalance protection
 * covers them without waiting for each to be touched again.
 *
 * Streamed (AsyncIterable) so a large store does not force the whole id list
 * into memory at once. Order is unspecified. Optional: a backend that omits it
 * (or an in-memory backend with nothing durable across a restart) simply yields
 * no seed — the monitors still populate over time via the live change feed.
 */
listBlockIds?(): AsyncIterable<BlockId>;
```

**Why optional, not required:** it mirrors `getApproximateBytesUsed?()` — the one existing
enumeration-style method on this interface — and keeps blast radius to zero for test doubles that
implement `IRawStorage` (e.g. `CrashingRawStorage` in
`packages/db-p2p/test/mid-ddl-crash.spec.ts`), which need not add a method. The seed treats an absent
method as "no blocks to seed", exactly as `StorageMonitor` treats an absent `getApproximateBytesUsed`
as 0. All in-repo backends below implement it, so "optional" only ever bites external/test
implementations.

## Per-backend implementation

Each backend enumerates the **metadata** store's keys. All are single-query / single-scan and yield
`blockId` strings.

- **`MemoryRawStorage`** (`packages/db-p2p/src/storage/memory-storage.ts`) — `yield*` the keys of the
  `metadata` map. Snapshot the keys into an array first (`Array.from(this.metadata.keys())`) before
  yielding so a concurrent `saveMetadata` during the scan doesn't invalidate a live map iterator.
  Fresh in-memory storage is empty, so at real process startup this yields nothing — but
  implementing it lets the seed path be unit-tested against a pre-populated `MemoryRawStorage`
  without a disk backend.

- **`FileRawStorage`** (`packages/db-p2p-storage-fs/src/file-storage.ts`) — the block layout is
  `basePath/<blockId>/{meta.json,revs/,pend/,actions/,blocks/}` (see `getBlockPath`), so the direct
  children of `basePath` are exactly the per-block directories and the directory name **is** the
  `blockId` (used raw, no encoding). Implement `listBlockIds` as
  `fs.readdir(this.basePath, { withFileTypes: true })`, yielding `entry.name` for every entry where
  `entry.isDirectory()`. Filter to directories so a stray file can't be mistaken for a block. Handle
  a not-yet-created `basePath` the same way the existing `directoryByteSize` does: ENOENT → yield
  nothing (empty store); any other readdir error must surface (don't silently swallow, or the seed
  would falsely report an empty store). Atomic-write `*.tmp` orphans live **inside** block subdirs
  (temp = `dirname(target)/…​.tmp`), never at `basePath` root, so the root-level directory filter is
  already clean of them.

- **`SqliteRawStorage`** (`packages/db-p2p-storage-ns/src/sqlite-storage.ts`) — prepare
  `SELECT block_id FROM metadata` in the constructor's `stmts` block (alongside `listPending` etc.),
  then `await stmt.all()` and yield each `row.block_id as BlockId`, matching the existing
  drain-then-yield pattern the other `list*` methods use.

- **`LevelDBRawStorage`** (`packages/db-p2p-storage-rn/src/leveldb-storage.ts`) — metadata keys are
  `tag(TAG_METADATA=0x01) ‖ len(blockId) 4BE ‖ blockId UTF-8` with an **empty** suffix (see
  `packages/db-p2p-storage-rn/src/keys.ts`). Add a `metadataRange()` helper to `keys.ts` returning
  the `{ gte, lt }` covering the whole `TAG_METADATA` keyspace (`gte = Uint8Array.of(0x01)`,
  `lt = Uint8Array.of(0x02)` — the next tag byte; the tag bytes are deliberately spaced for exactly
  this kind of prefix scan). Also add a `blockIdFromMetadataKey(key)` decoder that reads the 4-byte
  big-endian length at offset 1 and slices `blockId` from offset 5. Implement `listBlockIds` by
  `drain(this.db.iterator({ gte, lt }))` and yielding the decoded id per key (same drained-iterator
  discipline as `listRevisions`).

- **`IndexedDBRawStorage`** (`packages/db-p2p-storage-web/src/indexeddb-storage.ts`) — the
  `metadata` object store is keyed by `blockId` (see `packages/db-p2p-storage-web/src/db.ts`). Use a
  readonly transaction on `'metadata'` and yield its keys — `this.db.getAllKeys('metadata')` (the
  `idb` handle exposes it) drained into the async iterable, or a key cursor. Keys are the `BlockId`
  strings directly.

## Startup seed wiring (`libp2p-node-base.ts`)

`rawStorage` is already in lexical scope in `createLibp2pNodeBase` (declared line ~333, and passed
directly into `new StorageMonitor(rawStorage, …)` at line ~928). **Reach the enumeration through
`rawStorage` directly — do NOT route it through `StorageRepo`.** This mirrors how `StorageMonitor`
already consumes a raw-storage-level capability (`getApproximateBytesUsed`) directly rather than via
`StorageRepo`, and keeps `StorageRepo`'s `IRepo`/`IBlockChangeNotifier` surface unchanged. (The
original plan ticket floated a `StorageRepo` pass-through; it's unnecessary — noted here so the
implementer doesn't add it.)

Place the seed **after** both monitor-wiring blocks — i.e. after the arachnode `if (enableArachnode)`
block closes (~line 1126), where both the spread block (~line 862) and the rebalance block (~line
974) have already had their chance to call `ensureOwnedBlockFeed()`. Requirements:

- **Gate on an active consumer.** Only seed when the owned-block feed is actually live — i.e. when
  `offOwnedBlockFeed` is defined (at least one monitor subscribed). If both monitors are disabled,
  `ownedBlocks` is unused and seeding is wasted work; skip it.
- **Feed-before-scan ordering (no lost-block window).** Because the seed runs after
  `ensureOwnedBlockFeed()` has already subscribed, any block committed/replicated *during* the scan
  is independently caught by the live feed. `Set.add` is idempotent, so overlap between the scan and
  the feed is harmless. Scanning *before* subscribing would drop a block committed in the gap — so
  the ordering (subscribe, then scan) is load-bearing; keep it.
- **Never block startup.** Kick the scan off as a **fire-and-forget background task** (do not `await`
  it before returning the node). Guard the promise so a rejection can't become an unhandled rejection
  (`.catch(err => log(...))`).
- **Cancellable on stop.** Register a stop wrapper (same pattern as the existing feed-teardown
  wrapper at ~line 845) that sets a `let seedStopping = false` → `true`. The scan loop checks it each
  iteration and `break`s (the `for await` then calls the iterator's `return()` to release the backend
  cursor). This prevents a scan over a huge store from running against a stopping/closing backend.
- **Yield periodically.** Since it's already fire-and-forget the event-loop pressure is low, but for
  a very large store add a cooperative yield (e.g. `await new Promise(r => setTimeout(r, 0))` every N
  ≈ 1000 ids) so a tight `Set.add` loop can't monopolize a tick.
- **Absent method → no-op.** Guard `if (typeof rawStorage.listBlockIds === 'function')` before
  scanning.

Sketch (illustrative, not prescriptive):

```ts
// --- Seed the shared owned-block set from already-durable storage ---
// Blocks durable from a previous run are otherwise untracked until next touched (see the
// onAnyCollectionChange comment above). Runs only when a monitor consumes ownedBlocks, after
// the feed is live (so a block committed mid-scan is still caught), fire-and-forget so a large
// store never blocks startup, and cancellable on stop.
if (offOwnedBlockFeed && typeof rawStorage.listBlockIds === 'function') {
  let seedStopping = false;
  const previousStop = node.stop.bind(node);
  node.stop = async () => { seedStopping = true; await previousStop(); };
  void (async () => {
    let n = 0;
    for await (const blockId of rawStorage.listBlockIds!()) {
      if (seedStopping) break;
      ownedBlocks.add(blockId);
      if (++n % 1000 === 0) await new Promise(r => setTimeout(r, 0));
    }
  })().catch(err => ((node as any).logger?.forComponent?.('db-p2p:owned-block-seed'))?.('seed failed: %o', err));
}
```

## Edge cases & interactions

- **Empty / absent store.** Fresh `MemoryRawStorage`, or a `FileRawStorage` whose `basePath` doesn't
  exist yet → `listBlockIds` yields nothing; seed is a clean no-op. (fs: ENOENT on the root readdir
  must map to empty, not throw.)
- **Pending-only block (pended, never committed).** Has no metadata record → correctly **excluded**
  from the seed. Add a test asserting a block with only `savePendingTransaction` (no commit) is not
  enumerated.
- **Both monitors disabled.** `offOwnedBlockFeed` undefined → seed skipped entirely (no wasted scan,
  no leaked background task).
- **Concurrent commit/replica during the scan.** Caught by the already-live feed; `Set.add`
  idempotent → no double-count, no loss. This is why subscribe-then-scan ordering matters.
- **Concurrent rebalance release during the scan.** The rebalance `onRebalance` handler can
  `untrackBlock` (delete from `ownedBlocks`) a confirmed-released block while the seed is still
  running; the seed could then re-add that id. This is a benign transient: the block is still in the
  metadata store (no sweep reclaims metadata yet — `gcEligible` is unconsumed), and a re-added
  released block is simply re-evaluated and re-released on the next rebalance tick. Right after a
  restart, responsibility-loss detection lags the fast metadata scan, so the window is small. Accept
  it; note it at the seed site as a `NOTE:` tripwire rather than adding synchronization.
- **Stop during the scan.** `seedStopping` flag → loop breaks, `for await` calls the iterator's
  `return()` to release the backend cursor/handle. Verify no backend's drained-array iterator leaks
  on early `break` (leveldb/sqlite/indexeddb drain first, so `return()` is a no-op there; fs uses a
  live async generator over readdir results — also fine).
- **fs stray entries.** A non-directory file at `basePath` root (shouldn't occur — all writes go
  under `basePath/<blockId>/…`) is filtered out by the `isDirectory()` check. `*.tmp` orphans live
  inside block subdirs, not at root.
- **Very large store (millions of blocks).** `ownedBlocks` already holds every owned block regardless
  of the seed, so the seed adds no memory beyond the monitors' existing footprint; the cooperative
  yield bounds event-loop impact. If a backend's enumeration query itself ever becomes a startup
  latency problem at extreme scale, that's a future concern — record as a `NOTE:` tripwire at the fs
  `readdir` / sqlite `SELECT` site, not a ticket.

## Tests

Per-backend `listBlockIds` unit tests (extend each backend's existing spec —
`packages/db-p2p-storage-{fs,ns,rn,web}/test/*.spec.ts` and a memory-storage spec):

- After committing (metadata-writing) several distinct blocks, `listBlockIds` yields **exactly** that
  id set (order-insensitive; collect to a `Set`).
- A block with only a pending transform (no metadata) is **not** yielded.
- Empty store → empty iterable. fs: non-existent `basePath` → empty (no throw).
- fs: a stray non-directory file at `basePath` root is ignored.
- leveldb: `metadataRange()` covers only `TAG_METADATA` keys — a revision/pending/transaction key for
  the same block is NOT decoded as a block id (guards the range upper bound `0x02`).

Seed-path test (in `db-p2p`, against a `MemoryRawStorage` pre-populated with block metadata, or a
small extracted helper): given N pre-existing durable blocks and at least one monitor enabled, after
`createLibp2pNodeBase` returns and the background scan settles, `ownedBlocks` (exposed via
`node.spreadOnChurnMonitor` / the shared set, or by extracting the seed loop into a testable helper
that takes `(rawStorage, ownedBlocks, isStopping)`) contains all N ids. Prefer extracting the loop
into a small pure helper so it's unit-testable without standing up a full libp2p node — expected
output: every enumerated id present in the target set, and early-stop when the `isStopping` predicate
flips.

Build + typecheck the whole affected set (`db-p2p` plus the four storage backend packages) since the
interface change ripples across all of them.

## TODO

### Phase 1 — interface + backends
- Add optional `listBlockIds?(): AsyncIterable<BlockId>` to `IRawStorage` with the doc comment above.
- Implement in `MemoryRawStorage` (snapshot `metadata.keys()`).
- Implement in `FileRawStorage` (readdir `basePath`, directories only, ENOENT→empty).
- Implement in `SqliteRawStorage` (prepared `SELECT block_id FROM metadata`, drain+yield).
- Add `metadataRange()` + `blockIdFromMetadataKey()` to `db-p2p-storage-rn/src/keys.ts`; implement in
  `LevelDBRawStorage` (drained iterator over the metadata range).
- Implement in `IndexedDBRawStorage` (`getAllKeys('metadata')` / key cursor).

### Phase 2 — startup seed
- Add the gated, fire-and-forget, cancellable seed block after the arachnode block in
  `createLibp2pNodeBase`, reading `rawStorage.listBlockIds()` directly (not via `StorageRepo`).
- Add the `seedStopping` stop wrapper and the cooperative yield.
- Add the `NOTE:` tripwires (rebalance-release race; extreme-scale enumeration latency) at the seed
  site.

### Phase 3 — tests + validation
- Per-backend `listBlockIds` unit tests (fs, ns, rn, web, memory) per the cases above.
- Seed-path test (extracted helper or MemoryRawStorage-backed node).
- Build + typecheck `db-p2p` and the four storage backend packages; run each package's test suite,
  streaming output (`… 2>&1 | tee`).
