----
description: A phone running twenty workspaces would otherwise keep twenty separate memory caches, each sized as if it were the only one, and a single bulk scan through one of them could throw away everything the others need. Give them one shared pool with a memory budget and an admission rule that protects frequently used records from one-off bulk reads.
prereq: coherent-raw-storage-cache
files: packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/cached-raw-storage.spec.ts
difficulty: hard
----

# Bound the raw-storage cache: one shared pool, byte budget, 2Q admission

<!-- resume-note -->
**A prior run was interrupted by a token-budget stop mid-implementation.** The two core source
files are WRITTEN but NOTHING has been compiled, linted, or tested — treat them as a careful
draft, not a verified artifact. Read them before writing any code; the design decisions below
are already embodied in them.

## What already exists (written, unverified)

**`packages/db-p2p/src/storage/shared-cache-pool.ts` — NEW, complete.** `SharedCachePool`:
process-wide bounded pool. Design decisions, with rationale:

- **Queues are plain `Map`/`Set` insertion order** (A1in = Map as FIFO, Am = Map with
  delete+reinsert as LRU, A1out ghost = Set as FIFO) — the same idiom as db-core's `LruMap`,
  chosen over porting lamina's intrusive `SlotList`. `LruMap` itself was examined and is not
  reusable (no byte accounting, no 2Q); this is documented as the "reuse or extend" answer.
- **Entry = node.** `PoolEntry<V>` is simultaneously the value holder the driver's maps point
  at and the node the pool queues link. Fields: `key, store, owner, cls, blockId, actionId,
  value, base, charge, where`. Owners build them as object literals with `where: 'none'`.
- **2Q per the ticket**: A1in share = 25% of byte budget; ghost cap = 50% of entry cap;
  ghost-demotion on A1in eviction only; no intra-A1in promotion on re-hit; ghost-hit
  admissions go straight to Am; Am evictions never ghost. Victim rule: A1in head while A1in
  over share (or Am empty), else Am head.
- **Two rails**: `maxBytes` plus `maxEntries` (default `max(16, maxBytes/512)`). Every entry
  charges `base` (ENTRY_BASE 256 + 2 bytes/key char) so negatives and empty containers are
  never free.
- **Bypass**: `admits(charge)` returns false above `maxBytes/16` (counted in stats). Resident
  container entries (revs/pendList) that *grow* past the limit are NOT bypassed — growth is
  charged and ordinary eviction reclaims them (documented in the pool class doc).
- **Always evict, never refuse** — no `BufferExhausted` analogue; entries are never pinned or
  dirty. Eviction calls `owner.onPoolEvict(entry)` synchronously; the callback must not
  re-enter the pool.
- **Budget validation**: non-finite/≤0 throws `TypeError`; absurdly *small* values are
  accepted as-is because coherence never depends on retention — tiny budgets just degrade
  toward read-through. This is deliberate: it is what makes thrash-testing possible (see test
  plan). Live `setBudget` evicts down immediately.
- **Platform defaults** (`defaultCachePool()`, lazy singleton): React Native (detected via
  `navigator.product === 'ReactNative'`) 8 MB; browser (`window` present) 16 MB; Node 32 MB.
- **`admission: 'lru'` option** — plain shared LRU, no ghost, everything to Am. Exists ONLY
  as the comparison baseline for the pollution measurement below; documented as such.
- **Store lifecycle**: `registerStore(label?)` returns a `CacheStoreHandle` with a
  process-unique never-reused id (`s1`, `s2`, …) and live `bytes`/`entries` occupancy;
  `unregisterStore` defensively sweeps queues and purges the store's ghost keys;
  `purgeGhosts(handle)` is public because the driver's `clear()` uses it.
- **Observability**: `stats()` → budget, totals, per-queue bytes/entries, ghostKeys, hits /
  admissions / ghostHits / evictions / bypasses, per-store occupancy list.

**`packages/db-p2p/src/storage/cached-store-driver.ts` — REWRITTEN, complete.** All prereq
coherence semantics preserved (write-through, proven-absence negatives, completeness flags
inside the entries they describe, gen guards, fill value+identity guards, promote
invalidate-never-synthesize). Pool integration decisions:

- Constructor is now `(inner, pool = defaultCachePool(), label?)`. **Default is the shared
  process pool** — consumers get the bound without opting in; a custom pool is for isolation
  (tests) or host-specific sizing.
- **The one discipline every path follows**: mutate wrapper state FIRST, pool call
  (`admit`/`updated`/`touch`/`drop`) LAST, never touch cache state after the pool call —
  pool mutations can synchronously evict anything, including the entry just written.
  `admit` evicts-to-fit *before* linking, so an incoming entry can never be its own victim.
- `revs`/`pendList` entries are **eagerly admitted** (before the inner await) so fill guards
  keep a stable identity to compare across the await; `ensureRevs`/`ensurePendList` return
  `undefined` under bypass (absurdly small budget) and the callers become pure passthroughs.
- Charges: point entries `base + bytes.length`; revs `+= REV_SLOT(56) + len` per rev and
  `INTERVAL_SLOT(56)` per coverage interval (delta-tracked, including merges shrinking the
  interval list); pendList `ID_SLOT(40) + 2*id.length` per id.
- `onPoolEvict` removes the wrapper's reference (identity-checked) and **reaps empty block
  states** (`dropIfEmpty`), so eviction leaves no uncharged skeletons. `reapOnThrow` also
  reaps when an inner read throws after `state()` allocated — closes an unbounded-growth
  vector on throwing backends that predates this ticket.
- **`close()` is now ALWAYS defined** (was: conditional passthrough). It clears, unregisters
  from the pool, then calls `inner.close?.()`. Deliberate exception to the
  passthrough-mirroring rule, documented in the field comment — releasing pool registration
  is the wrapper's own capability. Check nothing feature-detects `driver.close` in a way this
  breaks (the kernel never wires it, so exposure is driver-composition only).
- `clear()` drops all entries from the pool AND purges this store's ghosts (pre-clear recency
  must not fast-track post-clear refills into Am).
- Promote under eviction is argued safe in the method doc: the inner atomic move resolves
  before any cache mutation, so each of the three coupled entries steps between individually
  coherent states; an eviction mid-sequence turns a step into "unknown, fall through", never
  a fabricated value. The `pendingBytes instanceof Uint8Array` capture happens before the
  pending entry is overwritten.

## Remaining work (in order)

- **Wire `cached-raw-storage.ts`**: `CachedRawStorage` constructor gains optional
  `pool`/`label` passed through to `CachedStoreDriver`; add a `dispose()` that calls the
  cache driver's `close()` (KvRawStorage has no close of its own). Update its class doc.
- **Exports**: add `export * from "./storage/shared-cache-pool.js"` to `src/index.ts` and
  `src/rn.ts`.
- **Build + lint + existing tests**: `yarn workspace @optimystic/db-p2p run build`, then
  `run test` (stream output through `tee`). Expected fallout to check: TS comparison of
  `PoolEntry<CachedBytes>` vs `PoolEntry<unknown>` identity checks; the existing
  `cached-raw-storage.spec.ts` now runs against the global default pool (32 MB in Node —
  should be inert; verify the op-count test's counts are unchanged and the Gate/Faulty
  coherence tests still pass).
- **New spec `test/shared-cache-pool.spec.ts`** (consider moving the existing spec's
  `CountingStoreDriver` to a shared test helper instead of duplicating):
  - Pool mechanics driven directly with a fake `PoolEntryOwner`: first admit → A1in; A1in
    FIFO order unaffected by re-touches; A1in eviction → ghost; ghosted key re-admitted → Am
    (`ghostHits`); Am touch refreshes LRU order; byte and entry rails both enforced;
    `admits` bypass above maxBytes/16; `setBudget` shrink evicts immediately; invalid budget
    throws.
  - **Thrash conformance**: `runRawStorageConformance` over
    `KvRawStorage(new CachedStoreDriver(new MemoryStoreDriver(), new SharedCachePool({ maxBytes: 2048 })))`
    — at that budget most values bypass and everything else churns; the full contract must
    still hold. This is the broad proof that eviction at any instant (including mid-promote)
    never breaks coherence.
  - Remote-probe bound: probe thousands of nonexistent block metas through a small pool;
    assert `stats().entries ≤ maxEntries` and `bytes ≤ maxBytes`.
  - Completeness under eviction: seed pendList completeness, flood until it evicts, assert
    the next list re-enumerates the inner driver (counting driver) and is correct.
  - Promote combos: evict the pending value entry pre-promote → committed read falls through
    and returns the real transform (never synthesized, never a stale negative).
  - Lifecycle: two stores, same blockId, different values → no aliasing; `close()` on A
    zeroes A's occupancy and leaves B intact; `clear()` releases occupancy.
  - Large-value bypass: value > budget/16 read/written through twice → two inner reads,
    pool occupancy unaffected.
- **The pollution measurement (headline of the ticket)**: warm store B's ~20 metas, flood
  A1in so they ghost, re-touch them (ghost hits → Am), then bulk-scan thousands of blocks
  through store A; assert B's entries are still served with zero further inner reads. Run the
  identical sequence on an `admission: 'lru'` pool and show B's hot set is lost. **If the
  contrast does not appear, say so and drop the admission layer for a plain LRU** — a
  negative result is a good outcome and must not be argued away (original ticket verbatim).
- **The easy-case regression**: the prereq's cold-start workload with an explicit 8 MB pool
  vs an effectively-unbounded pool (e.g. 1 GB) → identical per-method driver counts, and the
  existing ≥70%-cut assertion still holds.
- **Docs**: rewrite `docs/storage.md` §6's "Unbounded for now — deliberately" bullet into the
  pool description (keying, budget rails, 2Q behavior, bypass, platform defaults +
  `setBudget`, observability, lifecycle/close, ghost-memory note: ghost keys live outside the
  byte budget, bounded by their own cap — order ~2 MB worst-case at default budgets). Update
  the wiring bullets for the new constructor params.
- **Handoff**: distilled summary into `tickets/review/` (delete this ticket), honest about:
  what was measured vs asserted; the skipped correlated-reference (`VisitId`) refinement and
  whether the pollution measurement changed that judgement (note: A1in residency already
  absorbs intra-operation double-touches, since A1in re-hits do not promote — say whether
  the measurement confirms this); fairness (deliberately not enforced — confirm via the
  pollution test that Am protection is what prevents indefinite starvation, and say what was
  checked); `close()` now always defined; the accepted approximation constants for charge
  accounting.

## Original acceptance criteria (unchanged, condensed)

One pool per process keyed `(storeId, class, key…)` — storeId mandatory because header block
ids are name-derived and collide across stores (data integrity, not perf). Byte budget +
entry-count rail; negatives and empty bookkeeping charged; large values bypass (~1/16);
always evict, never refuse, never grow unbounded; 2Q = A1in ~25%, ghost ~50% of entry budget,
ghost-demotion on A1in eviction only, no intra-A1in promotion, Am protected LRU — nothing
else from lamina (`c:/projects/lamina/packages/lamina-substrate/src/buffer/twoq.ts` is a
reference to read, not a dependency). Store close releases entries; storeIds never reused.
Completeness flags must survive eviction correctly; promote coupling correct for every
present/evicted combination; host-set budget with honest platform defaults; observability
(hit rate, evictions, bytes resident, per-store occupancy); eviction must not corrupt the
mid-promote coupling. Confirm with the two measurements above.
