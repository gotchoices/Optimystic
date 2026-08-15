# Optimystic DB-P2P Storage System

The storage system in the `db-p2p` package provides a sophisticated, versioned block storage layer that supports distributed operations, transaction management, and efficient file-based persistence. This document describes the architecture, components, and usage patterns of this storage system.

## Architecture Overview

The storage system follows a layered architecture:

```
StorageRepo (High-level repository operations)
    ↓
BlockStorage (Block-level operations with versioning)
    ↓
IRawStorage (Low-level storage interface)
    ↓
KvRawStorage (shared kernel) → RawStoreDriver (per-backend bytes layer)
```

`IRawStorage` can in principle be implemented directly — nothing enforces
routing through the kernel, and a test double (`CrashingRawStorage` in
`db-p2p/test/mid-ddl-crash.spec.ts`) does exactly that — but every shipping
backend today reuses the shared `KvRawStorage` kernel over a small
`RawStoreDriver` that only speaks bytes: `MemoryRawStorage`, `FileRawStorage`,
`IndexedDBRawStorage`, `LevelDBRawStorage`, and `SqliteRawStorage` all `extends
KvRawStorage`, each supplying only a driver for its native mechanism. The
migration from direct implementation onto drivers (mentioned in older revisions
of this doc) is complete.

## Invariants

These five properties are what make it safe to build another layer (e.g. a
cache) over `IRawStorage`. Each entry states the rule, where it's enforced, and
what breaks if it's violated.

### 1. Every write to a store goes through `IRawStorage`

Nothing mutates a backend's bytes behind the interface. `KvRawStorage`'s save
methods are, in the kernel's own words, "the single choke point" for every
value write (`packages/db-p2p/src/storage/kv-raw-storage.ts:47-56`):

> every value write funnels through the driver put/delete calls in the methods
> below (saveMetadata / saveRevision / save*Transaction / saveMaterializedBlock).
> This is the single choke point where an incremental byte counter would hook in…

**Scope:** this holds only for writes issued *in this process*. It is not a
guarantee against mutation from outside the process — that boundary is
Invariant 5 below.

**Violate it and:** any in-process reader that assumes it has seen every write —
a cache, or the byte-counter this seam was deliberately left open for — silently
serves stale data, because a write that bypassed `IRawStorage` never touched the
seam.

### 2. Every out-of-band writer of a block's `meta.latest` serializes on the per-block commit latch

`StorageRepo.commit` is not the only path that read-modify-writes a block's
`meta.latest`. Replica persistence (`saveReplicatedBlock`, e.g. churn
re-replication) and the dispute module's compensating writes
(`applyInvalidation`'s `saveReplica`/`saveDeletion`) do too, and all three must
hold the same key (`packages/db-p2p/src/storage/storage-repo.ts:21-27`,
`commitLatchKey`):

> Every out-of-band writer of a block's `meta.latest` must serialize on this key
> against a concurrent local commit on the same block; keeping all call sites on
> this helper is what prevents the key from drifting between them.

Skipping the latch is invisible to the check it protects
(`storage-repo.ts:29-46`, `withBlockCommitLatch`):

> otherwise an invalidation advancing `latest` outside that latch is invisible
> to commit's staleness guard and can be clobbered (a non-monotonic regression)

**Known deliberate exception:** the invalidation-apply path
(`packages/db-p2p/src/dispute/invalidation.ts:481-490`,
`InvalidationContext.withBlockCommitLatch`) and its cascade-child counterpart
(`packages/db-p2p/src/dispute/cascade.ts:43-49`,
`CollectionEnv.withBlockCommitLatch`) both take the latch runner as *optional*.
When a host doesn't supply one — unit tests, or a non-`StorageRepo` host — the
compensating write runs unlatched. That's accepted specifically because such a
host has no concurrent `StorageRepo.commit` to race against; a `StorageRepo`-
backed host always supplies the runner.

**Violate it and:** a commit's staleness guard can read `latest` before a
concurrent out-of-band writer advances it, then write its own value back on top —
a non-monotonic regression that silently discards the out-of-band write.

### 3. Committed revisions are append-only; `latest` never advances past a materializable revision

Documented well already — see `docs/correctness.md` §6.3 "Ordering Guarantees"
(revision monotonicity within a collection) and `docs/internals.md`'s "Key
Invariants" section, bullets `rev` and "`latest` never advances past a revision
the node can materialize". Enforced by `StorageRepo.internalCommit`'s
missing-base refusal (`refuseMissingBase` / `MissingBaseRevisionError` in
`packages/db-p2p/src/storage/storage-repo.ts`).

### 4. `promotePendingTransaction` is a cross-store atomic *move*, not a copy

Documented well already — see "Shared KV Kernel" below (this file) and
"Invariant P" on `IBlockStorage.promotePendingTransaction`
(`packages/db-p2p/src/storage/i-block-storage.ts`) — "a pending record and a
committed record never coexist for one action". Enforced differently per backend: each
persistent `RawStoreDriver.promote` implementation uses its own native atomic
primitive (filesystem rename, LevelDB/SQLite batch or DB transaction, an
IndexedDB readwrite transaction) — never a two-step copy-then-delete, since a
crash between the two steps would leave a pending and a committed record
coexisting for the same action. `MemoryStoreDriver.promote` is the one exception
in form, not in effect: it does move the value map-to-map, but with no `await`
between the two map operations and no durability to survive a crash, so no
observer can see both records.

### 5. A store is owned by exactly one process

No two processes may point an `IRawStorage` (or a `RawStoreDriver`) at the same
underlying path/keyspace at the same time. This is **not enforced anywhere in
code today** — it holds only because every current deployment happens to wire
one store per node (and, in the Sereus fabric layered over Optimystic, one store
per trust domain besides), so nothing shares a directory in practice. Nothing
stops a future host from embedding two nodes over one path.

**Violate it and:** Invariant 1 breaks silently. A second process writing to the
same backend produces writes that never funnel through the first process's
`IRawStorage`, so any in-process cache the first process keeps — including one
built over this document's other four invariants — serves stale data, potentially
into a consensus decision.

**For embedders:** wire exactly one `IRawStorage` instance (one
path/keyspace) per process. Two nodes hosted in the same process must each point
at a distinct path/keyspace; never construct two stores over the same underlying
location, even transiently.

## Core Components

### 1. Storage Repository (`StorageRepo`)

The `StorageRepo` class provides the main interface for database operations, implementing the `IRepo` interface from `@optimystic/db-core`. It orchestrates block-level operations and handles distributed consistency.

**Key Features:**
- **Transaction Management**: Handles pending, committing, and cancelling transactions
- **Conflict Resolution**: Manages revision conflicts and missing transaction detection
- **Distributed Coordination**: Supports distributed commits with proper locking
- **Context-aware Operations**: Handles operation contexts for consistent reads

**Primary Operations:**
- `get()`: Retrieves blocks with optional transaction context
- `pend()`: Creates pending transactions with conflict detection
- `commit()`: Atomically commits transactions across multiple blocks
- `cancel()`: Cancels pending transactions

### 2. Block Storage (`BlockStorage`)

The `BlockStorage` class manages individual block operations, providing versioning, materialization, and transaction lifecycle management.

**Key Features:**
- **Version Management**: Tracks block revisions and ensures availability
- **Block Materialization**: Reconstructs blocks by applying transforms
- **Transaction Lifecycle**: Manages pending → committed transaction flow
- **Restoration Support**: Integrates with external restoration callbacks
- **Concurrency Control**: Uses latches for thread-safe operations

**Core Operations:**
- `getBlock()`: Retrieves and materializes blocks at specific revisions
- `savePendingTransaction()`: Stores uncommitted transactions
- `promotePendingTransaction()`: Converts pending to committed transactions
- `ensureRevision()`: Ensures revision availability through restoration

### 3. Raw Storage Interface (`IRawStorage`)

The `IRawStorage` interface defines low-level storage operations, abstracting the physical storage mechanism.

**Responsibilities:**
- **Metadata Management**: Block metadata and revision tracking
- **Transaction Storage**: Both pending and committed transactions
- **Block Materialization**: Storing and retrieving materialized blocks
- **Revision Management**: Mapping revisions to transaction IDs

### 4. File-based Storage (`FileRawStorage`)

`FileRawStorage` (`packages/db-p2p-storage-fs/src/file-storage.ts:411`) is a thin
shell over the shared `KvRawStorage` kernel: it supplies a `FileStoreDriver` that
lays out the five logical stores as filesystem subdirectories, and the kernel
owns JSON (de)serialization on top. See "Shared KV Kernel" below.

### 5. Shared KV Kernel (`KvRawStorage` + `RawStoreDriver`)

`KvRawStorage` implements the full `IRawStorage` surface once, on top of a
`RawStoreDriver`. The driver exposes each backend's five logical stores
(metadata, revisions, pending, transactions, materialized) as bytes-valued maps
over its native mechanism; the kernel owns all value (de)serialization (JSON via
`raw-store-codec.ts`) and call orchestration. Backends therefore never
(de)serialize values — they only lay out keys and move bytes.

Because values cross the driver boundary as `Uint8Array` (JSON-encode on save,
JSON-decode on read), every save stores an independent byte snapshot and every
read yields a fresh object *by construction*. The `structuredClone`-on-every-get/put
discipline the old in-memory backend needed is now structural, not a rule — see
docs/internals.md "Storage Returns References". `promote` (pending → committed) is
the only cross-key atomic operation the kernel requires; each backend satisfies it
with its native atomic primitive (batch / DB transaction / rename).

Every shipping backend uses this kernel today: in-memory (`MemoryStoreDriver`),
filesystem (`FileStoreDriver`), IndexedDB, LevelDB, and SQLite each supply only a
driver. A shared conformance suite (`src/testing/raw-storage-conformance.ts`,
exported from the `./testing/conformance` entry — separate from `./testing` because
it imports `chai`, which is a devDependency consumers never install) asserts every
backend behaves identically against the shared kernel contract.

**File System Structure:**
```
{basePath}/
├── {blockId}/
│   ├── meta.json           # Block metadata
│   ├── revs/
│   │   ├── {rev}.json      # Revision → ActionId mapping
│   │   └── ...
│   ├── pend/
│   │   ├── {actionId}.json # Pending actions
│   │   └── ...
│   ├── actions/
│   │   ├── {actionId}.json # Committed actions
│   │   └── ...
│   └── blocks/
│       ├── {actionId}.json # Materialized blocks
│       └── ...
└── ...
```

### 6. Write-through raw-storage cache (`CachedStoreDriver` + `CachedRawStorage`)

`CachedStoreDriver` wraps any `RawStoreDriver` with an in-memory, **write-through
coherent** cache at the bytes layer. Every save stores its encoded value *into*
the cache as it writes the inner driver — it never invalidates — so after one
cold read per key the cache always holds the last durable value and reads stop
touching the backend for the life of the process. This is what a plain
invalidate-on-write memo cannot do at this seam: the hot reads exist to observe
the writes, so invalidation lands between nearly every read pair (measured: only
a 23% cut, vs ~96% for write-through on the same cold-start workload — see
`test/cached-raw-storage.spec.ts`).

Its soundness rests entirely on the five **Invariants** above:

1. every backend write funnels through `IRawStorage` in-process, so the cache
   sees every mutation (Invariant 1);
2. every writer of `meta.latest` holds the per-block commit latch, and each
   cache update is synchronous with its inner write (no `await` between the
   inner call resolving and the cache mutation), so a latch-protected
   read-after-write sees the new value exactly as a driver read would
   (Invariant 2);
3. committed revisions and materializations are append-only (Invariant 3);
4. `promote` is mirrored as one synchronous cache mutation after the driver's
   atomic move — and when the pending bytes were never cached, the committed
   entry is *invalidated*, never synthesized, preserving Invariant 4 / Invariant
   P's no-phantom-record guarantee;
5. **one process owns the store** (Invariant 5). This is the cache's one
   correctness cliff: a second process writing the same backend bypasses the
   funnel and makes cached values stale in ways that feed consensus decisions.
   It is not enforced in code (see Invariant 5's embedder note).

Semantics worth knowing:

- **Never write-behind.** No write is deferred, reordered, or coalesced; the
  commit path's crash-recovery write ordering is untouched.
- **Proven absence is cached.** A confirmed inner miss or a funnelled delete is
  stored as a negative and served without re-consulting the backend; "provably
  absent" never degrades into "could not confirm". Repeated probes of
  not-yet-created blocks are a real cold-start pattern.
- **Lists are served only when provably complete.** `listPendingTransactions`
  needs one full enumeration to seed completeness (funnelled writes maintain it
  after); `listRevisions` tracks covered rev intervals from enumerations and
  written points. A write or `clear()` landing mid-enumeration vetoes the
  completeness claim (generation guard) rather than freezing a stale set.
- **Always clean, never dirty.** Nothing is pinned; `clear()` (or a pool
  eviction) is correct at any instant and purely a performance question. If a
  change ever seems to need a dirty or pinned entry, the design has gone wrong.
  Correct "at any instant" includes *during* an in-flight inner read: every
  read-miss fill checks that the cache state it started on is still the live one,
  so a read that overlaps a write and a `clear()` declines to cache its own
  now-superseded snapshot rather than reinstalling it past the clear.
- **Bounded by one shared pool per process** (`SharedCachePool`,
  `src/storage/shared-cache-pool.ts`). Every `CachedStoreDriver` joins the
  process-wide `defaultCachePool()` unless handed a specific pool, so N
  workspaces' caches compete inside ONE memory budget instead of each sizing
  itself as if it were alone. The pool owns residency and eviction only; all
  coherence semantics above stay in the driver — which is why eviction of any
  entry at any instant is safe (see "always clean" above).
  - **Keying**: `(storeId, class, key…)`. The store id leads because block ids
    alone are NOT globally unique — header block ids are name-derived, so two
    stores running the same schema collide. Store ids are monotonic and never
    reused.
  - **Budget rails**: a byte budget (`maxBytes`) plus an entry-count rail
    (`maxEntries`, default `max(16, maxBytes/512)`) guarding the
    many-tiny-entries case. Every entry charges a fixed base (~256 bytes + key)
    on top of its content, so cached negatives and empty bookkeeping are never
    free — a remote peer streaming probes for nonexistent blocks churns the
    probation queue instead of growing memory. At the bound the pool always
    evicts, never refuses: entries are never pinned or dirty, so there is no
    exhaustion condition.
  - **2Q admission** (Johnson & Shasha): a first-touch entry enters the A1in
    probation FIFO; re-hits inside A1in do NOT
    promote (this also absorbs the several correlated touches one logical
    operation makes); A1in eviction demotes the key to the A1out ghost set
    (capped at half the entry budget); a later admission of a ghosted key —
    reuse across operations — goes straight to the protected Am LRU; Am
    evictions never ghost. Net effect, measured in
    `test/shared-cache-pool.spec.ts`: a 3000-block one-off bulk scan lives and
    dies inside probation and displaces ZERO of another store's re-used hot
    set, where a plain shared LRU loses all of it.
    Probation is given ~25% of **each** rail — a quarter of the bytes and a
    quarter of the entries — and the pool takes its victim from A1in whenever
    probation is over *either* share. Both are needed: entries small enough
    that the entry count binds first (cached negatives are near-empty) leave
    A1in permanently under its byte share, so a byte-only test would send every
    eviction to Am and a one-pass scan would flush the protected set — 2Q
    degraded to plain LRU. Note the share picks the victim's queue; it is not a
    cap, so A1in still occupies whatever Am leaves over.
  - **Large-value bypass**: an entry whose charge exceeds 1/16 of the byte
    budget is not cached at all (reads/writes pass through), so one oversized
    value cannot flush the pool. This gates *admission* of a value, not the
    later growth of a resident container entry — see the `NOTE:` on
    `SharedCachePool.updated` for when that distinction starts to matter.
  - **Budget**: platform defaults are honest guesses — 8 MB React Native,
    16 MB browser, 32 MB Node — and hosts with better knowledge should size
    explicitly: `defaultCachePool().setBudget({ maxBytes })` (shrinking evicts
    down immediately), or pass their own `SharedCachePool` to each cache.
    Absurdly small budgets are accepted: they cannot break coherence, they
    just degrade toward read-through (the conformance suite runs the full
    contract at 2 KB to prove it).
  - **Ghost memory**: ghost keys live outside the byte budget, bounded by
    their own cap (half the entry budget) — order ~2 MB worst-case at the
    default Node budget, proportionally less at smaller ones.
  - **Observability**: `pool.stats()` reports budget, per-queue bytes/entries,
    ghost count, hit/admission/ghost-hit/eviction/bypass counters, and
    per-store occupancy; `CachedStoreDriver.storeStats()` gives one store's
    slice.
  - **Lifecycle**: `CachedStoreDriver.close()` (and
    `CachedRawStorage.dispose()`) drops the store's entries and ghosts and
    retires its pool registration; `clear()` drops entries AND this store's
    ghost keys, so pre-clear recency cannot fast-track post-clear refills into
    the protected queue. A skipped close leaks only cold entries the pool
    evicts under pressure.

**Wiring:**

- Backend exposes its `RawStoreDriver` (all kernel-backed backends):
  `new KvRawStorage(new CachedStoreDriver(driver))`. Optional second/third
  constructor args pick a specific `SharedCachePool` (default: the shared
  process pool) and a `label` that names the store in `pool.stats()`.
- Only the `IRawStorage` surface is reachable:
  `new CachedRawStorage(inner)` — same cache over an internal
  `RawStorageDriverAdapter`, at the cost of one extra codec pass per **cold
  miss** (hits never reach the adapter); same optional `pool`/`label` args.
  `clearCache()` drops every entry; `dispose()` releases the pool
  registration when the workspace departs.
- **Never wrap `MemoryRawStorage`/`MemoryStoreDriver`** in production wiring:
  the memory driver already holds the same byte references, so the cache is
  pure bookkeeping overhead (tests do wrap it, to prove semantics match).

## Data Structures

### Block Metadata
```typescript
export type BlockMetadata = {
  ranges: RevisionRange[];    // Available revision ranges
  latest?: ActionRev;         // Latest revision info
};
```

### Revision Ranges
```typescript
export type RevisionRange = [
  startRev: number,          // Inclusive start
  endRev?: number           // Exclusive end (undefined = open)
];
```

### Block Archive
```typescript
export type BlockArchive = {
  blockId: BlockId;
  revisions: ArchiveRevisions;
  range: RevisionRange;
  pending?: Record<ActionId, ActionTransforms>;
};
```

## Key Features

### 1. Versioned Storage

The system maintains complete revision history for blocks:

- **Revision Tracking**: Each block change gets a unique revision number
- **Transform Storage**: Stores the actual changes (transforms) rather than full snapshots
- **Materialization**: Reconstructs blocks by applying transforms to base versions
- **Sparse Revisions**: Efficiently handles missing revisions through restoration

### 2. Transaction Management

Supports a two-phase transaction model:

1. **Pending Phase**: Transactions are stored as pending with conflict detection
2. **Commit Phase**: Atomic promotion of pending transactions to committed state

**Transaction Lifecycle:**
```
[Create] → [Pend] → [Commit] → [Materialized]
     ↓         ↓         ↓
   [Cancel] [Cancel] [Permanent]
```

### 3. Conflict Resolution

The system provides sophisticated conflict detection and resolution:

- **Revision Conflicts**: Detects when operations target stale revisions
- **Pending Conflicts**: Handles concurrent pending transactions
- **Policy-based Handling**: Supports different conflict resolution policies

### 4. Restoration System

Supports external restoration for missing data:

- **Restore Callbacks**: Pluggable restoration mechanism
- **Range-based Restoration**: Restores entire revision ranges
- **Lazy Loading**: Restores data only when needed

### 5. Concurrency Control

Implements proper locking mechanisms:

- **Block-level Locking**: Prevents concurrent modifications to the same block
- **Ordered Locking**: Prevents deadlocks through consistent lock ordering
- **Atomic Operations**: Ensures consistency during complex operations

## Usage Examples

### Basic Block Operations

```typescript
// Create a storage repository
const repo = new StorageRepo(blockId => 
  new BlockStorage(blockId, rawStorage, restoreCallback)
);

// Get blocks with context
const result = await repo.get({
  blockIds: ['block1', 'block2'],
  context: { rev: 10, actionId: 'action123' }
});

// Create pending action
const pendResult = await repo.pend({
  actionId: 'action124',
  transforms: { /* ... */ },
  rev: 11,
  policy: 'w'  // Wait for pending actions
});

// Commit action
const commitResult = await repo.commit({
  actionId: 'action124',
  blockIds: ['block1', 'block2'],
  rev: 11
});
```

### File Storage Setup

```typescript
// Create file-based storage
const fileStorage = new FileRawStorage('/path/to/storage');

// Create block storage with restoration
const blockStorage = new BlockStorage(
  'block123',
  fileStorage,
  async (blockId, rev) => {
    // Restore block from network or backup
    return await restoreFromNetwork(blockId, rev);
  }
);
```

## Performance Considerations

### 1. Materialization Strategy

- **Selective Materialization**: Only materializes blocks when needed
- **Cached Materialization**: Stores materialized blocks to avoid recomputation
- **Incremental Updates**: Applies minimal transforms for efficiency

### 2. File System Optimization

- **Directory Structure**: Organizes files for efficient access
- **JSON Serialization**: Uses JSON for cross-platform compatibility
- **Atomic Operations**: Uses file system atomicity for consistency

### 3. Memory Management

- **Lazy Loading**: Loads data only when accessed
- **Snapshot-on-Store/Read**: Callers never share mutable references with the store. A backend that keeps live object references must deep-clone on get and put; a kernel-backed backend gets this for free from the `Uint8Array` codec boundary (see the shared KV kernel above)
- **Resource Cleanup**: Properly manages file handles and locks

## Error Handling

The system provides comprehensive error handling:

- **Missing Data**: Graceful handling of missing blocks and transactions
- **Corruption Detection**: Validates data integrity during operations
- **Partial Failures**: Handles partial commit failures with proper rollback
- **Network Errors**: Integrates with restoration mechanisms for network issues

## Integration with Optimystic Core

The storage system integrates seamlessly with the core Optimystic components:

- **Block System**: Uses core block types and operations
- **Transform System**: Stores and applies transforms from core
- **Transaction System**: Implements core transaction interfaces
- **Network Layer**: Supports distributed operations through restoration

## Security Considerations

- **File System Access**: Requires appropriate file system permissions
- **Data Integrity**: Validates data consistency during operations
- **Atomic Operations**: Ensures no partial writes leave corrupted state
- **Locking**: Prevents concurrent access corruption

## Future Enhancements

- **Compression**: Add compression for stored blocks and transactions
- **Encryption**: Support for encrypted storage
- **Backup Integration**: Built-in backup and restore mechanisms
- **Monitoring**: Performance and health monitoring capabilities
- **Sharding**: Support for horizontal scaling across multiple storage backends

## Conclusion

The db-p2p storage system provides a robust, scalable foundation for distributed database operations. Its layered architecture, comprehensive transaction support, and efficient file-based implementation make it suitable for production deployment while maintaining the flexibility needed for distributed peer-to-peer operations.

The system's design prioritizes:
- **Consistency**: Strong consistency guarantees across distributed operations
- **Performance**: Efficient storage and retrieval mechanisms
- **Reliability**: Comprehensive error handling and recovery
- **Extensibility**: Clean interfaces for custom storage backends
- **Maintainability**: Clear separation of concerns and well-documented APIs 
