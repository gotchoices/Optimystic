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
`RawStoreDriver` that only moves stored values (bytes, or on React Native the text
they decode to, see *Shared KV Kernel* below): `MemoryRawStorage`, `FileRawStorage`,
`IndexedDBRawStorage`, `LevelDBRawStorage`, and `SqliteRawStorage` all `extends
KvRawStorage`, each supplying only a driver for its native mechanism — or, for the
backends that take their writes a group at a time, a `BatchBackend` or a `JournalStore`
under the shared `WriteGroupDriver` (Invariant 6 below). The
migration from direct implementation onto drivers (mentioned in older revisions
of this doc) is complete.

## Invariants

These seven properties are what make it safe to build another layer (e.g. a
cache) over `IRawStorage`. Each entry states the rule, where it's enforced, and
what breaks if it's violated.

### 1. Every write to a store goes through `IRawStorage`

Nothing mutates a backend's bytes behind the interface. `KvRawStorage`'s save
methods are the one place every value write funnels through — the
"single choke point" comment in `packages/db-p2p/src/storage/kv-raw-storage.ts`:

> every value write funnels through the driver put/delete calls in the methods
> below (saveMetadata / saveRevision / save*Transaction /
> saveProofEntry / saveCommitProof / storeCommitProofIfAbsent / saveMaterializedBlock). This is the single choke point where an incremental
> byte counter would hook in…

**Scope:** this holds only for writes issued *in this process*. It is not a
guarantee against mutation from outside the process — that boundary is
Invariant 5 below. Blob pieces are the one exception: they are kept in an
`IPieceStore` beside the block store, outside this kernel
([docs/blobs.md §The local store](../../../docs/blobs.md#the-local-store)).

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

The commit proofs store keyed by message hash (*Shared KV Kernel*, under Core Components) is not
filed under any one block. Its writer, `KvRawStorage.saveBlockProof`, runs under the latch of the
block whose revision it is saving a proof for, so two blocks of one commit — the commit's own apply
and a certified push of another of its blocks — can save one message's record at once, under two
latches. No latch orders them, and none needs to: the store's memo joins the second save onto the
first, and a record already stored under a hash is kept, never replaced.

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
`saveBlockProof`, `restoreRevision`, `saveReplica`, `saveDeletion`, `deleteBlock`,
`recover`.
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

#### Deleting a block

`IBlockStorage.deleteBlock(latch)` is the one operation that takes bytes back off a node: it removes every record this node holds for one block. Nothing else removes anything of a block's — an invalidation writes a compensating *forward* revision rather than erasing the one it reverses, and the only other delete in the whole surface is of one pending record. Its one caller is `StorageRepo.deleteBlockIfNotAdvanced`, through which the released-block sweep deletes the blocks this node has handed over; the ring handoff is what releases a range safely ([docs/arachnode-ring-handoff.md § Local bytes vs. tracking](../../../docs/arachnode-ring-handoff.md#local-bytes-vs-tracking)) and *The released-block sweep* below is which blocks may be given to it.

**It holds the block's write latch**, which is why it is on `IBlockStorage` and takes a token rather than being a plain storage call. A delete is the widest write there is: a pend or a commit interleaving with it would write records back under a block whose metadata has just gone, leaving content no listing reports and no read serves. `BlockStorage.deleteBlock` therefore `assertLatch`es exactly as every other writer does, and the sweep acquires the latch the ordinary way.

**It is ordered and resumable, not atomic.** Across stores the operation is allowed to be interrupted, provided the **metadata record goes first and durably**: metadata is what makes a block present, so once it is gone `getMetadata` answers `undefined`, `listBlockIds` (which enumerates metadata keys only) stops reporting the block, and a restart's owned-block seeding does not re-adopt it — the block reads as one this node does not hold, which is the state the delete is driving toward. What a crash in the middle leaves is therefore content with no metadata: bytes nothing serves and nothing reports, which **running the same `deleteBlock` again removes**, so the operation is required to be idempotent (on a block with no metadata it still takes the content; on a block with nothing at all it resolves quietly). The reverse order is forbidden, not merely discouraged: metadata naming a `latest` whose revision record is gone reads as a block this node *holds* and then throws inside materialization, where a block that reads as absent is a state the whole system already handles. Three of the four shipping backends happen to do the whole thing in one atomic transaction or batch (SQLite, IndexedDB, LevelDB), which is strictly stronger; the filesystem backend is the one that really is interruptible, and it takes three steps to get there: its `meta.json` unlink is a synced write-ahead-log commit, then a checkpoint makes the tree durable and discards the log, and only then is the block's directory removed. The checkpoint is what makes the removal safe — a log the removal is not recorded in would replay its earlier content writes over the emptied directory. Because that removal is recursive and a block id is used raw as a relative path there, the filesystem backend refuses an id that does not resolve strictly inside the store (`..`, an absolute id, the empty id) before it writes anything — a backstop under the kernel's own refusal of such an id, which is Invariant 7 below.

**It leaves the commit proofs store alone.** Six of the seven stores are filed under a block and are emptied; the seventh is keyed by a consensus message's hash alone (*Shared KV Kernel*, under Core Components), one entry per message however many blocks that message covered, so an entry may still certify revisions of blocks this node keeps and the key shape admits no per-block delete. `deleteBlock` removes the deleted block's *entries* in the proofs store and leaves the proof *bodies* those entries referred to — orphaned when no revision of any kept block names them. Sweeping that residual is the backlog ticket `debt-unreferenced-commit-proofs-are-never-swept`.

**It emits no change notification.** Every other write path emits a collection change so trackers and the reactivity layer see it. A delete emits nothing, deliberately: the block's *content* has not changed, this node has merely stopped holding it, and a change event would send readers to re-read a block this node is no longer the place to ask. A reader that still wants the block is served by the rest of the cohort, and a later local read repairs from it through `RestorationCoordinator`, exactly as for any block this node does not hold. For the same reason the delete does not touch the resilience monitors' owned-block set: a released block is untracked at Phase C, before it is ever eligible.

**It is not a network delete.** Removing a block some peer still expects this node to serve loses data for the cohort. Which blocks may be given to it — and the durable ledger that makes a half-done delete resumable across a restart — belong to the sweep, not to this operation.

#### The released-block sweep

The rule about which blocks may be given to `deleteBlock` is one sentence, and everything below is in service of it:

> **A block's bytes are deleted only after a release that confirmed at least the replication floor of other serving holders hold a current replica of it.**

**The ledger is what says so, and the only thing that does.** `ReleasedBlockLedger` (`packages/db-p2p/src/storage/released-block-ledger.ts`) keeps one entry per released block under the `optimystic-released/` key namespace of the node's `IKVStore` (§8), carrying when the release happened, which path released it — a ring shift's Phase C, or the confirmed rebalance release — and the revision the confirmation handed over. That revision is a required argument of the write, supplied by the confirm step that read it off this node's store when it pushed the block; the ledger reads no metadata of its own, because anything it read would be read *after* the release and so might be a replica a peer had already pushed back — recording that as the released revision is what would let the sweep delete a block the node had just accepted. Exactly two code paths write it, both inside the node factory's Arachnode gate and both strictly after a confirmation; nothing else may.

**The sweep derives nothing.** `ReleasedBlockSweep` (`packages/db-p2p/src/storage/released-block-sweep.ts`) reads the ledger and, per entry, calls `StorageRepo.deleteBlockIfNotAdvanced` and then drops the entry. It never consults this node's ring, partition or owned-block set: mid-shift the advertised partition is the *target* ring, so a block that merely looks outside this node's slice may be one whose handoff rolled back and is still being served. Reading the ledger instead of re-deriving is what makes that class of bug unreachable rather than merely avoided.

**The entry outlives the delete.** It is dropped *after* the delete, which is why `deleteBlock` is required to be ordered and idempotent: a crash in between leaves content with no metadata plus an entry, and the next run finishes it. The reverse order would lose the knowledge that the bytes are free the moment a crash caught a delete half-done — which is also why the entry is durable rather than re-derived from the node's partition after a restart.

**A block written again since its release is kept.** A peer may push the same block back (the receiver is idempotent, and three producers may push one block), and a commit may still be routed here mid-transition. `deleteBlockIfNotAdvanced` therefore re-reads the block's `latest` **under the same hold of the write latch** as the delete and declines when it has advanced past the revision the entry recorded, dropping the entry without deleting. Keeping those bytes is harmless — the node is not responsible for the block and the cohort holds it to the floor — while deleting them would have the node delete a block it has just accepted. The block is also offered again rather than left stranded: a push or commit that advanced `latest` emitted a collection change, which the node's owned-block feed turns back into a tracked block, so the next rebalance pass releases it again if its cohort has still moved on — and that release records a fresh entry carrying the revision it now holds. That refresh is why a re-release rewrites an existing entry rather than leaving it. A push of a revision this node already held advances nothing and emits nothing, so such a block is deleted, which is right: nothing new was accepted.

**What runs it, and what bounds it.** A release that wrote entries asks for a run, so an ordinary shed frees its bytes promptly; a pressure sample at `shedding` or above asks for one, so a node under pressure finishes whatever a previous run left; and one runs shortly after start-up, which is what finishes the deletes a crash interrupted. Runs never overlap (single-flight with one queued follow-on, the shape `BlobCacheBudget` uses) and each takes at most `DEFAULT_RELEASED_BLOCK_SWEEP_LIMIT` entries, so a node that released tens of thousands does not hold the event loop for one pass — the ledger is what makes stopping partway safe, and `list` orders oldest release first so each run makes progress. A run stopped by that cap **asks for the next one itself**, because the triggers above may not come again: a node that dropped below `shedAbove` by deleting these very blocks samples no further request, and nothing else asks until the next release, so the cap would ration the shed rather than chunk it. It chains only when it also dropped at least one entry, which both bounds the chain (the ledger is strictly smaller each time, so a chain is at most one run per entry) and keeps a faulting store from spinning it: a run whose whole batch failed may have failed to record those attempts too — `noteFailure` is one more write to the same store — so it stops and waits for the next trigger instead. An entry whose delete keeps failing is retried three times (`RELEASED_BLOCK_DELETE_ATTEMPTS`) and then passed over, still in the ledger, so an operator can see that the block was released and not deleted; nothing silently drops an entry, which would leak the bytes *and* the record of them.

**The blob half is the existing piece sweep.** A run that deleted anything asks `LocalBlobService.sweep` once. Nothing new is built for it: a blob's holds are released by the blob reclaim pass and the cohort reaction, and the piece sweep already removes the pieces no remaining hold needs (docs/blobs.md §Lifetime).

**It runs on a serving node only.** The sweep's one write is a block delete, and a client node (§8) has no `StorageRepo`: nothing reads its block store, and no writer can record an entry on it either, since both release paths are inside the serving role. A client's sweep would be a second handle onto a store nothing else uses, deleting entries nothing can have written.

**What it cannot free.** A block whose handoff never confirmed is never released, so it is never recorded and never swept: it stays on this node, served, indefinitely. That is the safe direction, and it means the sweep cannot be relied on to free a node whose handoffs keep failing (`tickets/backlog/bug-a-block-kept-after-a-failed-handoff-is-never-offered-again.md`). §10's table of levers says what else this one cannot reach.

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
journal backend (*The journal backend* below) over the browser store, and over the React Native
store once its LevelDB binding can sync a batch (it cannot today, so there every window is 0):

| Driver | What a write waits for today | What `flush()` does | `withinMs` | `durability` |
|---|---|---|---|---|
| `MemoryStoreDriver` | the in-memory map update | nothing | ignored | `'none'` |
| `WriteGroupDriver` (`packages/db-p2p/src/storage/write-group-driver.ts`) | nothing: it is recorded in memory and served from there | seals the group and hands it to the backend's `commit`; a strict flush resolves when the batch is durable, a relaxed one when it is committed | the time left to the earliest deadline of the flushes sharing the seal is passed to the backend's `commit` as `syncWithinMs`; honoured only as far as the backend defers | the backend's |
| `FileBatchBackend` (`packages/db-p2p-storage-fs/src/file-batch-backend.ts`), under `WriteGroupDriver` | nothing: it is recorded in memory and served from there | an append to the write-ahead log; a strict flush syncs it before resolving, a relaxed one resolves at once (or, while a checkpoint is behind, once its share of the checkpoint's syncs is done) and the log syncs by the earliest deadline among the batches waiting; the tree is written after the sync | honoured: one sync covers every batch appended since the last, made by the earliest deadline, or sooner by a strict flush, a checkpoint, or a commit that finds a deadline already passed | `'power-loss'` |
| `JournalBatchBackend` (`packages/db-p2p/src/storage/journal-batch-backend.ts`), under `WriteGroupDriver`, over a `JournalStore` the engine implements | nothing: it is recorded in memory and served from there | over a store that can sync: a strict flush is one synced apply of every journal record held plus the group itself; a relaxed one appends the group as one unsynced journal record and resolves, and the held records are applied in one synced apply by the earliest deadline among them. Over a store that cannot sync: one atomic apply per group, never journaled | honoured over a store that can sync: one apply covers every record appended since the last, made by the earliest deadline, or sooner by a strict flush or a commit that finds a deadline already passed; ignored over one that cannot | the store's: `'power-loss'` when it can sync an apply, else what the engine gives |
| `LevelDBJournalStore` (`packages/db-p2p-storage-rn/src/leveldb-storage.ts`), under `JournalBatchBackend` under `WriteGroupDriver` | nothing: it is recorded in memory and served from there | where the handle can sync a batch (`canSync` on the package's `LevelDBLike`, which `classic-level` reports and `rn-leveldb` cannot yet): as the journal backend's row, an append being one unsynced LevelDB batch putting the record under the journal's tag byte and an apply one batch over the data tags and the journal written with LevelDB's `sync` option. Where it cannot: one unsynced batch per group, never journaled | honoured where the handle can sync, as the journal backend's row; ignored where it cannot | `'power-loss'` where the handle can sync, else `'process-crash'`, which `rn-leveldb` is today |
| `IndexedDBJournalStore` (`packages/db-p2p-storage-web/src/indexeddb-storage.ts`), under `JournalBatchBackend` under `WriteGroupDriver` | nothing: it is recorded in memory and served from there | where the browser honours `durability: 'strict'` (every current release): as the journal backend's row, an append being one relaxed `readwrite` transaction on the `journal` object store and an apply one strict transaction over the seven data stores and the journal, which completes only once the browser has put it on the disk. Where it does not: one relaxed transaction per group, never journaled | honoured where the browser honours strict transactions, as the journal backend's row; ignored where it does not | `'power-loss'` where the browser honours strict transactions, else `'process-crash'` |
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
commit proofs, materialized, and the two entries a promote records — resolves at once, recorded in an
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
resolves, with every batch waiting ahead of it; one committed with a window resolves at once — unless
a checkpoint is behind, below — and waits in the log's `unsynced` list with its deadline, counted from the commit's call, and a timer
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
every directory in the set while commits carry on into the new log; and it **truncates** by deleting
the sealed segment and syncing the directory. The syncs run one at a time, and each starts only when
no task is queued or running in the log's queue — a commit, a sync step, a seal — so a commit's own
append and log sync wait for at most the one tree sync in flight (`FileWriteLog.syncSealed` in
`packages/db-p2p-storage-fs/src/file-write-log.ts`). Every `fs` call of the process runs on libuv's
thread pool, four threads by default, and a sync holds one for its whole length; on macOS libuv
implements `fsync` as `F_FULLFSYNC`, a flush of the drive's whole write cache, made one after another
by the device. Sixteen at a time, a checkpoint held every thread for its whole length and queued every
commit and read behind it, which is GitHub #62's seconds-long commit at each checkpoint. Once the
last close has begun no commit is left to make way for, so its checkpoint, and the rest of one still
running, syncs sixteen at a time, as the open's replay does. When the current log reaches `checkpointBytes` while the checkpoint before it is still running,
the checkpoint is **behind**: its syncs stop making way, and a commit, after its append and outside
the queue, waits until the checkpoint has completed the commit's share of its syncs — the record's
bytes times the sealed segment's paths per byte, or more when finishing before the current log
reaches twice `checkpointBytes` takes more (`CheckpointPace.charge` in
`packages/db-p2p-storage-fs/src/checkpoint-pace.ts`). Shares are charged in append order on one count,
so writers together are held to the rate the disk makes the tree durable, and the log stays near twice
`checkpointBytes`. A commit never waits for a checkpoint it did not fall behind, and the first to wait
in a checkpoint logs `checkpoint-behind` on the write-log channel. A file deleted since the seal
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
is a keyspace of the engine's own (an IndexedDB object store, a LevelDB tag byte) that the seven
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
transaction over the seven data stores and the journal — strict where the browser honours
`durability: 'strict'`, which every current release does and which the store detects once at
construction (`supportsStrictDurability` in `packages/db-p2p-storage-web/src/durability.ts`); where
it does not, the store reports `'process-crash'` and the backend applies each group at once — and a
record is stored by structured clone, with no codec. The React Native store is `LevelDBJournalStore`
in `packages/db-p2p-storage-rn/src/leveldb-storage.ts`: the journal is one tag byte of the one
LevelDB keyspace (`TAG_JOURNAL` in `packages/db-p2p-storage-rn/src/keys.ts`, each record under its
sequence as 8 bytes big-endian and the mark under the bare tag), an append is one unsynced batch, an
apply is one batch over the data tags and the journal written with LevelDB's `sync` option wherever
the handle reports it can (`canSync` on the package's `LevelDBLike`), and a record is bytes through
the codec above. Every write that package makes is a batch — the key-value store's and the identity
helper's included, and the handle surface has no single put or delete — so no unsynced direct write
sits in an old log file outside the journal's reach. `rn-leveldb` cannot sync today, so on a phone
the store reports `'process-crash'` and the backend applies each group at once as one unsynced
batch; the synced path runs in the package's suite over `classic-level`, and the blocked
`react-native-storage-syncs-once-rn-leveldb-can` is the binding change that turns it on. The test
double is `MemoryJournalStore` in
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
commit strictly too, so they leave nothing for a journal to order. The React Native backend
(`LevelDBJournalStore` in `packages/db-p2p-storage-rn/src/leveldb-storage.ts`) is built over the
same journal backend, its key-value store and identity helper commit as one batch each, and nothing
in that package writes outside a batch, so it has rule 3 the moment its handle can sync a batch. In
a browser that ignores the option, and on React Native LevelDB today, rule 3 under an
operating-system crash or power cut is not established: such a browser promises nothing about the
order relaxed transactions reach the disk, and `rn-leveldb` offers no synced write while LevelDB
under default options skips a damaged log record and keeps reading the records after it. The React
Native case waits on the blocked `react-native-storage-syncs-once-rn-leveldb-can`, the binding
change; the `NOTE:` at `durability` on `LevelDBJournalStore` records it, and the `NOTE:` at
`durability` on `IndexedDBJournalStore` the browser case.

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

- `StorageRepo` ends each write group with one flush, in
  `packages/db-p2p/src/storage/storage-repo.ts`: `cancel`, `recoverBlock`,
  `saveReplicatedBlock`, `deleteReleasedBlock` and a `get` that entered a block write latch (a
  read-driven promotion, or a coverage restore) through `endGroup`, and `pend` and `commit`
  through `applyInOneGroup`. The flush runs after the group's latches are released,
  so a concurrent group on the same blocks is not held behind the disk and several groups can
  share one sync, and before the group's change events. A group whose work throws is flushed
  before the error propagates, strictly whatever window it was given, and one fanned out per
  block (`get`, `cancel`) first waits for every block to settle, so the flush covers a sibling
  block still writing when another failed; a flush that rejects after the work returned makes
  the call throw and emit nothing. A `get` that took no latch does not flush, so the plain
  read path costs nothing extra, and neither does a `pend` the validation hook refused, which
  reaches no block's latches.

  **One group may span several applies of one consensus record.** A write over several
  collections travels as one pend record and one commit record, each carrying one operation per
  collection, and a machine applying such a record would otherwise flush once per collection —
  2N flushes for N collections where the record allows 2. `applyInOneGroup`
  (`ILocalApply.applyInOneGroup`) is the group a caller runs its whole loop inside: every `pend`
  or `commit` the loop makes takes and releases its own request's block latches exactly as a lone
  call does, the group flushes ONCE when the loop is done, and each request's post-flush steps —
  the pend group note, the HLC `stored` mark, the collection change events — run after that
  flush, in request order. `pend` and `commit` are groups of one through the same path, so a lone
  apply and a batched one share one implementation. The five callers are
  `CoordinatorRepo.applyPendsInOrder`, `CoordinatorRepo.applyCommitsInOrder` (its solo commit),
  `CoordinatorRepo.applyCommitsAfterConsensus` (its fallback commit) and
  `ClusterMember.applyConsensusPends` / `applyConsensusCommits`; each keeps its own control flow
  (the coordinator stops at the first refusal, the member applies every operation and reconciles
  its own divergences), so only the flush and the deferred steps move. The method is optional on
  the `ILocalApply` seam, and the free function `applyAsOneGroup` in the same file is the one place
  the absent case is written: a repo without the method — a plain `IRepo` test double — runs the
  same loop body against a handle that forwards each request on its own, and so keeps one flush per
  request. No caller probes for itself. A behind-reconcile a member's commit triggers lands its block
  through `saveReplicatedBlock`, whose own strict flush runs inside the record's group and so
  hastens the group's earlier writes; that is the rare path and is left as it is.

  One consequence worth knowing: the group writes storage WITHOUT going through `pend` or `commit`,
  so a wrapper put on either of those methods of a live `StorageRepo` — a spec's fault injection, a
  gate that makes one collection's apply lag — is walked straight past on the batched path, and the
  spec stops reproducing the fault it set up. Such a wrapper has to cover `applyInOneGroup` too;
  `packages/db-p2p/test/support/intercept-commits.ts` does that for commits, and
  `packages/quereus-plugin-optimystic/test/two-node-index-wake-consistency.spec.ts` does it for its
  own gate. A repo DECORATOR is not exposed to this: it does not carry `applyInOneGroup`, so
  `applyAsOneGroup` falls back to its own `pend` / `commit`.

  Which groups carry a window. `pend` and `commit` take a third argument, `StorageApplyOptions`
  in `packages/db-p2p/src/storage/storage-repo.ts`, whose `syncWithinMs` is the group's
  `withinMs`; absent, the group is strict. One group, one window: a record's collections all
  carry the window the record's cohort allows, which they did individually before they shared a
  group. A node passes a window only for an apply that runs
  on a consensus record — `ClusterMember.applyConsensusOperations` for the pend and commit of
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
(`packages/db-p2p/src/cluster/persistent-transaction-state-store.ts`), which every serving node
builds over its own key-value store, writes without waiting and promises nothing before
it replies, so it is not flushed. Over `WriteGroupDriver` both wait in memory, like every other
write, until the next group's flush or the driver's idle flush, whichever comes first.

**Visible before durable (accepted).** Between a write resolving and its group's flush,
readers in this process can see it, and through them other machines. What a read can expose
is consensus-decided content or a pending record, and what a crash takes back is always a
later suffix of the resolved writes (rule 3): a vote built on a record's absence stays valid
when the record is lost, and one built on its presence was a refusal. Likewise a second group
on the same blocks can read the first's writes before they are durable and build on them;
its own writes resolved later, so under rule 3 they cannot survive without the first's. A group
spanning a record's collections widens that span from one apply to the record's whole apply, on
the same argument and with the same two exposures: consensus-decided content, and a pending
record.

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
| `pend` and `commit` of a consensus record, applied by `ClusterMember.applyConsensusOperations` | `w` for the record's cohort |
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
| React Native LevelDB (`LevelDBJournalStore`) | `'process-crash'` until `rn-leveldb` can sync a batch, then `'power-loss'` | survives at once; a group not yet flushed is lost whole, never in part | survives whenever the operating system writes it out; the window cannot be kept, and the node says so at start. Once the binding can sync: as the browser row with strict transactions |
| Browser IndexedDB (`IndexedDBJournalStore`) | `'power-loss'` where the browser honours strict transactions (every current release), else `'process-crash'` | survives at once | with strict transactions: survives once its window has passed, at once for `w = 0`; a power cut inside the window takes the most recent groups whole, a prefix surviving. Without: as LevelDB |
| NativeScript SQLite (`SqliteBatchBackend`) | `'power-loss'` | survives at once | survives once its window has passed, at once for `w = 0`; a power cut inside the window takes the most recent groups whole, a prefix surviving |
| Memory (`MemoryStoreDriver`) | `'none'` | lost | lost |

The React Native row changes when the blocked `react-native-storage-syncs-once-rn-leveldb-can`
lands, and
[docs/correctness.md §1.2](../../../docs/correctness.md#12-nodes) with it. The browser row rests
on what a browser does with `durability: 'strict'`; nothing in this repository cuts the power, so
the package's tests check which durability each transaction asked for and no more.

### 7. An identifier reaching a backend names a location inside the store

Three names reach a storage backend from whoever originated a write — a peer on the other side of the network included — and each is spelled straight into a location. The **block id** is used by the filesystem backend **raw as a relative path**: the block `default/app/Ledger` lives in `<store>/default/app/Ledger/`, and nested, human-named collection ids like that are deliberate and must keep working. The **action id** — the name of one write — is used by that backend **raw as a filename**: a pending, committed or materialized record is `<store>/<blockId>/pend/<actionId>.json` and its two siblings. The **revision number** is a filename there too (`revs/<rev>.json`, `proofs/<rev>.json`) and is written by the LevelDB backend as an unsigned fixed-width key suffix. What must not reach a backend is a name that means somewhere else:

> An identifier that reaches a `RawStoreDriver` — block id, action id, revision number — names a location inside the store, and the node refuses the request before any driver is touched if it does not.

Each of the three has its own shape, because each is spelled into a different thing, and each is stated once beside its own type:

- **A block id** is a non-empty string, free of control characters and of backslashes, not starting with a Windows drive prefix, and every one of its `/`-separated segments is non-empty and is neither `.` nor `..` — `isValidBlockId` (`packages/db-core/src/blocks/block-id.ts`), beside the reason each clause is there. The backslash clause is a win32 path separator, the drive-prefix clause is an id that means two different places on the two platforms, and the segment clause rejects both escape (`..`) and aliasing (`a//b`, `./a`).
- **An action id is ONE path segment**, not a path: a non-empty string with no control character, no `/` or `\`, not `.` or `..`, and **no `%`** — `isValidActionId` (`packages/db-core/src/collection/action-id.ts`). The `%` clause is the aliasing one: the filesystem backend percent-encodes a colon for Windows (`:` → `%3A`) and decodes it back, which is injective only while `%` itself cannot appear in an id — otherwise `tx:a` and `tx%3Aa` are two ids sharing one file. It is deliberately a containment rule and **not** a charset: `~proof:5` and `tx:café—🔒—Ω` are ids the system stores today, so a charset would refuse real ids.
- **A revision number** is a non-negative safe integer — `isValidRevision` (`packages/db-core/src/blocks/revision.ts`). One predicate closes both spellings: a non-integer (`'../escaped'`, `NaN`, `1.5`) names a path segment elsewhere on the filesystem backend and throws out of `BigInt()` on the LevelDB one, and a negative throws out of `setBigUint64`, which takes unsigned.
- **One length bound covers all three**, `MAX_STORED_ID_LENGTH` (1024 UTF-16 code units, in `block-id.ts`). Without it a name of tens of thousands of characters — which fits comfortably inside the 8 MiB message cap — builds a path over the 65535 bytes the write-ahead log's record format can hold, and the encode throws from inside the commit. The constant states its headroom arithmetic against that cap.

**Where it's enforced:** `KvRawStorage` (`packages/db-p2p/src/storage/kv-raw-storage.ts`), which calls the three asserts through its `checkedId` / `checkedActionId` / `checkedRev` helpers on every method that takes one of the three — reads included, so a name outside the store cannot be read either. That is the single enforcement point: every shipping backend extends this kernel (the `implements IRawStorage` check in its class comment), so no node path reaches a driver around it, and every key and path builder below is free to trust the names it is given. The check sits ABOVE the write group on purpose: a throw from inside a `commit` is a storage fault and latches the store failed (rule 5 of the flush contract under Invariant 6), so refusing the name before the driver records anything rejects that one call and leaves the store usable. `saveRevision` also checks the action id it is handed as a *value*, because `materializeBlock` reads a revision record and then asks for the materialization under the id it found — so an unchecked id written there is one a later read turns into a path.

Two guards remain below it, each for its own reason and neither a second owner of a rule. `FileBatchBackend`'s `blockPath` still refuses an escaping block id, because `deleteBlock` removes that directory recursively and the blast radius — the store root, the write-ahead log and the lock — justifies belt and braces for a backend driven without the kernel. And `FileWriteLog`'s `applyBatch` (`packages/db-p2p-storage-fs/src/file-write-log.ts`) refuses a *recorded relative path* that does not resolve inside the store. That one is now unreachable on the live commit path, which is what makes latching the right reaction if it ever fires there; what still reaches it is a **replay**, of a store written by a build from before these checks (a log is replayed on every open until a checkpoint truncates it, so an escaped record would otherwise be re-applied after every restart) or of a log damaged or forged on disk. Such a record ends the replay where it sits, exactly as a record the decode cannot trust does, and the store opens and serves normally.

**Violate it and** there are three distinct harms, all measured on this build by driving `FileRawStorage` over the real backend.

- **A peer chooses where this node writes, or stops it writing at all.** `StorageRepo` builds a `BlockStorage` for whatever id a request names, so a peer naming a block `../escaped` made this node write a file outside its own store — anywhere the process has permission to write. Once the write-ahead log's containment guard was added the bytes stayed inside, but the throw is on the live commit path, so a *pend under an action id* `../../../escaped` latched the store instead: the next ordinary write, and `close()`, failed with the same storage fault. That is recoverable, not permanent — reopening the directory ends the replay at the escaped record and the store then serves and takes new writes, and records already applied to the tree survive — so the harm is "one request stops this node's storage until the process is restarted, losing the faulting batch and anything a concurrent store over the same directory appended after it". A name over the log's 65535-byte path field does the same thing by a different route, which is why the length bound is shared.
- **A peer reads a file from outside the store.** Reads never touch the write-ahead log, so its guard is not on that path at all: a record's path is the (checked) block path joined with the unchecked name. `getPendingTransaction`, `getMaterializedBlock`, `getRevision` and `getProofEntry` under the action id `../../../OUTSIDE-SECRET` each returned the contents of a `.json` file beside the store, and the commit path reads a pending record by the request's own action id. This is why the enforcement covers reads, exactly as the block id's does.
- **A legitimate write becomes invisible to the node's own bookkeeping.** This one needs no crafted input. The filesystem backend's pending listing used to filter decoded filenames through a charset of its own (`^(?:tx:|stamp:)?[A-Za-z0-9_-]+$`), narrower than what the system actually writes: `~proof:5` and `tx:café—🔒—Ω` were both written to `pend/` and then skipped by the listing, so a later `pend` that should have conflicted with such a record could not see it. An action id carrying `/` was the quieter version — `a/b` became a directory holding `b.json`, listed as nothing — and `tx%3Aa` silently overwrote `tx:a`'s record while the listing reported an id that was never pended. The listing now applies `isValidActionId`, the same predicate the write path does, so a record this backend wrote is a record it lists; it is still not a total accept, because junk in `pend/` must not read as a phantom pending.

**What this invariant still does not reach.** It is about the three identifiers, and deliberately not about what a writer may *call* its write beyond "it must not name somewhere else, and must not alias another id": no prefix is reserved and no format imposed, so a storing node still never re-derives an action id, which is why commit proofs keep their own keyspace rather than a reserved action-id prefix (`getProof` in `packages/db-p2p/src/storage/raw-store-driver.ts`) and why `~proof:5` is still a legal action id. The commit-proofs store needs nothing here: its key is a message hash re-derived from a verified proof, and `commitProofRelativePath` percent-encodes every character outside `[A-Za-z0-9_-]`, `%` included, so no key can name a path outside the store. The rule applies to a name arriving at the kernel, not to a filename already on disk: files written by an older build stay readable, including through the raw-colon read fallback, and nothing is renamed.

An id that aliases another block's *store* directory — `x/revs`, or `x/blocks/y` where `x` is also a block — is inside the store and passes the rule; those are the separate limits of the raw-id layout noted at `BLOCK_STORE_DIRS` and on `deleteBlock` in `packages/db-p2p-storage-fs/src/file-batch-backend.ts`. Retiring them means encoding block-id segments in the layout, which would change every on-disk store.

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
- `deleteBlock(latch)`: Removes everything this node holds for the block — the only operation that
  takes bytes back off a node, for a block it has stopped being responsible for (Invariant 2,
  *Deleting a block*)

### 3. Raw Storage Interface (`IRawStorage`)

The `IRawStorage` interface defines low-level storage operations, abstracting the physical storage mechanism.

**Responsibilities:**
- **Metadata Management**: Block metadata and revision tracking
- **Transaction Storage**: Both pending and committed transactions
- **Block Materialization**: Storing and retrieving materialized blocks
- **Revision Management**: Mapping revisions to transaction IDs
- **Removal**: `deleteBlock(blockId)` takes a whole block off the store; nothing else removes
  anything of a block's (Invariant 2, *Deleting a block*)
- **Durability**: `flush()` makes every write resolved before it survive the crashes the store's fixed `durability` names (Invariant 6 above)

**How much room is left.** Beside `getApproximateBytesUsed`, a block store may report `getApproximateBytesFree()` — the bytes its LOCATION will still accept, by the backend's cheapest honest measure. It is the location's figure and not this store's share of it, so every store over one location answers the same number, which is why anything accounting for a node's room asks the block store and nobody else. Two rules make it safe to read: a failed measurement **rejects** rather than answering 0 (0 means "full", and a transient failure read as full would make a node shed responsibility it did not need to shed — a consumer catches and treats the figure as unknown for that scan), and whether a store has the method at all is fixed at construction, so a backend that cannot ask its platform omits it entirely rather than installing a stub. Which backends have one:

| Package | Free space | How |
|---|---|---|
| `@optimystic/db-p2p-storage-fs` | yes | one `fs.promises.statfs(basePath)`: the blocks available to an unprivileged process times the block size — the whole filesystem holding the directory |
| `@optimystic/db-p2p-storage-web` | yes, in a browser | `navigator.storage.estimate()`, `quota - usage`; origin-scoped exactly as its used figure is, so the two agree. Omitted when the platform has no `navigator.storage.estimate` (Node under `fake-indexeddb`, which is how the package's specs run), and rejects when the estimate carries no quota |
| `@optimystic/db-p2p-storage-ns` | no | the package is handed an open SQLite database, not a path, and NativeScript offers no free-space call reachable from a database handle |
| `@optimystic/db-p2p-storage-rn` | no | the package is handed an open LevelDB handle, with the same gap |
| memory | no | there is no disk; the free space of a `Map` is the heap, which is not a storage allotment — the same reason a memory store reports no store identity |

A host on a platform that cannot answer supplies the figure itself, the way it supplies any other thing about the machine the node is running on.

### 4. File-based Storage (`FileRawStorage`)

`FileRawStorage` in `packages/db-p2p-storage-fs/src/file-storage.ts` is the shared
`KvRawStorage` kernel over a `WriteGroupDriver` over a `FileBatchBackend`
(`packages/db-p2p-storage-fs/src/file-batch-backend.ts`), which lays out the seven
logical stores as filesystem subdirectories and commits each write group through
the directory's write-ahead log (`FileWriteLog` in
`packages/db-p2p-storage-fs/src/file-write-log.ts`). The kernel owns JSON
(de)serialization on top; the driver holds each group in memory until its flush;
the backend appends the group to the log with one sync, writes the tree, and
replays the log on the next open; a checkpoint syncs the tree and discards the
log in the background, and on the last close. The constructor is synchronous; the first
operation takes the directory's lock and replays. How the log holds Invariant 6
is under *The file backend* there. See "Shared KV Kernel" below.

Beside the block tree, `FilePieceStore` (`packages/db-p2p-storage-fs/src/file-piece-store.ts`)
keeps blob pieces under `optimystic-pieces/`, one file per piece, outside the write-ahead log. The
block listing skips that directory, and the block store's byte figure counts it.

### 5. Shared KV Kernel (`KvRawStorage` + `RawStoreDriver`)

`KvRawStorage` implements the full `IRawStorage` surface once, on top of a
`RawStoreDriver`. The driver exposes each backend's seven logical stores
(metadata, revisions, pending, transactions, materialized, proofs, commit proofs) as maps of
stored values over its native mechanism; the kernel owns all value (de)serialization (JSON via
`raw-store-codec.ts`) and call orchestration. Backends therefore never
(de)serialize values — they only lay out keys and move values.

Six of the stores are filed under a block. The seventh, **commit proofs**
(`RawStoreDriver.getCommitProof`, `IRawStorage.getCommitProof`), holds one `BlockCommitProof` per
consensus message, keyed by the proof's `messageHash` alone, so a proof covering many blocks can be
stored once rather than once per block in the proofs store. Each backend gives it a keyspace of its
own: a map, a root `commit-proofs/` directory, a `commit_proofs` table, the LevelDB tag byte `0x08`
with no block envelope, a `commitProofs` object store. It has no delete, and `deleteBlock` (Invariant
2, *Deleting a block*) empties the other six and leaves this one alone: a key names a message, not a
block. The
file backend names a file after the hash, which `computeClusterMessageHash` in
`packages/db-core/src/cluster/membership.ts` writes in base58 and so needs no encoding; it
percent-encodes any other character, so no key names a path outside the store.

The kernel composes the two proof stores. `saveBlockProof` stores the proof in the commit proofs
store under its `messageHash` (keeping one already there), then writes the revision's proofs-store
entry as a reference to it, `{ proofRef: messageHash }` (`ProofRef` in
`packages/db-p2p/src/storage/i-raw-storage.ts`); target before reference, so a crash keeps no
reference without its target. `getBlockProof` resolves the reference, answering no proof (and
logging `proof-ref-dangling`) when the target is missing, and returns an entry holding a whole proof
— every entry an earlier build wrote — as it is. A memo of up to 1024 message hashes the kernel has
stored (`KvRawStorage.storedCommitProofs`) makes a commit of N blocks read and write the shared
record once rather than N times. `getProofEntry` and `saveProofEntry` move a revision's entry as it
is, with no commit proof read or written: `RawStorageDriverAdapter` maps the driver's proofs store
onto them, so a cache composed over an `IRawStorage` passes references through rather than resolving
and re-expanding them, and `IBlockStorage.hasBlockProof` answers presence from the entry alone. See
[docs/internals.md §Durable commit proof](../../../docs/internals.md#durable-commit-proof-blockcommitproof)
for why, and what it measured.

**How a value is held in memory is a type parameter.** Values cross the driver as `V`
(`RawStoreDriver<V>`, `StoredValue` in `packages/db-p2p/src/storage/raw-store-codec.ts`):
`Uint8Array` by default, or `string`, the text the stored UTF-8 bytes decode to — the same logical
value, for a backend whose platform decodes text natively and so never needs a JavaScript
`TextDecoder` (React Native's LevelDB binding; Hermes has no native one). Every existing driver is a
`RawStoreDriver`, which is `RawStoreDriver<Uint8Array>`. The representation is chosen once per
composition with a `ValueCodec` — `bytesValueCodec` or `textValueCodec` in the same file — which
encodes and decodes the JSON and the action id and says what a value costs: `storedBytes` (on disk,
pacing a write group's `maxUnsyncedBytes`), `residentBytes` (in memory, charged to the read cache's
pool) and `toBytes`. A composition is homogeneous: a text kernel over a text cache over a text write
group over a backend whose reads return text, and the type checker refuses any mix. Nothing branches
on the representation at run time. A bytes composition may leave the codec out of every constructor
(`new KvRawStorage(driver)` is unchanged); any other representation must name it, or the call does
not compile (`ValueCodecArgument`, same file).

**Text becomes bytes in one place.** `WriteGroupDriver<V>` holds `V` in its overlay and hands each
sealed group to its `BatchBackend` with every value converted by `toBytes` (the identity for bytes).
A `BatchBackend<R>`'s reads return `R`, but its writes — `commit` entries, and so a
`JournalBatchBackend`'s journal records — are always bytes. So what lands on disk is the
`TextEncoder` output a bytes composition writes, byte for byte, and a text composition reads data
any earlier release wrote with no migration. Strings are deliberately not handed to the engine
directly: `TextEncoder` normalises an ill-formed string (an action id can hold a lone surrogate) to
U+FFFD, where an engine's own conversion may not, and `TextEncoder` is native in Hermes, so there is
no measured saving to buy with that risk.

**The React Native backend is the one text composition.** `LevelDBRawStorage`
(`packages/db-p2p-storage-rn/src/leveldb-storage.ts`) is `KvRawStorage<string>` over
`CachedStoreDriver<string>` over `WriteGroupDriver<string>` over `JournalBatchBackend<string>` over
`LevelDBJournalStore`, whose two value reads, `get` and `rangeRevisions`, ask the binding for text
decoded in native code (`getText` and `textIterator` on `LevelDBLike` in
`packages/db-p2p-storage-rn/src/leveldb-like.ts`, over `rn-leveldb`'s `getStr` and `valueStr`). Before
it, every block, transform, metadata, proof and revision read on a phone ran Hermes's JavaScript
`TextDecoder` polyfill, measured as the largest single cost of an offline save on an older phone
(GitHub #51). Keys stay bytes — a key is a tag byte, a binary length and an id, not valid UTF-8 — so
the listings and the journal's recovery read still decode in JavaScript. Its read cache is built
in rather than left to the node: a cache `withReadCache` adds fronts the storage through the
bytes-only `RawStorageDriverAdapter`, so each cold read would decode, re-encode and decode again, in
JavaScript both times. `LevelDBRawStorage` reports `readCached`, so the node and the Quereus plugin
pass it through (*Wiring*, under *Write-through raw-storage cache* below).

Because a get always decodes a fresh object (JSON-decode on read) and a save always stores an
independent copy (JSON-encode on save; bytes are never written to after encoding, and a string is
immutable), every read yields a fresh object *by construction*. The `structuredClone`-on-every-get/put
discipline the old in-memory backend needed is now structural, not a rule — see
docs/internals.md "Storage Returns References". `promote` (pending → committed) is
the only cross-key atomic operation the kernel requires; each backend satisfies it
with its native atomic primitive (batch / DB transaction / one write-ahead-log record).

`deleteBlock` is the one driver operation the kernel does not compose out of per-key calls, and the
one `BatchBackend` write that is not a batch entry: the kernel cannot enumerate a block's revisions
(`rangeRevisions` is a bounded scan, and the top revision is only knowable from the very metadata
the operation removes), while every backend has a cheap native answer for "everything under this
block" — a directory removal, six `DELETE … WHERE block_id = ?`, six tag ranges, six object-store
key ranges. What it must and must not touch, and the ordering it owes, are under Invariant 2,
*Deleting a block*.

Every shipping backend uses this kernel today: in-memory (`MemoryStoreDriver`) supplies only a
driver, the filesystem and NativeScript SQLite backends each supply a `BatchBackend`
(`FileBatchBackend`, `SqliteBatchBackend`) under `WriteGroupDriver`, and IndexedDB and LevelDB
each supply a `JournalStore` (`IndexedDBJournalStore`, `LevelDBJournalStore`) under
`JournalBatchBackend` under `WriteGroupDriver`. A shared conformance suite (`src/testing/raw-storage-conformance.ts`,
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
│   │   ├── {rev}.json      # Reference to the commit proof retained for that revision (a whole proof, if an earlier build wrote it)
│   │   └── ...
│   └── blocks/
│       ├── {actionId}.json # Materialized blocks
│       └── ...
├── commit-proofs/
│   ├── {messageHash}.json  # Commit proof stored once under its consensus message's hash
│   └── ...
└── ...
```

### 6. Write-through raw-storage cache (`CachedStoreDriver` + `CachedRawStorage`)

`CachedStoreDriver` wraps any `RawStoreDriver` with an in-memory, **write-through
coherent** cache of encoded values, held in the driver's representation (§5: bytes by default,
text for a text composition) and charged to the pool at the codec's `residentBytes`. Every save
stores its encoded value *into*
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
    — wraps the `blocks` store of the host's `storageFactory` result, label
    `quereus:local`.
  - `resolveStorage` (`src/libp2p-node-base.ts`) — wraps the `blocks` store of
    `NodeOptions.storage` (§8 below), label `node:<networkName>`. The memory
    default from `memoryNodeStorage()` is a bare `MemoryRawStorage` and stays
    unwrapped.

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
  cache over a directory, while a second consumer's `storageFactory` returns
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
  and hands it in as the `blocks` store of the Quereus plugin's `storageFactory` or of
  `NodeOptions.storage`, may hand over *either* shape — the seam detects both via `readCached` (above), returns it
  unchanged with no lease, and the host keeps owning it. The driver-level form
  stays the recommended one whenever the driver is reachable; requiring the
  storage-level form at a seam would force exactly the hosts that *have* a driver
  into the strictly worse composition.
- **A backend may build its cache in.** `LevelDBRawStorage` composes its own
  `CachedStoreDriver<string>` (*The React Native backend is the one text
  composition*, under *Shared KV Kernel* above), taking the pool and label as its `readCachePool` and
  `readCacheLabel` options, so it reaches every seam already cached and passes
  through with no lease; its `close()` releases the registration. The host
  closes it, as it would any storage it built.
- **Never wrap `MemoryRawStorage`/`MemoryStoreDriver`** in production wiring:
  the memory driver already holds the same byte references, so the cache is
  pure bookkeeping overhead (tests do wrap it, to prove semantics match).

### 7. Blob pieces and records

A node keeps large values ("blobs") outside the block store, in two places: their pieces in an `IPieceStore` (the `pieces` of `NodeOptions.storage`, §8 below; `FilePieceStore` on a Node host, `SqlitePieceStore` on NativeScript, `IndexedDBPieceStore` in a browser, `LevelDBPieceStore` on React Native, `MemoryPieceStore` by default), and one record per held blob in the node's key-value store (its `kv`, keys under `optimystic-blobs/`). `LocalBlobService` in `packages/db-p2p/src/blob/local-blob-service.ts` writes both and is the node's `node.blobs`, on a serving node and a client alike. The design, and what each store must promise, is [docs/blobs.md §The local store](../../../docs/blobs.md#the-local-store).

A put keeps one ordering across the two stores: every piece is stored and the piece store flushed, and only then is the record naming the pieces written and the key-value store flushed. So a record that survives a crash never names a piece the crash lost, and pieces a crash left without a record are removed by the sweep the service runs after it starts. The piece store keeps no prefix rule of its own (pieces are independent), which is why the ordering is the caller's.

The node never closes the piece store, as it never closes the block store or the key-value store it was handed: a host closes it after `stop()`. The node's storage account counts its bytes toward the node's use, once (`blockStoreCountsPieces` in `packages/db-p2p/src/storage/store-coverage.ts`, and §9 below).

### 8. A node's storage, as one value

A node persists three kinds of thing, and takes all three as ONE option: `NodeOptions.storage`, a `NodeStorage` (`packages/db-p2p/src/storage/node-storage.ts`) with a `blocks` (`IRawStorage`), a `kv` (`IKVStore`) and a `pieces` (`IPieceStore`). Every storage package builds its three stores over one location anyway — `FileRawStorage`, `FileKVStore` and `FilePieceStore` over one base path; the SQLite, IndexedDB and LevelDB stores over one open database handle — so one value is what a host actually has, and there is no longer a field it can forget. The reason it is one value and not three options is that each of the three used to default to memory on its own: a host that supplied a block store and nothing else silently got a memory key-value store and memory pieces, and lost blob records and blob pieces at every restart with only a warning in a log.

Which parts each role uses:

| Part | Serving node | Client (`servesBlocks: false`) |
|---|---|---|
| `blocks` | yes — block revisions and their commit proofs, behind the read cache (§6) | never read; it stores no blocks for anyone |
| `kv` | yes — the blob records, the owed-blob, under-replication and released-block ledgers, the HLC clock's high-water mark, the node's transaction state (each prefix in `NODE_KV_NAMESPACES`) | yes — the high-water mark, the blob records and the owed-blob ledger |
| `pieces` | yes | yes — a client is often the only machine holding a blob its host put |

`blocks` is required on both roles so that one value serves either and a host that changes the role changes one flag; an unused block store over a location the node already holds costs nothing, since every backend's constructor is lazy. There is no field for the transaction-state store: the node builds that over `kv` (`PersistentTransactionStateStore`), so the rule for it is stated once and holds on every platform.

With `NodeOptions.storage` absent the node uses `memoryNodeStorage()` and logs one `node-wiring` `WARN:` line naming everything it is then keeping in memory and what is lost with each. The test is the PRESENCE of the option, not the durability of the stores behind it — so a host that passes `memoryNodeStorage()` has said it meant the memory case and gets no warning. A host may still hand-build a value whose parts disagree (a `FileRawStorage` beside a `MemoryKVStore`); that is silent, because `IKVStore` reports no durability for the node to read. The start-up durability line (`logStorageDurability`, serving nodes only) is a separate, factual report about `blocks` alone.

The node closes nothing it was handed. A platform factory returns an `OpenNodeStorage` — a `NodeStorage` with a `close` — and the host calls that after `stop()`.

**Every storage package opens the whole of it in one call,** named for its backend so a host that imports two packages gets two distinct names: `fileNodeStorage` in `packages/db-p2p-storage-fs/src/node-storage.ts` over one base path, `sqliteNodeStorage` in `packages/db-p2p-storage-ns/src/node-storage.ts` over one open SQLite database, `indexedDbNodeStorage` in `packages/db-p2p-storage-web/src/node-storage.ts` over one open IndexedDB handle, `levelDbNodeStorage` in `packages/db-p2p-storage-rn/src/node-storage.ts` over one open LevelDB handle, and `memoryNodeStorage`, which needs no location. Each builds that package's three stores over the one location with their existing defaults, asserts that all three stores report ONE store identity before it returns — `assertOneMeasuredLocation` in `packages/db-p2p/src/storage/store-coverage.ts`, one helper beside the predicate the account itself reads — so everything the node stores is inside the one location the block store measures whole, by construction rather than by coincidence. Each half of that would fail differently and silently: pieces outside the measured location get counted twice (§7), while a key-value store outside it is counted not at all, since `IKVStore` deliberately reports no bytes of its own — in every shipping backend its records are inside what the block store measures, so a figure of its own would have no consumer, and this assertion is what keeps that true. A backend that ever did keep its key-value store elsewhere would have to give it a `bytesUsed`; the assertion refuses the layout on the first open until it does. The factory also gives back a `close` that releases what it opened and nothing else: the filesystem factory closes the piece store, the key-value store and then the block store, whose close checkpoints the directory's shared log and removes its lock, while the three handle-taking factories close or flush whichever of their stores still owes durability — the SQLite one flushes its piece and key-value stores, neither of which has a `close`, before closing the block store — and leave the handle to the host that opened it. A caller that wants one store on its own still constructs it directly.

For files, where the location is named by a path rather than held as an object, `fileNodeStorage` additionally keeps **one set of stores per directory** in the process — keyed by the same resolved identity the directory's log registry uses — and counts its callers, closing the stores when the last one closes. Two `FilePieceStore`s over one directory are not supported at all (the second's open deletes the first's in-flight temps and fails its next put), unlike the block store and the key-value store, which are designed for several instances over one shared log and lock; making one directory mean one set turns that documented hazard into an unreachable one. The consequence for a caller that is not an ordinary host is the same shape as a read-cache lease (§6): a `close` by a caller that is not the last releases nothing, so code that needs two independent sets over one directory keeps constructing the three stores itself — `packages/upgrade-check/test/current-build.ts`, whose `fs` layout is two directories anyway, and the specs that read one set's flushed writes from a cold start.

### 9. A node's allotment and what counts against it

A node has ONE opinion about how full it is, and `StorageAccount` (`packages/db-p2p/src/storage/storage-account.ts`) is it. One per node, built on either role from `NodeOptions.storage` and `NodeOptions.storageAllotment`, reachable as `node.storageAccount` — so ring selection, the blob cache budget and an operator's dashboard read one measurement instead of each forming its own.

**The one option.** `NodeOptions.storageAllotment.bytes` is how many bytes of this machine the operator gave the network. It sits at the top level of the options, beside `storageDurability` and not under `arachnode`, because it is about this machine's disk rather than about ring membership: a client node fills the same disk with blob records, blob pieces and the owed-blob ledger, and gets an allotment and an account exactly as a serving node does. Anything but an integer above 0 throws at node construction rather than being clamped, the rule `blobs.cacheBudgetBytes` follows — an operator who meant 10 GB and typed something else is told, not quietly given a different figure. Absent is a value, not a mistake: it means "as much as the disk has".

**Two doors to it.** A host that builds its own node passes the option directly. A host whose node is built for it by the Quereus plugin — a table on a `network` transactor — passes the plugin-level `storage_allotment` instead, which is this option by another name and is handed to that node whole (*Plugin-Level Configuration* in `packages/quereus-plugin-optimystic/README.md`). The plugin checks the SHAPE of what it was given and refuses an unknown key rather than dropping it, since a dropped key would reach the node as no allotment at all; the numbers below are refused here, at node construction, for both doors alike.

**The effective total** is the smaller of two figures over whichever are present (`effectiveTotalBytes`), and it is `undefined` when neither is:

| Allotment | What the location reports free | Effective total |
|---|---|---|
| set | reported | the smaller of the two |
| set | none | the allotment |
| absent | reported | the measured use plus the free space |
| absent | none | **unknown** |

So an allotment larger than the disk is bounded by the disk, and an operator's over-promise is never believed; a disk larger than the allotment is bounded by the allotment, so the node keeps to what it was given.

**One figure covers all three stores.** `usedBytes` is the block store's `getApproximateBytesUsed` plus the piece store's `bytesUsed()`, the latter left out when `blockStoreCountsPieces` says the block store already measured the pieces. Nothing is added for the key-value store or the node's transaction state, and nothing needs to be: every platform factory has asserted its three stores live inside the one location the block store measures whole (§8, `assertOneMeasuredLocation`), so that single figure IS the whole of what the node stores. `usedBytes` is **unclamped** — a node past its allotment reports more used than its total, which is the signal a consumer acts on, so every consumer must tolerate it. `availableBytes` floors at 0 instead.

**Which backends report free space.** The filesystem store always does (`statfs`). The browser store does where `navigator.storage.estimate()` can be asked, which is not under Node. The SQLite and LevelDB packages are handed an open handle with no path to ask about, and a memory store's "free space" is the heap, which is not a storage allotment — all three report none, and so a node on one of them has a total only if the operator configured an allotment.

**Cost and cadence.** One `capacity()` call costs one block-store scan (a directory walk, a `PRAGMA`, an origin estimate or a key iteration, depending on backend), one free-space call, and on a hand-built or memory storage the piece store's figure. All of it sits behind one memo of `storageAllotment.usedBytesCacheTtlMs` (default 60 s) with single-flight, because ring selection asks several times per operation. Both figures are read inside the SAME memoized scan, so the use and the free space can never come from different moments. A free-space read that REJECTS is caught, logged once for that scan, and leaves the location figure — and therefore the location's half of the total — unknown for that scan; never 0, because 0 means "full" and a transient failure read as full would make a node shed responsibility it did not need to shed (`IRawStorage.getApproximateBytesFree`).

**What the bytes ARE.** `capacity()` answers how full the node is; `breakdown()` answers what is filling it, which is what an operator needs before reacting (it is for an operator's dashboard and for `logRingInfo` in reference-peer; nothing calls it yet, and nothing on a hot path is to). `StorageBreakdown` carries the whole capacity above plus three figures, each absent when the node genuinely does not know it:

| Figure | What it is |
|---|---|
| `pieceBytes` | The piece store's own `bytesUsed()`, whether or not it was added to `capacity.usedBytes` — a block store that measures the pieces' location leaves it out of the total but the figure is still reported here. Absent when that read failed. |
| `blocksAndBookkeepingBytes` | The blocks and the node's own bookkeeping (its key-value store and its transaction state) TOGETHER: the measured use less `pieceBytes`, floored at 0. Absent when either half is unknown — a block store that measures nothing leaves this unknown rather than 0. |
| `blobBytesByHold` | What each blob hold accounts for (`LocalBlobService.bytesByHold`): one `HoldBytes` per hold kind, each the sum of the records' `size` plus a count of the records carrying no size at all. Absent when the account was given no blob records — a node whose blob service is not built yet has measured nothing *yet*, which is not the same as having measured nothing. |

**The blob attribution is an attribution, not a measurement.** Each blob is counted ONCE, under the one hold that keeps it, by precedence `pin > owed > responsible > cached` — strongest reason first, so a blob carrying both `responsible` and `cached` (the ordinary state of a blob pulled for an announcement) appears only under `responsible`, and the `cached` figure is exactly the bytes the cache budget can actually free. It **over-counts** in two ways the cache budget already accepts ([docs/blobs.md §Lifetime](../../../docs/blobs.md#lifetime)): pieces are shared between blobs, so a piece in two blobs' trees counts in both, and a blob counts at its full size whether or not every piece of it is here. It therefore does **not** reconcile with `pieceBytes` and must not be presented as if it did. A record that does not decode is logged and skipped, so one bad record cannot fail a report.

**Why blocks and bookkeeping come as one figure.** No shipping backend separates them cheaply: `FileRawStorage` sizes the whole base directory in one walk, the SQLite backend multiplies `page_count` by `page_size` over the whole file, LevelDB sums entries by key range, and the web backend reads an origin-wide `navigator.storage.estimate().usage` that cannot be split at all. Three of those four could do it with a second scan — the filesystem by classifying paths, SQLite by summing per table, LevelDB by summing per tag range — and the web one could not; the `NOTE:` on the field says to build it if an operator ever asks to see blocks apart from bookkeeping.

**What `breakdown()` costs.** Everything `capacity()` costs, memoized as that is, plus up to two passes that are NOT memoized and run on no timer: the piece store's own figure when the memoized scan did not already ask for it (it asks exactly when the block store does not already measure the pieces, so the extra read is the shared-location case — `FilePieceStore.bytesUsed` is one `stat` per piece, which a scan ring selection makes several times per operation must not pay for), and one pass over every blob record. Nothing on a hot path calls it.

**The read cache is a tenant of the allotment.** The blobs a node keeps only because it read them come OUT of this one allotment rather than sitting beside it. `cacheBudgetBytes` (same module) is the rule, and it is the smallest of three figures: `NodeOptions.blobs.cacheBudgetBytes`, which is the host's **cap** and not the figure (256 MiB by default); `CACHE_ALLOTMENT_SHARE` (an eighth) of the effective total above; and what that total leaves after everything else — the total less the measured use plus the cache's own bytes, since `usedBytes` already includes those and a budget that did not subtract them would shrink itself toward 0 on every pass. Floored at 0, so a node whose other use fills its allotment evicts every cache-only blob not being read. An **unknown** total answers the declared cap unchanged: a node that cannot measure its storage keeps the flat figure, which is the only honest answer, and a memory storage therefore behaves as it always did. A measurement that cannot be READ is given that same answer by the wiring (`enforcementBudgetBytes` in `packages/db-p2p/src/libp2p-node-base.ts`, which catches a rejecting `capacity()` and logs `cache:budget-unmeasured`) rather than being allowed to reject: a rejection rejects the whole enforcement, and an enforcement that does not run leaves the cache with no bound at all, which is worse than any figure. Ring selection keeps the rejection instead, because it must not act on a figure nobody measured. An eighth is the share because 256 MiB is an eighth of 2 GiB — so the share only ever lowers the budget on an allotment below 2 GiB, a host smaller than the phone that default was written for — and because 12.5 % of an allotment cannot reach the default 85 % `shedAbove` threshold ring selection acts on (§10 below), where a larger share would have the node shedding responsibility to protect a read cache — an operator who lowers `shedAbove` below an eighth has said the node should shed that early, and the argument is theirs. The budget is asked for at every enforcement, not read once at construction, so an allotment the operator lowers is seen without a restart; the memo above means the use figure behind it may lag the cache by up to its TTL, which gives the cache slightly too much for one window and is corrected by the next enforcement.

**When a node can measure neither.** It says so at start-up in a `node-wiring` `WARN:` line, and ring selection declines to act on a figure it does not have: `RingSelector.determineRing` answers ring 0, the whole keyspace — not the deepest ring, which is what a node whose available bytes are measurably below `minCapacity` answers and a claim this node has not established — and `shouldTransition` folds nothing into its EWMA and never moves. The pressure reading of §10 reads that same absence as its `unknown` stage, and nothing acts on it. The node then advertises NO `ArachnodeInfo.capacity` at all, and `ArachnodeFretAdapter.getRingStats` leaves such a peer out of both the peer count and the capacity total, so a peer that claimed nothing is never read as claiming zero. See [docs/arachnode-ring-handoff.md § Part 1](../../../docs/arachnode-ring-handoff.md#part-1--damping-the-ring-shift-decision).

### 10. How full is too full

§9 above is the node's one MEASUREMENT. This is the one READING of it: `StoragePressure` (`packages/db-p2p/src/storage/storage-pressure.ts`), built once per node on either role beside the account, reachable as `node.storagePressure`. It reads the account and nothing else.

Without it, each reaction a node has to filling up would invent its own threshold against its own scan — which is how the two figures ring selection moved on came to be literals in the node factory, unreadable by anything else in the node and unchangeable by an operator.

**The reading is a named stage,** ordered least to most pressure, so a consumer asks "at least shedding?" (`atLeastPressure`) rather than comparing fractions of its own:

| Stage | When | What acts on it |
|---|---|---|
| `unknown` | the node cannot measure its storage: no allotment configured and the backend reports no free space, so `capacity().totalBytes` is absent | **nothing.** No eviction, no shedding, no deleting, no refusing — the node behaves exactly as it does with no pressure reading at all, and the start-up `WARN:` line of §9 already tells its operator why |
| `slack` | measured use is below `reclaimBelow` | the ring decision may move inward (`RingSelectorConfig.thresholds.moveIn`) |
| `steady` | between `reclaimBelow` and `shedAbove` | nothing |
| `shedding` | measured use is above `shedAbove` | the ring decision moves outward (`moveOut`); the read cache is enforced; the released-block sweep runs |
| `refusing` | measured use is above `refuseAbove` | everything `shedding` does, and the four refusal doors below |

`unknown` sits BELOW every acting stage in that order, which is the whole point of its place in it: "at least `shedding`" is false on a node that cannot measure itself, so an unmeasurable node is never read as full. Each threshold is **strict**, the comparison `RingSelector.shouldTransition` already made, so a node sitting exactly on a threshold is `steady` and does nothing. `usedBytes` is unclamped (§9), so a node past its allotment reads a fraction above 1.0 and lands in `refusing` — which is why every consumer of the account is already required to tolerate `usedBytes > totalBytes`.

**The thresholds are the operator's.** `NodeOptions.storageAllotment.thresholds` carries all three — `reclaimBelow` (0.40), `shedAbove` (0.85), `refuseAbove` (0.95) — beside the allotment they are fractions OF, and not under `arachnode`, for the reason the allotment itself is there: they are about this machine's disk, and a client node has an allotment and an account exactly as a serving node does. Each must be a finite number strictly between 0 and 1 and `reclaimBelow < shedAbove < refuseAbove` must hold, validated at node construction and throwing rather than clamping (`resolveStoragePressureThresholds`, the rule `storageAllotment.bytes` already follows): an operator who inverted two of them is told, not quietly given a node that sheds and reclaims at once. The validation is over the numbers alone, so it runs and throws even on a node that will read `unknown` for its whole life — a typo is a typo.

`RingSelectorConfig.thresholds.moveOut` / `.moveIn` keep their names, because "move" is that decision's own vocabulary, and the node factory FEEDS them from `shedAbove` / `reclaimBelow`. So there is one figure with two readers rather than two figures that can disagree about whether this node is under pressure, and an operator who sets `thresholds` changes both.

`refuseAbove` is deliberately **below** the allotment, and the gap is not slack. It is the headroom for pends a cohort member has already approved, for the host's own writes, and for the sampling window below.

**Two reads, and the difference is load-bearing.**

| Call | Cost | What it answers |
|---|---|---|
| `read()` | one memoized `capacity()` call | the stage now, together with the capacity it was derived from, logging one `storage:pressure` line **when the stage changed** |
| `stage()` | nothing at all | the LAST stage read, synchronously |
| `refusingNewData()` | nothing at all | whether that last stage is `refusing` — the one question the four doors below ask, so no door re-derives it from a threshold comparison of its own |
| `ownWriteRoom()` | nothing at all | whether the last sample's measured use has reached the effective total, and what it measured when it has — the HOST's own limit, which is a different one (below) |

The three synchronous answers are what a refusal gate reads: a push handler, an announce handler and a promise vote are inbound paths that must not block on a directory walk. Before the first `read()` they answer `unknown`, not refusing, and room, so a node refuses nothing until it has measured itself once.

**The cadence, and the staleness it accepts.** The reading samples itself once a minute — its own unref'd timer, outside the arachnode gate, because a client node has blobs, a read cache and an allotment too and must read its pressure whether or not FRET is present. Sampling faster would buy nothing: `capacity()` is memoized for `storageAllotment.usedBytesCacheTtlMs` (60 s by default) with single-flight, so a second ask inside the window is served the same scan. `0` is a value — scan every call, which the opt-out tests use — while a non-finite or negative lifetime throws at construction like the figures above (`assertUsedBytesCacheTtlMs`), because both of its ends fail silently: `NaN` compares false against every expiry and rescans the whole store on every tick, and `Infinity` keeps the first scan for the life of the node, which then never notices its disk filling again. The arachnode tick and the pressure timer therefore both end up on one memo, which is why there is one `StorageAccount` per node and not two.

The consequence is that between samples a node can accept up to one sample interval's inbound data past its limit. The gap between `refuseAbove` and the allotment is the headroom for exactly that, and the `NOTE:` on `stage()` says what to do if a node is ever seen well past its allotment between samples: add the bytes accepted since the last sample to the reading, rather than scanning on the gate.

A read whose scan **failed** keeps the last known stage and logs `pressure:unmeasured`; only an absent `totalBytes` from a *successful* scan means `unknown`. A one-off storage fault must not disarm the gates.

A node hovering at `refuseAbove` logs a stage change per sample. That is accepted: refusing is immediate and undamped by design, the line is one per sample at worst and only while hovering, and the ring arm keeps its own EWMA, dead-band and dwell (`docs/arachnode-ring-handoff.md` § Part 1). There is deliberately no second damping layer here.

**The read cache shrinks as the node fills.** `cacheBudgetBytes` (§9) already falls to 0 as other use fills the allotment, but `BlobCacheBudget` is enforced only after a read or fetch that pulled something — so a node filling up with blocks kept every cached blob until some read happened to arrive. A sample at `shedding` or above now requests one enforcement, which is the trigger the cache was missing. The budget figure itself needed no change.

**A full node also sweeps what it released.** The same sample asks the released-block sweep to run (*The released-block sweep*, under Invariant 2). That trigger is not what makes an ordinary shed free its bytes — the release itself asks for a run — it is what finishes whatever a previous run left: entries beyond one run's cap, and the deletes a crash interrupted. Both reactions are asked in their own `try`, so one subsystem's fault neither disarms the other nor takes the sampler down; a refusal logs `pressure:trigger-refused` naming which trigger it was.

**The four doors a full node closes.** Nothing in the node declined data on storage grounds before this: each of these four paths validated what it was given and then persisted it, so a full node accepted data until its disk refused a write and reported that refusal as something else. Each now refuses at `refusing`, reading the reading above — `StoragePressure.refusingNewData()`, the last sample and no scan at all, because all four are inbound or latency-sensitive paths.

| Door | Where | What a full node answers |
|---|---|---|
| A pushed replica | `BlockTransferService.handlePush` (`packages/db-p2p/src/cluster/block-transfer-service.ts`) | `BlockTransferResponse.outOfSpace`, with every requested block id in `missing`. The refusal is a property of the RECEIVER rather than of a block, so it rides once per response, and it happens before any proof is verified — which also means a full node stops spending CPU on signatures it is going to refuse anyway |
| An announced blob | `BlobAnnounceReceiver.decide` (`packages/db-p2p/src/blob/announce-receiver.ts`) | the announce answer `out-of-space` (docs/blobs.md §[Placement, copying and durability](../../../docs/blobs.md#placement-copying-and-durability)), after the membership, cohort and allowance checks and BEFORE the reference read — the read is the expensive part of answering an announcement, and a node that will not take the blob either way should not spend one of its four read slots establishing that it is referenced. `BlobAnnounceReceiver.keepAfterRead` — the reader repair, the only OTHER path that would take a new `responsible` hold — reads the same answer at the same point, so the two cannot disagree: a node that refuses this blob when a peer offers it does not take it because it happened to read it, and the hold is the one thing that would make a full node fuller without writing a byte, since it moves bytes out of the reach of the cache enforcement the same sample triggers |
| A pend its cohort asked it to store | `ClusterMember.validatePendOperations` (`packages/db-p2p/src/cluster/cluster-repo.ts`) | a signed `out-of-space` promise vote: transient, counted apart from approvals and rejections like `conflict` and `held`, and cast LAST of the member's refusals so a stale, invalid or held pend still gets its own permanent answer ([docs/correctness.md §Theorem 1](../../../docs/correctness.md#theorem-1-consensus-safety-no-conflicting-commits)). A cohort of ONE casts no vote, so `CoordinatorRepo.pendSolo` returns the same facts directly as an `OutOfSpaceFailure`. A write from the program on this machine is exempt at **both** of those gates, through the one predicate they share (`refusesPendForSpace`) — this node's own member learns whose write it is from the in-process pre-vote, never from the record; see below |
| The host's own `put` or `pin` | `LocalBlobService` (`packages/db-p2p/src/blob/local-blob-service.ts`) | a thrown `NodeOutOfSpaceError`, carrying the measured use and the effective total — and at a DIFFERENT limit; see below |

**The host's own writes are refused last of all, and its own blobs at the allotment rather than at `refuseAbove`.** A node's own writes are the work it exists to do; the replicas and blobs it holds on the network's behalf are the giveable part. So the reading answers a second question beside the stage — `ownWriteRoom()`, whether the measured use has reached the effective total — and `put` and `pin` refuse on that alone. The gap between `refuseAbove` and the allotment is the headroom this uses, the same headroom that covers pends already approved and the sampling window. A `put` is refused **before its first piece is written**, so a refused put leaves no pieces behind and no sweep to run; a `pin` is refused even when the blob is already whole here and the pin would take no new bytes, which is the accepted sharp edge (docs/blobs.md §[Holds](../../../docs/blobs.md#holds)): a pin is a promise to keep bytes the node has no room to keep, and the alternative is a `stat` on the hot path of a gate.

**Both pend gates exempt the host's own write, and the member learns it in process.** `CoordinatorRepo.pendSolo` (the cohort of one) and `ClusterMember.validatePendOperations` (this node's own promise vote) read one predicate, `refusesPendForSpace`, so the two cannot drift about whose write the headroom above is for. They did drift: the solo gate honoured the mark and the member's vote had none to read, so a node above `refuseAbove` refused the writes of the program on its own machine to every cohort it was a member of — which on a three-node deployment is every cohort there is, and nothing in the table of levers above frees block history a member is still responsible for.

What carries the fact to the vote is the **in-process pre-vote** this node's coordinator runs before a record fans out (`ClusterCoordinator.prevoteLocalPromise`, calling `ClusterMember.updateFromLocalWriter` instead of `update`), and nothing else. The fact is in no field of `ClusterRecord` — not signed, not hashed, not sent — so the bytes every remote member receives and the vote every remote member casts are exactly what they were; and a remote writer cannot claim it, because `ICluster.update` still takes its one argument and the entry point that carries the fact is not on `ICluster` at all. A pend from any OTHER writer still meets the gate at `refuseAbove`, on this member and on every other.

**The exemption covers a write this node coordinates, and no other.** That the pre-vote is its one carrier is also its limit: a writer's transactor marks the request it hands to its own node (`MessageOptions.localWriter`), and it normally hands it there, since the cover it computes over the action's blocks breaks ties in favour of the local peer. When it does not — an action whose blocks a peer covers more of, or a batch a retry re-homes — this node's own program's write reaches this member over the wire, indistinguishable from any other writer's, and is refused for space like any other. Making that case work would mean putting the fact on the wire, which is exactly what must not happen; the open question is tracked in `tickets/backlog/bug-a-full-nodes-own-write-is-still-refused-when-a-peer-coordinates-it.md`.

**Blobs alone carry the allotment backstop.** `put` and `pin` refuse the host's own write at the effective total; a block pend is exempt outright, so past the allotment its writer is answered only by the store's own write failure. That asymmetry is deliberate: what clears a full cohort is its members shedding to peers with room, and a cohort has no peer to shed block history to — a cohort of one has no peer at all. The `NOTE:` on `refusesPendForSpace` carries the condition under which it is worth revisiting.

**What is deliberately NOT gated.**

- **Nothing on a read path.** Answering `get`, serving blob pieces and answering `stat` cost no storage, so a full node is still a useful member for everything it already holds.
- **A fetch already in flight.** A pull of pieces for a `responsible` hold this node already took is not new data from others — the hold was taken, the blob is owed to the network, and abandoning the pull part-way leaves a partial blob that is worse than a whole one. The announcement that would have taken a NEW hold is where the refusal belongs, and that is the door above.
- **Applying a commit whose pend was approved.** A cohort member that approved a pend must still apply the commit. The refusal is at the gate or nowhere — the pend door above — and the headroom between `refuseAbove` and the allotment is sized for exactly the pends a member has already approved; nothing refuses inside an apply.

**A node that cannot measure itself refuses nothing,** at every one of the four doors: `refusingNewData()` is `false` at `unknown` because `unknown` sits below every acting stage, and `ownWriteRoom()` answers room when `totalBytes` is absent. A node on a memory, SQLite or LevelDB store with no configured allotment therefore behaves exactly as it did, and so does a node whose free-space read failed for one scan.

**What a sender does with a refusal.** A full peer was already not counted as a holder, since `pushBlockToPeers` counts a holder only when the response does not list the block as `missing` — so a shed range was already retained and a release was already blocked. What the explicit answer adds is reporting and restraint. The rebalance confirm logs the peer as `confirm:peer-full` rather than as an owner that did not have the block, so an operator reading a handoff that will not confirm can see that the new owners are full rather than unreachable. The growth arm (`BlockTransferCoordinator.replicateGrown`) stops pushing to a full peer for the rest of that pass and reports the block incomplete, so the monitor retries on a later check; it never records such a peer as satisfied, because a satisfied peer enters `RebalanceMonitor`'s seen set, which only a departure from the cohort clears — and being full is a condition that clears on its own. The blob side follows the same rule and for the same reason: `out-of-space` is deliberately not one of the announce answers that satisfy growth, unlike `declined`, which is a permanent fact about a configuration.

**What a node at its limit can and cannot free.** This is the honest limit of the whole chain, and it is why the order is shed, then delete, then refuse rather than shed alone. A node at `refusing` has four levers, and each has a ceiling:

| Lever | What it can free |
|---|---|
| Evicting the read cache | at most what the cache holds, which is capped at an eighth of the allotment (§9) and is often far less |
| Narrowing the ring | only once the handoff confirms other holders, which needs peers with room |
| Deleting what it released | only what narrowing handed over, and only once the handoff confirmed it (*The released-block sweep*, under Invariant 2) |
| The blob reclaim pass | only blobs no reference tree lists, after a seven-day grace |

None of the four touches **old revisions of blocks the node is still responsible for**, and on a long-lived node that is where the bytes accumulate. So a node whose use is mostly block history **cannot get back under its allotment** with these mechanisms: it reaches `refusing` and stays there until an operator raises the allotment or its peers take its ranges. The missing lever is offloading cold history and restoring it from the network on demand (`tickets/backlog/feat-cold-range-transform-offload.md`), which should be driven by this same reading. The chain is incomplete without it.

And shedding has a limit of its own, which [docs/arachnode-ring-handoff.md § Part 2](../../../docs/arachnode-ring-handoff.md#part-2--two-phase-responsibility-handoff) already records for the move-in case: **narrowing the ring reduces what the node is responsible for restoring and holding, not which cohorts it is in.** A block's cohort comes from `findCluster` — FRET proximity plus network membership — with the arachnode ring depth playing no part. Shedding therefore reduces one kind of inflow, and refusing is what covers the rest.

## Data Structures

### Block Metadata
```typescript
export type BlockMetadata = {
  ranges: RevisionRange[];    // Available revision ranges
  latest?: ActionRev;         // Latest revision info
  lineageFloor?: number;      // Lowest revision `latest` is known to be BUILT FROM, see below
  pendingRevs?: Record<ActionId, number>;   // Per pending record, the revision its pend claimed
  pendingBases?: Record<ActionId, number>;  // Per pending record, the base its operations were computed against
  pendingRuns?: Record<ActionId, string>;   // Per pending record the node applied alone for its own process's writer, the node run that saved it
  pendingSince?: Record<ActionId, number>;  // Per pending record, this node's wall clock when it stored the record
};
```

`pendingRevs`, `pendingBases`, `pendingRuns` and `pendingSince` describe the block's pending records
— the slot each one claims, the committed revision its update operations were computed against, the
run of this node that saved it, and when this node stored it — and are written, dropped and swept
together with the record (`BlockStorage.recordClaim`), never on their own. They live here rather than
inside the record because a promotion moves the record's bytes into the committed store unchanged. An
entry whose record is gone is inert (every reader joins against the pending namespace), and a record
with no entry reads as unknown: an unknown slot is the strongest kind of reservation, an unknown base
is simply nothing to compare, an unknown run says nothing about the writer, and an unknown stored-at
is judged from the reading run's start instead.

The run is written only for a record the node applied alone, with no consensus, for a writer in its
own process (`MessageOptions.localWriter`); a record stamped with a run other than the current one
(`StorageRepo.runId`) is abandoned, and the next pend of the block deletes it (`isAbandonedClaim` in
`src/storage/pending-claim.ts`). The stored-at is written for **every** record — it is the one
required field of `PendingClaimFields`, so a save path that forgot to stamp it is a compile error —
and a record that has stood past this node's pend lease has lapsed: it stops reserving the block
against other writers, while staying on file so its own commit can still promote it (`hasLapsed`, same
file). Read through `IBlockStorage.listPendingClaims` and `IBlockStorage.pendingClaimOf`; the rules
that consume them are in `docs/repository.md`, "A pending record claims a slot, and reserves the block
until a writer builds on it" and "A pending record's lifetime is bounded by its writer".

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
- **Snapshot-on-Store/Read**: Callers never share mutable references with the store. A backend that keeps live object references must deep-clone on get and put; a kernel-backed backend gets this for free from the codec boundary, where values cross encoded (see the shared KV kernel above)
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
