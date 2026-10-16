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
KvRawStorage`, each supplying only a driver for its native mechanism — or, for the
backends that take their writes a group at a time, a `BatchBackend` or a `JournalStore`
under the shared `WriteGroupDriver` (Invariant 6 below). The
migration from direct implementation onto drivers (mentioned in older revisions
of this doc) is complete.

## Invariants

These six properties are what make it safe to build another layer (e.g. a
cache) over `IRawStorage`. Each entry states the rule, where it's enforced, and
what breaks if it's violated.

### 1. Every write to a store goes through `IRawStorage`

Nothing mutates a backend's bytes behind the interface. `KvRawStorage`'s save
methods are the one place every value write funnels through — the
"single choke point" comment in `packages/db-p2p/src/storage/kv-raw-storage.ts`:

> every value write funnels through the driver put/delete calls in the methods
> below (saveMetadata / saveRevision / save*Transaction / saveBlockProof /
> saveMaterializedBlock). This is the single choke point where an incremental
> byte counter would hook in…

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

The same refusal enforces a second, distinct rule: **an update-only transform is
applied only to the base its author read.** A member holding a base other than
the one the record's pend carried for the block (`PendRequest.baseRevs`, kept
as `BlockMetadata.pendingBases`) — or, for a record whose pend named none, the
`baseRev` the writer declared in `CommitRequest.blockDigests` — refuses, rather
than applying the edits to different bytes and recording the result under the
new revision number; and the read-driven promotion in `StorageRepo.get` declines
to apply a record whose stored base is not the revision it holds. Revision
arithmetic cannot substitute for the author's word — a per-block gap under a
collection-wide revision counter is routine, not a fault. See `docs/internals.md`
"An update-only transform is applied only to the base its author read" for the
full rule and the one arm (a sender that names no base anywhere) left open by
choice.

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
underlying path/keyspace at the same time. The filesystem backend enforces it on
one machine: its `store.lock` refuses a second live process on the same host (see
*The file backend* under Invariant 6). **No other backend enforces it** — there it
holds only because every current deployment happens to wire one store per node
(and, in the Sereus fabric layered over Optimystic, one store per trust domain
besides), so nothing shares a keyspace in practice. Nothing stops a future host
from embedding two nodes over one path.

**Violate it and:** Invariant 1 breaks silently. A second process writing to the
same backend produces writes that never funnel through the first process's
`IRawStorage`, so any in-process cache the first process keeps — including one
built over this document's other invariants — serves stale data, potentially
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

### 6. A write survives a crash once a `flush()` called after it has resolved

Every `RawStoreDriver` and every `IRawStorage` has a `flush(options?)`, a `whenDurable()` and
a `durability`. The durability (`StoreDurability` in
`packages/db-p2p/src/storage/store-durability.ts`) names which crashes a flushed write
survives: `'none'` (nothing survives a restart), `'process-crash'` (this process crashing, but
not an operating-system crash or power cut) or `'power-loss'` (a power cut or operating-system
crash too). It is fixed when the store is constructed and never changes. A flush may be given
`withinMs` (`FlushOptions` in `packages/db-p2p/src/storage/store-durability.ts`): how long after
the call the writes it covers may stay exposed to a crash the durability names — the caller
trading a bounded window of exposure for a sync that waits. Absent or 0, the flush is *strict*
and resolves only once the writes survive, which is what every caller asks except a node
applying a write its cohort agreed to (see *Who calls `flush()`* below); otherwise it is
*relaxed*. `whenDurable()` resolves once every write covered by a flush that resolved before
the call survives every crash the durability names, and never hastens a sync. All three members
are required, so a wrapper that forgets to forward one does not compile. `IKVStore` has an
optional `flush` instead, because hosts implement that interface outside this repository; absent
means every write is already as durable as it will ever be when it resolves.

The contract, stated in full on `RawStoreDriver.flush` in
`packages/db-p2p/src/storage/raw-store-driver.ts`:

1. A write method resolves once its effect is visible to every later read in this process.
2. Once a `flush()` called after the write resolved has itself resolved, the write survives a
   crash of this process where `durability` names one; it survives every crash `durability`
   names once `withinMs` has passed since that flush was called (at once, for 0 or absent), or
   once a `whenDurable()` called after the flush resolved has itself resolved.
3. **What survives any crash is a prefix of the resolved writes, in the order they
   resolved.** No write survives while one that resolved before it is lost. A deferred sync is
   exactly when a power cut can take a suffix, so a caller that allows one relies on this rule.
4. A `flush()` covers every write resolved before it was called, including writes made by
   other callers; concurrent flushes may share one sync. A flush with `withinMs` 0 covers every
   earlier deferred write too, so it hastens their sync.
5. A rejected `flush()` is a storage fault. After one, the store rejects every later write
   and flush until it is reopened, because a retried sync can report success for data the
   operating system already dropped. A deferred sync that fails latches the store the same
   way, is logged, and is reported by the next write, flush or `whenDurable()`.

Rule 3 is what keeps the crash-recovery reasoning in `BlockStorage` and `StorageRepo` valid
once a backend stops syncing each write on its own. Rules 4 and 5 bind a store whose flush
does real work: `WriteGroupDriver`, whose flush is the sync, and the file and NativeScript
SQLite backends built on it (see *Writes that wait in memory* below); every other backend
satisfies them trivially, and every store that cannot defer a sync treats `withinMs` as 0 and
resolves `whenDurable()` at once. Only `WriteGroupDriver` honours `withinMs`, and only over a
backend that defers its sync: today the file backend, the NativeScript SQLite backend, and the
journal backend (*The journal backend* below) over the browser store — and over the React Native
store once it lands on it:

| Driver | What a write waits for today | What `flush()` does | `withinMs` | `durability` |
|---|---|---|---|---|
| `MemoryStoreDriver` | the in-memory map update | nothing | ignored | `'none'` |
| `WriteGroupDriver` (`packages/db-p2p/src/storage/write-group-driver.ts`) | nothing: it is recorded in memory and served from there | seals the group and hands it to the backend's `commit`; a strict flush resolves when the batch is durable, a relaxed one when it is committed | the time left to the earliest deadline of the flushes sharing the seal is passed to the backend's `commit` as `syncWithinMs`; honoured only as far as the backend defers | the backend's |
| `FileBatchBackend` (`packages/db-p2p-storage-fs/src/file-batch-backend.ts`), under `WriteGroupDriver` | nothing: it is recorded in memory and served from there | an append to the write-ahead log; a strict flush syncs it before resolving, a relaxed one resolves at once and the log syncs by the earliest deadline among the batches waiting; the tree is written after the sync | honoured: one sync covers every batch appended since the last, made by the earliest deadline, or sooner by a strict flush, a checkpoint, or a commit that finds a deadline already passed | `'power-loss'` |
| `JournalBatchBackend` (`packages/db-p2p/src/storage/journal-batch-backend.ts`), under `WriteGroupDriver`, over a `JournalStore` the engine implements | nothing: it is recorded in memory and served from there | over a store that can sync: a strict flush is one synced apply of every journal record held plus the group itself; a relaxed one appends the group as one unsynced journal record and resolves, and the held records are applied in one synced apply by the earliest deadline among them. Over a store that cannot sync: one atomic apply per group, never journaled | honoured over a store that can sync: one apply covers every record appended since the last, made by the earliest deadline, or sooner by a strict flush or a commit that finds a deadline already passed; ignored over one that cannot | the store's: `'power-loss'` when it can sync an apply, else what the engine gives |
| `LevelDBStoreDriver` (`packages/db-p2p-storage-rn/src/leveldb-storage.ts`) | LevelDB accepting it under default write options, which do not sync | nothing | ignored | `'process-crash'` |
| `IndexedDBJournalStore` (`packages/db-p2p-storage-web/src/indexeddb-storage.ts`), under `JournalBatchBackend` under `WriteGroupDriver` | nothing: it is recorded in memory and served from there | where the browser honours `durability: 'strict'` (every current release): as the journal backend's row, an append being one relaxed `readwrite` transaction on the `journal` object store and an apply one strict transaction over the six data stores and the journal, which completes only once the browser has put it on the disk. Where it does not: one relaxed transaction per group, never journaled | honoured where the browser honours strict transactions, as the journal backend's row; ignored where it does not | `'power-loss'` where the browser honours strict transactions, else `'process-crash'` |
| `SqliteBatchBackend` (`packages/db-p2p-storage-ns/src/sqlite-storage.ts`), under `WriteGroupDriver` | nothing: it is recorded in memory and served from there | one SQLite transaction applying the batch, committed in write-ahead-log mode (`applySchema` in `packages/db-p2p-storage-ns/src/db.ts`); a strict flush commits it under `synchronous = FULL`, which syncs the log before the flush resolves, a relaxed one under `NORMAL`, and the log syncs by the earliest deadline among the batches waiting | honoured: one `FULL` commit — a strict batch's own, or the one-row commit the timer makes — covers every batch committed since the last sync, made by the earliest deadline, or sooner by a strict flush or a commit that finds a deadline already passed | `'power-loss'` |

The wrappers — `CachedStoreDriver`, `RawStorageDriverAdapter`, and `KvRawStorage` with every
storage class built on it — report the durability of what they wrap, flush by flushing it with
the same options, and answer `whenDurable()` with the wrapped store's. The cache is
write-through and holds no dirty state, so flushing it is flushing the driver underneath.

**Writes that wait in memory.** `WriteGroupDriver` in
`packages/db-p2p/src/storage/write-group-driver.ts` is a `RawStoreDriver` over a `BatchBackend`
(`packages/db-p2p/src/storage/batch-backend.ts`): a backend with reads, listings and one write,
`commit`, which applies a whole batch atomically and as durably as its `durability` says. Over
this driver every write of every store — metadata, revisions, pending, transactions, proofs,
materialized, and the two entries a promote records — resolves at once, recorded in an
in-memory overlay that point reads consult first and listings merge over the backend's rows.
`flush()` seals the writes recorded so far into one batch and hands it to the backend's
`commit`, which resolves once the batch is applied and survives a crash of this process and
hands back a `durable` promise (`CommittedBatch` in `packages/db-p2p/src/storage/write-group.ts`)
that settles once it survives every crash the durability names. A strict flush resolves on
`durable`, a relaxed one on the commit. Every flush that shares one seal contributes its
deadline, and the batch is committed with `syncWithinMs` the time left to the earliest of them,
so a backend may defer the sync of a batch every flush of which allowed it; a strict flush with
nothing to seal has the backend `sync()` whatever is committed and not yet durable, and a relaxed
one with nothing to seal does the same in the background when its deadline is sooner than those
batches were given, since rule 2 binds them to it and the backend cannot be told a sooner
deadline after the commit. Batches
commit one at a time, in sequence, and their `durable` settle in commit order (rule 3); a flush
arriving while a commit is in flight waits for it and then shares the next commit with every
other flush that arrived meanwhile (rule 4); and a rejected commit — or a rejected sync no
caller is waiting on, a deferred one or the hasten behind a relaxed flush, which is logged once
on `optimystic:db-p2p:write-group:error` — latches the driver failed, after which every write, flush and `whenDurable()`
throws `StoreFailedError` (rule 5) while reads keep serving the overlay. An overlay entry stays
until its batch is durable, not merely committed, so a write a crash could still take back is
never read from the backend alone; the overlay is bounded by `maxUnsyncedBytes`
(`WriteGroupOptions` in `packages/db-p2p/src/storage/write-group.ts`, 64 MiB by default): a seal
that would leave more than that not yet durable is committed with `syncWithinMs` 0 whatever its
flushes asked. `whenDurable()` is the `durable` of the latest committed batch. The key-agnostic
part — overlay, open batch, commit chain, deadlines, failure latch and idle timer — is
`WriteGroup` in the same file, which `FileKVStore` also uses over string keys and which exposes
`whenDurable()` there too. A write that no group flushes is flushed, strictly, by the driver's
own idle timer, `idleFlushMs` (default one second) after the first write of an open batch.
`IRawStorage.close`, optional and wired by the kernel only when the driver has one, flushes
strictly once more — which syncs every deferred batch — and releases the backend; the
conformance suite's reopen case closes the first store before opening the second, since a
second store opened beside the first would otherwise read the first's memory. The test double
for all of this is `MemoryBatchBackend` in `packages/db-p2p/src/testing/memory-batch-backend.ts`,
whose `deferSync` option holds a batch not durable until a `sync()` and whose `powerLoss()`
rebuilds the store from the durable prefix alone.

**The file backend.** `FileBatchBackend` commits each group through `FileWriteLog`
(`packages/db-p2p-storage-fs/src/file-write-log.ts`): the batch is encoded as one record (a length,
a CRC-32, then each put or delete with its path relative to the store directory) and appended to
`<basePath>/write-ahead.log` with one `write`. The record has reached the operating system then, so
it survives a crash of this process from that moment: the next open's replay applies it. What the
sync adds is surviving a power cut, and the log makes one sync cover many records
(`FileWriteLog.commit`): a batch committed with `syncWithinMs` 0 is synced before its commit
resolves, with every batch waiting ahead of it; one committed with a window resolves at once and
waits in the log's `unsynced` list with its deadline, counted from the commit's call, and a timer
armed for the earliest deadline runs the sync for everything waiting. A commit that finds the
earliest waiting deadline already passed syncs before it resolves whatever its own window, so when
the disk falls behind, writers wait for it rather than the window growing; a sync that started
after a deadline it covered is logged once per episode as `window-overrun` on the
`optimystic:db-p2p-storage-fs:write-log` channel. That bookkeeping — the waiting batches in order,
the earliest deadline and its timer, the backpressure test and the overrun episode — is
`SyncDeadlines` in `packages/db-p2p/src/storage/sync-deadlines.ts`, which every store that defers
its sync shares; the log supplies only the sync step. The sink's `sync()` (`FileWriteLog.sync`), which a
strict flush with nothing to seal calls, runs the same step; a checkpoint's seal runs it first, so a
sealed segment holds only synced records. Only after the sync is each entry written to its
canonical tree file — straight to the path, no temp file or rename — or unlinked, without syncing
anything, and only then does the batch's `durable` resolve, so the overlay above each store serves a
batch until the tree holds it. A tree file therefore only ever holds content whose log record is
durable, so what a crash leaves is the log's durable prefix plus whatever the tree held, and the
next open replays the log in order (puts and deletes are idempotent), syncs every file and directory
the replay touched, and truncates the log to its header before serving anything. Replay reads
strictly: a torn final record, a record whose length runs past the end of the file, a CRC mismatch,
or a header that is not this build's stops the read before that record, and the records before it
are applied. Rule 3 holds by construction, since the log is one sequence of whole groups and a power
cut that keeps a later page of it while losing an earlier one fails the earlier record's CRC, which
ends the replay there; a promote is two entries of one record, which is what makes it atomic and
durable; and a new block's directory needs no sync of its own ahead of its files. A failure of the
sync step — the sync itself or a tree write after it — latches the log and rejects the `durable` of
every batch it covered, so no flush waits for a sync the store will not make.

The log keeps every file it wrote and every directory whose entries changed since the last
checkpoint, and a checkpoint (`FileWriteLog.checkpoint`) spends that set to discard the log: it
**seals** the log, in line with commits so no apply is in flight, by renaming it to
`write-ahead.log.sealed`, starting an empty one and taking the set; it **syncs** every file and then
every directory in the set, sixteen at a time, while commits carry on into the new log; and it
**truncates** by deleting the sealed segment and syncing the directory. A file deleted since the seal
is skipped and one rewritten since is synced with content the new log also covers. It runs when the
log reaches `checkpointBytes` (16 MiB by default), `checkpointIdleMs` (5 s) after the last append,
and on the last close of the directory's log, one at a time, and a failure latches the store failed
as a rejected commit does. An open replays the sealed segment, if a crash left one, before the
current log — harmless, since the current log holds every later write of the same paths in order —
and deletes it, with a directory sync, before truncating the current log, so the older segment can
never be replayed alone over newer content. A sealed segment that stops short ends the replay there,
the current log included — the two files are read as one log, by the same rule as a bad record
inside one. Directories are therefore
synced only at a checkpoint and at open, never per write; on win32, where a directory cannot be
synced, only files are.

Opening also takes `<basePath>/store.lock` (`acquireStoreLock` in
`packages/db-p2p-storage-fs/src/store-lock.ts`): a lock naming a live process on this machine refuses
the open with `StoreLockedError`, any other is stale and replaced. One `FileWriteLog` per directory
per process, shared by reference count, so every store over one directory — `FileRawStorage` and
`FileKVStore` (`packages/db-p2p-storage-fs/src/file-kv-store.ts`), which writes through a
`WriteGroup` over string keys into the same log — shares one log, one lock and one checkpoint, and
two stores' commits never interleave within a record. Each keeps its own overlay, which is why a
second store opened beside a first does not see the first's unflushed writes.

**The journal backend.** `JournalBatchBackend` in
`packages/db-p2p/src/storage/journal-batch-backend.ts` is the `BatchBackend` for an engine that
writes a group atomically but cannot be trusted to keep write order across a power cut. IndexedDB
can make one transaction durable but promises nothing about the order earlier relaxed transactions
reach the disk; LevelDB syncs only its current log file, closes an old one unsynced when it switches
to a new one, and under default options skips a damaged log record and keeps reading the ones after
it. Either way a later write can survive while an earlier one is lost, which is what rule 3 forbids.
The backend keeps the rule without relying on the engine's order by writing each relaxed group
twice, through a `JournalStore` (same file) the engine implements beside its reads: `appendJournal`,
one atomic unsynced write of the group as a journal record numbered by a sequence with no gaps, not
applied to the stores reads come from; `applyJournal`, one atomic synced write that applies, in
order, every record not yet applied — and, for a strict group, the group itself — sets the
applied-through mark to the last of them, and deletes those records; and `readJournal`. The journal
is a keyspace of the engine's own (an IndexedDB object store, a LevelDB tag byte) that the six
block-storage stores never touch. When a group is applied is `SyncDeadlines`'s rules, the same as the
file log's: a strict group, or one that finds its own or a held deadline already passed, is applied
at once together with everything held; a relaxed one is appended and held with its deadline, counted
from the commit's call, and the timer armed for the earliest deadline applies everything held. An
apply carries every byte it applies, so its durability depends on nothing written before it, and
every apply is synced before the next starts, so a later apply can never survive without an earlier
one. Recovery at open reads the journal, deletes any record at or below the mark (an apply deleted
those in the write that set the mark, so one is there only if the store lost part of an atomic
write), applies the run of consecutive records after the mark, and discards everything after the
first missing number, logging the gap on `optimystic:db-p2p:journal`. A record the engine lost — a
damaged LevelDB log record, an IndexedDB transaction the browser did not keep, an unsynced old log
file — is a missing number, so nothing after it is applied, and what survives is a prefix of the
groups. The next sequence is one past the last applied, so a discarded number is reused only after
the apply that deleted it. The overlay above serves a journaled group until its apply, so a reader
never depends on the journal, and a held record's entries are the arrays the overlay's own bytes are
held in, bounded with it by `maxUnsyncedBytes`. Over a store whose `durability` is below
`'power-loss'` — an engine that cannot sync, such as today's React Native LevelDB binding — the
backend journals nothing and applies each group at once as one atomic write: the atomicity half of
the contract now, and the ordering half the moment the engine can sync, with nothing above it
changing. A rejected store write latches the backend as a rejected commit latches the driver (rule
5). For an engine that stores bytes, `encodeJournalRecord` and `decodeJournalRecord` in
`packages/db-p2p/src/storage/journal-record-codec.ts` give a record one format — a version byte,
the sequence, then each entry's key as JSON, a put-or-delete flag and the value — and a store that
cannot decode a record leaves it out of `readJournal`, which recovery treats as a gap. The browser
store is `IndexedDBJournalStore` in `packages/db-p2p-storage-web/src/indexeddb-storage.ts`: an
append is one relaxed `readwrite` transaction on its `journal` object store, an apply one strict
transaction over the six data stores and the journal — strict where the browser honours
`durability: 'strict'`, which every current release does and which the store detects once at
construction (`supportsStrictDurability` in `packages/db-p2p-storage-web/src/durability.ts`); where
it does not, the store reports `'process-crash'` and the backend applies each group at once — and a
record is stored by structured clone, with no codec. `react-native-storage-commits-groups-through-the-journal`
builds the React Native store; the test double is `MemoryJournalStore` in
`packages/db-p2p/src/testing/memory-journal-store.ts`, whose `powerLoss` drops the journal records
not yet applied, all or a chosen few, and keeps the applied stores.

**Rule 3 past the crashes a store names.** The NativeScript SQLite backend (`SqliteBatchBackend`
in `packages/db-p2p-storage-ns/src/sqlite-storage.ts`) needs no log of its own for it: SQLite's
write-ahead log is one append-only file whose recovery stops at the first frame whose checksum
fails, and under `synchronous = NORMAL` the log is synced before every checkpoint, so what a
power cut leaves is a prefix of the committed transactions, and a batch is one transaction. Its
sync is one commit under `synchronous = FULL`, which syncs the log and so every commit before
it, the key-value store's and the identity helper's included. The browser backend
(`IndexedDBJournalStore` in `packages/db-p2p-storage-web/src/indexeddb-storage.ts`) has it from the
journal backend wherever the browser honours strict transactions: every apply is one strict
transaction carrying every byte it applies, synced before the next apply starts, so no group
survives a power cut without the groups applied before it. Its key-value store and identity helper
commit strictly too, so they leave nothing for a journal to order. In a browser that ignores the
option, and on React Native LevelDB, rule 3 under an operating-system crash or power cut is not
established today: such a browser promises nothing about the order relaxed transactions reach the
disk, and LevelDB under default options skips a damaged log record and keeps reading the records
after it. Raising LevelDB to `'power-loss'` with the prefix rule kept is the work of
`react-native-storage-commits-groups-through-the-journal`, over the journal backend above (it waits
on `react-native-storage-syncs-once-rn-leveldb-can` to sync); the `NOTE:` at `durability` on
`LevelDBStoreDriver` records it, and the `NOTE:` at `durability` on `IndexedDBJournalStore` the
browser case.

**Visible on a running node.** `createLibp2pNodeBase` logs one line on the `node-wiring`
channel at start-up naming what the resolved storage's flushed writes survive and what the
durability window means on it (`logStorageDurability` in
`packages/db-p2p/src/libp2p-node-base.ts`): on a `'power-loss'` store, the window for each
cohort size up to the declared `clusterSize` (at most ten), or that every write is synced
first when failures are not independent; on a `'process-crash'` store, that it cannot sync, so
a power cut may lose any write the operating system has not written out, whatever the window.

Every persistent backend's conformance suite registers `{ persistent: true }`, which adds a
case that flushes a write of every kind and reads each back through a fresh store over the
same location (`runRawStorageConformance` in
`packages/db-p2p/src/testing/raw-storage-conformance.ts`).

**Who calls `flush()`.** Exactly once at the end of every group of writes whose outcome the
node is about to report to another machine:

- `StorageRepo` ends each write group through `endGroup` in
  `packages/db-p2p/src/storage/storage-repo.ts`: `pend`, `commit`, `cancel`, `recoverBlock`,
  `saveReplicatedBlock`, and a `get` that entered a block write latch (a read-driven
  promotion, or a coverage restore). The flush runs after the group's latches are released,
  so a concurrent group on the same blocks is not held behind the disk and several groups can
  share one sync, and before the group's change events. A group whose work throws is flushed
  before the error propagates, strictly whatever window it was given, and one fanned out per
  block (`get`, `cancel`) first waits for every block to settle, so the flush covers a sibling
  block still writing when another failed; a flush that rejects after the work returned makes
  the call throw and emit nothing. A `get` that took no latch does not flush, so the plain
  read path costs nothing extra.

  Which groups carry a window. `pend` and `commit` take a third argument, `StorageApplyOptions`
  in `packages/db-p2p/src/storage/storage-repo.ts`, whose `syncWithinMs` is the group's
  `withinMs`; absent, the group is strict. A node passes a window only for an apply that runs
  on a consensus record — `ClusterMember.applyConsensusOperation` for the pend and commit of
  every record it applies, and `CoordinatorRepo` for its own fallback pend and commit after
  consensus ran without its member — and the window is `durabilityWindowMs` in
  `packages/db-p2p/src/storage/durability-window.ts` for the size of that record's cohort
  (`recordDurabilityWindowMs`, from `record.peers`, this node included and capped by the policy
  at the declared `clusterSize`), bound to the node's policy once by `createLibp2pNodeBase` and
  handed to both as `durabilityWindowFor`. Every other group is strict; the table under
  [How long a write may wait for its sync](#how-long-a-write-may-wait-for-its-sync) lists
  them. Repair and bookkeeping are off the per-write hot path, and a replica a pusher counts as
  held should not sit in a window. A `pend` or `commit` given a window flushes with it on every
  exit, a refusal included: what a refusal writes is at most a dropped pending record, and the
  writer is told to retry, so nothing is announced on it. A member or coordinator built without
  `durabilityWindowFor` applies strictly, and on a backend that does not defer its sync (every
  one but the file backend, the table above) a window changes nothing a node does.
- `applyInvalidation` in `packages/db-p2p/src/dispute/invalidation.ts` calls
  `InvalidationContext.flush` after releasing its latches and before appending the entry that
  names the compensating revisions, so an entry never names revisions the store lost. Nothing
  wires the dispute path in production yet; this is the contract for when something does.
- `KvUnderReplicationLedger` in `packages/db-p2p/src/repo/kv-under-replication-ledger.ts`
  flushes its key-value store after every call that wrote to it, so a shortfall
  `CoordinatorRepo` names in its answer, and a peer the drain reports satisfied, outlive a
  restart.

The one block-storage write outside a group is the read path's re-cache of a materialized
block (`materializeBlock` in `packages/db-p2p/src/storage/block-storage.ts`), which can be
recomputed and becomes durable with the next group's flush. `PersistentTransactionStateStore`
(`packages/db-p2p/src/cluster/persistent-transaction-state-store.ts`), wired only when a host
passes `NodeOptions.transactionStateStore`, writes without waiting and promises nothing before
it replies, so it is not flushed. Over `WriteGroupDriver` both wait in memory, like every other
write, until the next group's flush or the driver's idle flush, whichever comes first.

**Visible before durable (accepted).** Between a write resolving and its group's flush,
readers in this process can see it, and through them other machines. What a read can expose
is consensus-decided content or a pending record, and what a crash takes back is always a
later suffix of the resolved writes (rule 3): a vote built on a record's absence stays valid
when the record is lost, and one built on its presence was a refusal. Likewise a second group
on the same blocks can read the first's writes before they are durable and build on them;
its own writes resolved later, so under rule 3 they cannot survive without the first's.

A group flushed with a window stays visible longer: its change events fire when the flush
resolves, which for a relaxed flush is once the writes survive a process crash, not a power
cut. Within the window a power cut can take back a write this node announced to its
subscribers and reported held to the coordinator, which is the accepted risk the window's
loss target prices (`durabilityWindowMs` in `packages/db-p2p/src/storage/durability-window.ts`
and [docs/correctness.md Theorem 6](../../../docs/correctness.md#theorem-6-durability)): the
cohort acknowledged the write on a majority, and the window is sized so that the members a
rival would need to out-vote are vanishingly unlikely to all lose power inside it. A deferred
sync that fails latches the store (rule 5), so the next group on the node fails and is logged,
but the writer answered inside the window was already told the write landed — the same risk.
What the window does not price is a holder that lost a write writing alone before its partner
returns, which forks the collection; that residual is stated under
[Theorem 6](../../../docs/correctness.md#theorem-6-durability).

**The write orders crash recovery relies on.** Every backend's flush is reviewed against this
list. Under a crash of this process every persistent backend keeps every resolved write, so
each order holds. Under a power cut the file and NativeScript SQLite backends, which sync only
at the flush or within the window, are held to them by rule 3: what survives is a prefix of the
resolved writes, which
never keeps a later step without an earlier one. On the `'process-crash'` backends they are not
established across a power cut (*Rule 3 past the crashes a store names*, above).

1. **Claim before record.** `BlockStorage.savePendingTransaction` writes the slot and base the
   record claims into the block's metadata before the pending record itself, so a crash
   between them leaves an inert claim and never a claim-less record, which every reader treats
   as the strongest reservation (`isReservationAgainst` in
   `packages/db-p2p/src/storage/pending-claim.ts`).
2. **One block's commit, in order** (`internalCommit` in
   `packages/db-p2p/src/storage/storage-repo.ts`): materialized block, revision record,
   promote, `setLatest`, proof, prune of the prior materialization. `latest` is never on disk
   naming a revision whose record or transform is not, and the prune is never on disk without
   the new materialization and `setLatest`. The only partial states the retry path heals are
   revision-saved-not-promoted (Crash-D2) and promoted-with-`setLatest`-lost (Crash-D3, healed
   by `BlockStorage.recover` from `StorageRepo.commit`).
3. **Promote is one atomic move** ([Invariant P](../../../docs/repository.md#invariant-p--a-pending-record-and-a-committed-record-never-coexist-for-one-action),
   and Invariant 4 above). On the file backend it is two entries of one log record, so a crash
   leaves both or neither.
4. **Log tail first** (`tailFirst` in `packages/db-p2p/src/storage/storage-repo.ts`): a member
   holding a committed non-tail block of an action also holds the action's committed log tail.
5. **Forward writes** (`BlockStorage.saveForwardRevision`): revision record, transform,
   materialization and proof before the metadata that advances `latest`, and the same action's
   pending record deleted no later than that metadata.
6. **Coverage restore** (`BlockStorage.restoreRevision`): the restored records before the
   `ranges` entry that claims them.
7. **Delete before the claim is dropped** (`BlockStorage.deletePendingTransaction`, and
   `refuseMissingBase` and `dropUnpromotablePendings` in `StorageRepo`). On the file backend the
   delete and the metadata write that follows it are records of one log, in that order.
8. **Across stores:** the durable executed marker (`markExecuted`, written by
   `ClusterMember.handleConsensus` in `packages/db-p2p/src/cluster/cluster-repo.ts`) after the
   apply it describes, and the under-replication entry after the commit it describes. Two
   stores are two durability domains, with no prefix rule between them, and the apply's own
   flush may have been given a window, so the second write waits for the first to survive a
   power cut rather than merely for its flush: the marker is written by
   `markExecutedOnceDurable` in `packages/db-p2p/src/cluster/cluster-repo.ts` once the block
   store's `whenDurable()` resolves (the `IDurableStorage` capability of `StorageRepo`, which
   never hastens the sync; a repo without it has the marker written at once, and a rejection
   writes none), and the ledger entry is written after the strict flush of the block store
   that `KvUnderReplicationLedger`'s `beforeRecord` hook runs, wired by `createLibp2pNodeBase`.
   A process crash between the apply and its marker loses only the marker, and redelivery
   re-applies idempotently.

#### How long a write may wait for its sync

A node lets a write's sync wait only where other machines also hold the write, and only as long
as the size of the cohort that agreed to it allows. `durabilityWindowMs` in
`packages/db-p2p/src/storage/durability-window.ts` computes that window `w` for a cohort of `n`
members at the node's promise threshold `t` (`superMajorityThreshold`):

- a rival write needs `a = ⌈t·n⌉` approvals to take the write's revision;
- a write is acknowledged once at least `h = ⌊n/2⌋ + 1` members hold it (the acknowledgement
  gate's strict majority, [docs/correctness.md §2](../../../docs/correctness.md#2-definitions));
- so at least `m = max(1, a + h − n)` of those holders must lose the write before a rival can
  gather its approvals, since every other approval comes from a member that never held it.

With `p` the rate of power cuts and operating-system crashes per machine and `ε` the accepted
chance of losing one acknowledged write, machines that fail independently lose the write with a
chance of about `C(h, m)·(p·w)^m`, so `w = (ε / C(h, m))^(1/m) / p`, rounded down to whole
milliseconds and capped at `maxWindowMs`. Four rules decide before the formula does:

1. `n` is capped at the node's declared `clusterSize`, so a record listing more peers cannot buy a
   longer window.
2. `n ≤ 1` gives 0: no other machine holds the write.
3. `m = 1` gives 0: one machine losing the write would be enough. At a threshold of one half or
   below this is every cohort.
4. `independentFailures: false` gives 0 for every write, for a deployment whose machines share a
   failure (two machines on one circuit).

The inputs are `NodeOptions.storageDurability` (`StorageDurabilityOptions`), filled and validated
once at node construction by `resolveDurabilityWindowPolicy`, which throws a `RangeError` naming
the field for an out-of-range value. The defaults: independent failures assumed, `p` one per
machine per 30 days (`lossRatePerHour` 1/720), `ε` 10⁻⁹ (`lossTarget`), and a 5000 ms cap
(`maxWindowMs`). At those and the default threshold of 0.75:

| n | a | h | m | C(h, m) | formula | window |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | — | — | 0 ms |
| 2 | 2 | 2 | 2 | 1 | 82 s | 5000 ms |
| 3 | 3 | 2 | 2 | 1 | 82 s | 5000 ms |
| 4 | 3 | 3 | 2 | 3 | 47 s | 5000 ms |
| 5 | 4 | 3 | 2 | 3 | 47 s | 5000 ms |
| 6 | 5 | 4 | 3 | 4 | 1633 s | 5000 ms |
| 7 | 6 | 4 | 3 | 4 | 1633 s | 5000 ms |
| 8 | 6 | 5 | 3 | 10 | 1203 s | 5000 ms |
| 9 | 7 | 5 | 3 | 10 | 1203 s | 5000 ms |
| 10 | 8 | 6 | 4 | 15 | 7406 s | 5000 ms |

So at the defaults the cap, not the loss target, sets every window from two members up; the
formula binds only at a higher loss rate (`lossRatePerHour: 1` gives 113 ms at `n = 2` and 65 ms
at `n = 4`). The window column and those two values are pinned by
`packages/db-p2p/test/durability-window.spec.ts`.

Which writes carry a window (mechanism under *Who calls `flush()`* above):

| Write | Window |
|---|---|
| `pend` and `commit` of a consensus record, applied by `ClusterMember.applyConsensusOperation` | `w` for the record's cohort |
| `CoordinatorRepo`'s own fallback `pend` and `commit` after consensus ran without its member | `w` for the record's cohort |
| a solo `pend` or `commit` (`CoordinatorRepo.pendSolo`, `CoordinatorRepo.commitSolo`): only this machine holds the write | 0 |
| `cancel`, `recoverBlock`, `saveReplicatedBlock`, a `get` that took a write latch, a consensus `get` or `cancel` operation | 0 |
| a group whose work threw | 0, whatever it was given |
| the under-replication entry, and the flush of the block store its `beforeRecord` runs first | 0 |
| the durable executed marker (`markExecutedOnceDurable`) | none of its own: written once the block store's `whenDurable()` resolves |

#### What an acknowledged write survives

From the moment the write's flush resolves, per backend:

| Backend | `durability` | Process crash | Power cut or operating-system crash |
|---|---|---|---|
| File (`FileBatchBackend`) | `'power-loss'` | survives at once | survives once its window has passed, at once for `w = 0`; a power cut inside the window takes the most recent groups whole, a prefix surviving |
| React Native LevelDB (`LevelDBStoreDriver`) | `'process-crash'` | survives at once | survives whenever the operating system writes it out; the window cannot be kept, and the node says so at start |
| Browser IndexedDB (`IndexedDBJournalStore`) | `'power-loss'` where the browser honours strict transactions (every current release), else `'process-crash'` | survives at once | with strict transactions: survives once its window has passed, at once for `w = 0`; a power cut inside the window takes the most recent groups whole, a prefix surviving. Without: as LevelDB |
| NativeScript SQLite (`SqliteBatchBackend`) | `'power-loss'` | survives at once | survives once its window has passed, at once for `w = 0`; a power cut inside the window takes the most recent groups whole, a prefix surviving |
| Memory (`MemoryStoreDriver`) | `'none'` | lost | lost |

The React Native row changes as its tickets land
(`react-native-storage-commits-groups-through-the-journal` and the blocked
`react-native-storage-syncs-once-rn-leveldb-can`), and
[docs/correctness.md §1.2](../../../docs/correctness.md#12-nodes) with it. The browser row rests
on what a browser does with `durability: 'strict'`; nothing in this repository cuts the power, so
the package's tests check which durability each transaction asked for and no more.

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

**Construction and durability:** `new StorageRepo(storage, options?)` takes the raw store;
`options.createBlockStorage` builds each block's storage over that same store (default
`BlockStorage`), and every write group ends with one `flush()` of it (Invariant 6).

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
- **Durability**: `flush()` makes every write resolved before it survive the crashes the store's fixed `durability` names (Invariant 6 above)

### 4. File-based Storage (`FileRawStorage`)

`FileRawStorage` in `packages/db-p2p-storage-fs/src/file-storage.ts` is the shared
`KvRawStorage` kernel over a `WriteGroupDriver` over a `FileBatchBackend`
(`packages/db-p2p-storage-fs/src/file-batch-backend.ts`), which lays out the six
logical stores as filesystem subdirectories and commits each write group through
the directory's write-ahead log (`FileWriteLog` in
`packages/db-p2p-storage-fs/src/file-write-log.ts`). The kernel owns JSON
(de)serialization on top; the driver holds each group in memory until its flush;
the backend appends the group to the log with one sync, writes the tree, and
replays the log on the next open; a checkpoint syncs the tree and discards the
log in the background, and on the last close. The constructor is synchronous; the first
operation takes the directory's lock and replays. How the log holds Invariant 6
is under *The file backend* there. See "Shared KV Kernel" below.

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
with its native atomic primitive (batch / DB transaction / one write-ahead-log record).

Every shipping backend uses this kernel today: in-memory (`MemoryStoreDriver`) and LevelDB
each supply only a driver, the filesystem and NativeScript SQLite backends each supply a
`BatchBackend` (`FileBatchBackend`, `SqliteBatchBackend`) under `WriteGroupDriver`, and IndexedDB
supplies a `JournalStore` (`IndexedDBJournalStore`) under `JournalBatchBackend` under
`WriteGroupDriver`. A shared conformance suite (`src/testing/raw-storage-conformance.ts`,
exported from the `./testing/conformance` entry — separate from `./testing` because
it imports `chai`, which is a devDependency consumers never install) asserts every
backend behaves identically against the shared kernel contract.

A backend that would rather take its writes a group at a time supplies a `BatchBackend`
(`packages/db-p2p/src/storage/batch-backend.ts`) instead of a driver and is composed as
`KvRawStorage` over `WriteGroupDriver` over that backend; the suite runs that composition over
the test-only `MemoryBatchBackend` (`packages/db-p2p/src/testing/memory-batch-backend.ts`). What
the driver does is under Invariant 6, *Writes that wait in memory*.

**File System Structure:**
```
{basePath}/
├── write-ahead.log         # Groups written since the last checkpoint
├── write-ahead.log.sealed  # The log a checkpoint is syncing the tree under (only during one, or after a crash in one)
├── store.lock              # { pid, hostname } of the process holding the store
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
│   ├── proofs/
│   │   ├── {rev}.json      # Commit proof retained for that revision
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
  - the *cross-process* case. The filesystem backend's lock (`acquireStoreLock` in
    `packages/db-p2p-storage-fs/src/store-lock.ts`) refuses a second live process on
    the same machine, but a second machine over a network share is not refused, and
    its writes bypass this cache entirely. Out of scope for any in-process check;
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
  lineageFloor?: number;      // Lowest revision `latest` is known to be BUILT FROM, see below
  pendingRevs?: Record<ActionId, number>;   // Per pending record, the revision its pend claimed
  pendingBases?: Record<ActionId, number>;  // Per pending record, the base its operations were computed against
};
```

`pendingRevs` and `pendingBases` describe the block's pending records — the slot each one claims
and the committed revision its update operations were computed against — and are written, dropped
and swept together with the record (`BlockStorage.recordClaim`), never on their own. They live here
rather than inside the record because a promotion moves the record's bytes into the committed store
unchanged. An entry whose record is gone is inert (every reader joins against the pending
namespace), and a record with no entry reads as unknown: an unknown slot is the strongest kind of
reservation, an unknown base is simply nothing to compare. Read through
`IBlockStorage.listPendingClaims` and `IBlockStorage.pendingClaimOf`; the rules that consume them
are in `docs/repository.md`, "A pending record claims a slot, and reserves the block until a writer
builds on it".

`lineageFloor` is what lets a node say whether the content it holds now was built from a given
committed write — the question a writer asks when its write was superseded before it could confirm
it (`IBlockStorage.lineageOf`, surfaced by `StorageRepo.get` on `BlockGets.lineageOf`). It is the
lowest revision from which every later revision record was produced on this node by applying an
update-only transform to the content of the revision before it; a replica, a forward tombstone, an
insert-carrying commit and the block's first revision each move it up to themselves, because they
install content this node did not derive. The revision index alone answers neither direction — a
node that took a later revision as a replica can neither vouch for a write it names nor deny one it
does not — so a node past the write's revision answers `unknown` unless the floor is at or below
it. The cohort-level folding is `judgeCohortLineage` in db-core; the whole argument is in
`docs/internals.md`, "The writer's retry finishes its own half-landed action".

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
// Create a storage repository over a raw store; every write group ends with one flush of it
const repo = new StorageRepo(rawStorage, {
  createBlockStorage: (blockId, store) => new BlockStorage(blockId, store, restoreCallback)
});

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
- **One sync per strict write group, one per window otherwise**: the write-ahead log is synced before a strict flush resolves, and once by the earliest deadline for the groups whose flushes allowed a wait; the tree is written after the sync, without waiting for its own

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
