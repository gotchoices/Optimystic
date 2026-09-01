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

### 2. Every write to a block holds that block's single write latch

A block's metadata is one blob — `{ latest, ranges }` — read and written whole.
There is no field-level write, so *any* read-modify-write of that blob rewrites
`latest` whether it meant to or not. The invariant is therefore stated over the
whole blob and over every record filed under the block, not over `latest` alone:

> A block's metadata, revision records, action transforms, pending records, and
> stored commit proofs are only ever written while holding the block's write
> latch — the key `Block.write:<blockId>`
> (`packages/db-p2p/src/storage/block-latch.ts`, `blockWriteLatchKey`).

That is ONE key per block, and it is the only one. `StorageRepo.commit` is not
the only writer: `pend` and `cancel`, the read-driven promotion in
`StorageRepo.get`, coverage restores (`restoreRevision`), replica persistence
(`saveReplicatedBlock`, e.g. churn re-replication), crash recovery (`recover`),
and the dispute module's compensating writes (`applyInvalidation`'s
`saveReplica`/`saveDeletion`) all take the same key. Sorting matters only for
`commit`, which is the one caller that holds several block latches at once: it
acquires them in sorted block-id order so two concurrent commits over
overlapping batches cannot deadlock. Every other caller holds at most one at a
time.

**Two things enforce it, one static and one checkable:**

*Statically:* every writing method on `IBlockStorage`
(`packages/db-p2p/src/storage/i-block-storage.ts`) takes a `BlockWriteLatch`
token as a required parameter — `savePendingTransaction`,
`deletePendingTransaction`, `promotePendingTransaction`, `saveRevision`,
`setLatest`, `saveMaterializedBlock`, `pruneSupersededMaterialization`,
`saveBlockProof`, `restoreRevision`, `saveReplica`, `saveDeletion`, `recover`.
The token's constructor is private to `block-latch.ts` and only
`acquireBlockWriteLatch` can mint one, so an unlatched write does not type-check
rather than merely being documented as forbidden. `BlockStorage` also checks at
runtime what the type cannot: that the token was minted for *this* block, and
that its latch has not been released yet (a callback that stashes its token and
writes after its scope closed is rejected).

*By inspection:* `block-latch.ts` is the single place that acquires the key, so

```bash
grep -rnE "Latches\.acquire\(" packages/db-p2p/src
```

must return exactly one line — the call inside `acquireBlockWriteLatch`. (The
pattern matches the call shape including its open paren, and the escapes are
what keep the prose describing the check — here and in `block-latch.ts` — from
matching itself.) A second hit means a caller has started taking the key
directly and the token discipline has a hole. The scope is `src` on purpose:
tests do acquire the key directly, to hold it against the code under test.

**The one named exclusion:** `BlockStorage.materializeBlock` re-caches a replayed
materialization at a retained revision (the `saveMaterializedBlock` after the
retention check in `packages/db-p2p/src/storage/block-storage.ts`). That runs on
the READ path, outside the latch. Content is safe because it is not a
read-modify-write of anything: the key is `(blockId, actionId)` and the value is
a deterministic replay of transforms this node already retained, so a concurrent
*save* of the same key writes identical bytes. It touches neither the metadata
blob nor any revision record, so it cannot clobber `latest`. Taking the latch
there would put a lock acquisition on every cold historical read and would
self-deadlock the commit path, which reaches `materializeBlock` through
`getBlock` while already holding the latch. Dropping the re-cache entirely stays
out of scope until someone measures the cold historical-read cost of doing
without it.

The exclusion is not free of races, only of *corrupting* ones: the racer that
does not write identical bytes is `pruneSupersededMaterialization`, which
deletes that key. Losing to it resurrects a materialization the checkpoint sweep
just removed — a bounded storage leak, never wrong content. The `NOTE:` at the
call site records that and what to do if materialization storage is ever seen to
grow under read load.

**Violate it and:** a commit's staleness guard can read `latest` before a
concurrent out-of-band writer advances it, then write the whole metadata blob
back on top — a non-monotonic regression that silently discards the out-of-band
write.

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

**Detecting a violation (partial).** A backend may optionally report
`getStoreIdentity()` — a scheme-prefixed string naming *what it is backed by*, compared
for equality only (`packages/db-p2p/src/storage/store-identity.ts`). Wrappers pass it
through, so a cache and the storage it fronts name the same store. Two storages over one
location therefore compare equal and are detectable. Two caveats bound how much this can
carry:

- **The one consumer today is the read cache's dedupe** (`withReadCache`, § 6 below):
  two storages in one process that report one identity share one cache, which closes the
  *in-process* half of this invariant for the cache. No duplicate-store guard is wired,
  and nothing addresses the cross-process half — that is still unenforced exactly as
  stated above.
- **It only ever under-approximates.** Filesystem aliases (symlinks, junctions,
  UNC-versus-mapped-drive, case-differing spellings on a case-insensitive non-Windows
  volume) and two handles opened over one database read as *two* identities, not one.
  So equality proves sameness; inequality proves nothing. A consumer may merge on
  equality, but must never treat inequality as proof that two stores are distinct.
  Each backend's `NOTE:` states its own gaps.

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
- **Restoration Support**: Integrates with external restoration callbacks, but only
  from the one explicit entry point below — reads never fetch implicitly
- **Concurrency Control**: The caller holds the block's write latch and passes the
  token; every writing method demands one (Invariant 2 above)

**Core Operations:**
- `getBlock(rev?)`: Materializes the block at a revision from LOCAL data only — it
  never consults `restoreCallback`. A revision outside `meta.ranges` raises
  `RevisionNotCoveredError` and the caller decides whether to heal.
- `restoreRevision(rev, latch)`: The one place a coverage gap is filled from a peer.
  Called by `StorageRepo.get`'s healing helper after `getBlock` reported the gap,
  under the block's write latch, which then re-reads. The commit path deliberately
  never calls it: `readCommitBase` refuses with `MissingBaseRevisionError` instead,
  because `commit` holds N block latches and must do no network I/O inside them.
- `savePendingTransaction(actionId, transform, latch)`: Stores uncommitted transactions
- `promotePendingTransaction(actionId, latch)`: Converts pending to committed transactions

### 3. Raw Storage Interface (`IRawStorage`)

The `IRawStorage` interface defines low-level storage operations, abstracting the physical storage mechanism.

**Responsibilities:**
- **Metadata Management**: Block metadata and revision tracking
- **Transaction Storage**: Both pending and committed transactions
- **Block Materialization**: Storing and retrieving materialized blocks
- **Revision Management**: Mapping revisions to transaction IDs

### 4. File-based Storage (`FileRawStorage`)

`FileRawStorage` (`packages/db-p2p-storage-fs/src/file-storage.ts:466`) is a thin
shell over the shared `KvRawStorage` kernel: it supplies a `FileStoreDriver` that
lays out the six logical stores as filesystem subdirectories, and the kernel
owns JSON (de)serialization on top. See "Shared KV Kernel" below.

### 5. Shared KV Kernel (`KvRawStorage` + `RawStoreDriver`)

`KvRawStorage` implements the full `IRawStorage` surface once, on top of a
`RawStoreDriver`. The driver exposes each backend's six logical stores
(metadata, revisions, pending, transactions, materialized, proofs) as bytes-valued maps
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
2. every writer of a block's metadata blob holds that block's single write
   latch (`Block.write:<blockId>`), and each
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

   Its *in-process* twin — two caches over one store, which diverge the same way
   two processes do — **is** enforced: `SharedCachePool.registerStore` refuses a
   second live registration for a backing store identity that already has one, so
   the bad wiring throws at construction instead of silently serving each half of
   the process its own stale view. Two escapes stay open by design (registering
   with two different pools, and backends that report no identity), and the
   cross-process case above is untouched by it; § 6 lists all of them.

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

- **Production entry point — `withReadCache(storage, label?, pool?)`**
  (`src/storage/with-read-cache.ts`). Every seam that resolves an `IRawStorage`
  for real use goes through this one helper, so the exclusion rules live in one
  place instead of being re-derived per site. It returns
  `{ storage, lease }`: `storage` is the argument *unchanged* when it is a
  `MemoryRawStorage` (already in memory — see the "never wrap" bullet below) or
  **already read-cached** (a host that attached a cache before handing it over is
  not wrapped twice), and otherwise **the one `CachedRawStorage` for that backing
  store** — constructed on the first call, and handed back again to every later
  call over the same store while any earlier caller still holds it. `lease` is
  set only in that last case — a pass-through hands back **no lease**, because the
  cache stays the host's to dispose; see **Lease obligations** below for why the
  two are separate answers.

  "Already read-cached" is a **capability the composition reports**, not a class
  the helper recognises: `IRawStorage.readCached` / `RawStoreDriver.readCached`,
  an optional property present (and only ever `true`) when a `CachedStoreDriver`
  sits at or below that object. `CachedStoreDriver` sets it unconditionally — it
  *is* the cache — and it travels up the same wire as `storeIdentity`:
  `KvRawStorage`'s constructor copies it from its driver, and
  `RawStorageDriverAdapter`'s from its inner storage. Both documented
  constructions below therefore report it, and the helper's check is
  `storage.readCached`. It used to be `storage instanceof CachedRawStorage`,
  which only the storage-level construction satisfies — so handing the helper the
  *recommended* driver-level shape made it try to attach a second cache, and the
  host's node failed to start on the pool's identity guard. The `readCached` read
  is a plain property access, which is what keeps the helper synchronous end to
  end (see the concurrency note above); do not turn it into an accessor.

  The two seams that call it:
  - `CollectionFactory.createLocalTransactor`
    (`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`)
    — wraps the host's `rawStorageFactory` result, label `quereus:local`.
  - `resolveStorage` (`src/libp2p-node-base.ts`) — wraps a `RawStorageProvider`'s
    instance or factory result, label `node:<networkName>`. The no-provider
    default is a bare `MemoryRawStorage` and stays unwrapped.

  **One cache per backing store, shared under leases.** A write-through cache
  is coherent only while every in-process writer to a store goes through the
  SAME cache; two caches over one store each serve their own stale view forever
  (measured before dedupe: peer A still read 1 row after peer B committed 3). So
  the helper keeps a module-level registry of live caches and dedupes on it. The
  registry is keyed two ways, because the two keys close different holes: by
  `getStoreIdentity()` when the backend reports one (two `FileRawStorage` over
  one directory are two objects with one identity), else by the storage object
  itself (one unwrapped instance handed to two consumers). A hit returns the
  registered cache under a fresh lease; a miss constructs and registers. On a hit
  the FIRST caller's `label` and `pool` stick — `pool.stats()` shows whoever
  wrapped first (`node:<network>` or `quereus:local`), and a second caller's
  different pool is ignored, since a same-store-different-pool pair is the very
  divergence being removed. Distinct identities, and identity-less distinct
  objects, keep independent caches. The helper is synchronous with no `await`
  between lookup and insert, so two seams resolving concurrently cannot both
  construct.

  **Lease obligations — a seam releases `lease`, never disposes `storage`.**
  "The result is read-cached" and "the result is mine to tear down" are
  different questions: the returned cache may be serving other consumers, and
  the pass-through branch returns a cache the HOST built. A seam that disposed
  on the shape of the result alone would clear and unregister the shared store the moment
  its first consumer departed — the pool keeps charging that store's entries
  while dropping its row from `stats()`, leaving live occupancy unattributable
  for the rest of the process. So each caller gets a `ReadCacheLease` and
  releases it (idempotently) when it departs; the cache is cleared, unregistered,
  and forgotten only when the LAST lease over the store releases, and a later
  wrap over that store starts cold. `CollectionFactory.dispose()` releases the
  leases it holds and is called by `shutdown()` and surfaced to hosts as
  `plugin.dispose()`; a libp2p node releases automatically, via a stop wrapper
  installed at construction that runs in a `finally` after the rest of the stop
  chain. A host-built cache — in either construction — never enters the registry
  and is never released by a seam.

  *Lifetime now spans consumers.* `plugin.dispose()` is opt-in, and `db.close()`
  does not reach it, so a host that never releases keeps the store's cache
  registered for the process — the same retention an undisposed cache already
  had, and still hygiene rather than correctness — with one visible consequence:
  a LATER `Database` over the same directory joins a **warm** cache where it
  used to start cold. That is coherent as long as every write went through the
  cache; anything that mutates the directory behind the storage's back between
  two `Database`s (a test that hand-writes files, or a transactor that writes
  through a bare `FileRawStorage`) must release every lease in between, or the
  second `Database` reads pre-tamper values.

  **The construction guards behind the dedupe.** Deduping in this helper only
  covers caches this helper built. A cache can also be constructed directly —
  `new CachedRawStorage(inner)` and `new KvRawStorage(new
  CachedStoreDriver(driver))` are both supported — so a host that hand-builds a
  cache over a directory, while a second consumer's `rawStorageFactory` returns
  a fresh storage over that same directory, still ends up with two caches: the
  helper never saw the first one. Two *different* failures live here, and they
  are caught in two places because only one of them is visible to the pool:

  - **Stacked** — a cache built over something that is *already cached*, the
    outer reading through the inner. Redundant, not incoherent: every cold miss
    pays two layers of bookkeeping and nothing is saved. Caught in
    `CachedStoreDriver`'s constructor, which checks `inner.readCached` in its
    synchronous prefix **before** touching the pool, and throws saying so.
    Ahead of registration deliberately: when the inner driver names an identity
    the pool's guard would also fire, with the (wrong, and much scarier)
    divergence message below; and when it names none the pool sees nothing at
    all, so this is the only thing that catches a stacked wrap over an
    identity-less driver. That construction used to succeed silently.
  - **Side-by-side** — two caches over one backing store, neither below the
    other. Incoherent: each is write-through, so each serves its own half of the
    process a permanently stale picture. Every cache however constructed
    registers a store with a `SharedCachePool`, and that registration is the one
    choke point all construction paths share, so it is where this is caught:
    `SharedCachePool.registerStore` takes the backing store's identity (passed by
    `CachedStoreDriver`'s constructor) and **throws** when that identity already
    has a live registration on the pool, naming both labels and the fix. Throwing
    rather than logging is the point — the failure it replaces is silent wrong
    data returned to a caller with no way to notice. The check runs before any
    mutation, so a refused registration leaves the pool untouched, and
    `unregisterStore` frees the identity, so sequential reuse of one store (stop
    a node, start another over the same directory) registers cleanly.

  **What remains of Invariant 5 for the cache.** Dedupe plus the guard close the
  in-process case only as far as identity reaches, and only within one pool.
  Still open:
  - the *cross-process* case (the filesystem driver takes no lock — the
    proper-lockfile TODO in `db-p2p-storage-fs/src/file-storage.ts` — and a
    second process's writes bypass this cache entirely). Out of scope for any
    in-process check;
  - **two different pools.** The guard's claim map lives on the pool, so two
    caches over one store registered with two different `SharedCachePool`
    instances both succeed and both diverge. Left open deliberately: closing it
    would take a process-global identity registry outliving every pool, more
    machinery than the case deserves, since passing a non-default pool is an
    explicit act (tests do it for isolation, hosts for sizing). Pinned by a test
    in `test/shared-cache-pool.spec.ts` so it reads as a decision;
  - the identity residuals (path aliases, two handles over one database — each
    backend's `NOTE:` lists its own), where two storages over one location report
    two identities, so neither the dedupe nor the guard sees a match;
  - backends that report no identity at all (memory drivers, test doubles), which
    are correctly uncovered — two memory drivers are two genuinely different
    stores.

  The first three still fail silently, the way the in-process case used to.
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
- **Either form may cross a composition seam.** A host that builds its own cache
  and hands it to `rawStorageFactory` or a `RawStorageProvider` may hand over
  *either* shape — the seam detects both via `readCached` (above), returns it
  unchanged with no lease, and the host keeps owning it. The driver-level form
  stays the recommended one whenever the driver is reachable; requiring the
  storage-level form at a seam would force exactly the hosts that *have* a driver
  into the strictly worse composition.
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
- **Range-based Restoration**: An archive arrives with the revision range it
  covers, so one fetch can close more than the revision it was pinned to
- **Explicitly triggered, never implicit**: reads do not fetch. `getBlock`
  reports a coverage gap and returns; a caller that wants it healed calls
  `restoreRevision` under the block's write latch. `StorageRepo.get` is the only
  caller that does — the commit path refuses instead (Invariant 2)

### 5. Concurrency Control

One write latch per block, described in full under Invariant 2 above:

- **Block-level Locking**: `Block.write:<blockId>` — the single key guarding every
  write to a block, minted and acquired only by `block-latch.ts`
- **Token-passing**: Writing methods take a `BlockWriteLatch`, so an unlatched write
  does not type-check
- **Ordered Locking**: `StorageRepo.commit` is the only caller holding several block
  latches at once and acquires them in sorted block-id order, so two commits over
  overlapping batches cannot deadlock
- **No I/O under the latch on the commit path**: a base the node cannot materialize
  locally is refused, not fetched

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
