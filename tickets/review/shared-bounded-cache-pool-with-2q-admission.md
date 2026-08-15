----
description: The per-workspace memory caches now share one process-wide pool with a byte budget and an admission rule that keeps frequently used records from being flushed by one-off bulk reads. Review the pool's eviction/accounting code and the measurement tests that justify the admission layer.
prereq: coherent-raw-storage-cache
files: packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/shared-cache-pool.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts
difficulty: hard
----

# Review: shared bounded cache pool with 2Q admission

## What was built

**`SharedCachePool`** (`src/storage/shared-cache-pool.ts`, new): one bounded pool per
process, shared by every `CachedStoreDriver`. Byte budget + entry-count rail; 2Q admission
(A1in probation FIFO at ~25% of the byte budget, A1out ghost keys at half the entry cap, Am
protected LRU); large-value bypass at 1/16 of the budget; always evicts, never refuses;
`stats()` observability; store registration with never-reused ids; live `setBudget`.
Platform-default budgets (8 MB React Native / 16 MB browser / 32 MB Node) behind a lazy
`defaultCachePool()` singleton. An `admission: 'lru'` option exists ONLY as the comparison
baseline for the pollution measurement — documented as such.

**`CachedStoreDriver`** (rewritten): every cached value now lives on a `PoolEntry` the pool's
queues link directly, so residency/eviction/accounting are the pool's problem while all
coherence semantics from the prereq (write-through, proven-absence negatives, completeness
flags inside the entries they describe, generation guards, fill value+identity guards,
promote invalidate-never-synthesize) are preserved. Constructor default is the shared
process pool — consumers get the bound without opting in. `close()` is now ALWAYS defined
(was a conditional passthrough): it releases the store's pool registration, a capability of
the wrapper itself. Verified the kernel (`KvRawStorage`) never feature-detects
`driver.close`, so the change is exposure-only.

**`CachedRawStorage`**: optional `pool`/`label` constructor args passed through; new
`dispose()` releases the pool registration (`IRawStorage` has no close of its own).

**Exports**: `shared-cache-pool.js` added to `src/index.ts` and `src/rn.ts`.

**Docs**: `docs/storage.md` §6's "Unbounded for now — deliberately" bullet replaced with the
full pool description (keying, rails, 2Q, bypass, budget/`setBudget`, ghost-memory bound,
observability, lifecycle); wiring bullets updated for the new constructor args.

**Test helpers**: `CountingStoreDriver`, `READ_METHODS`/`WRITE_METHODS`, `makeBlock`,
`collect`, and the cold-start workload moved from `cached-raw-storage.spec.ts` into
`test/support/cache-test-helpers.ts`, shared by both specs (no duplication).

## What was measured (vs merely asserted)

All numbers below are from actual runs (`yarn workspace @optimystic/db-p2p run test`):
**1758 passing, 44 pending (pre-existing skips), 0 failing.** Package compiles clean.

- **Pollution measurement (the ticket's headline), MEASURED**: warm a "hot" store's 20
  metadata entries, flood probation so they ghost, re-touch them (20 ghost hits → Am), then
  bulk-scan 3000 blocks through a second "bulk" store sharing the pool. Result: **2Q serves
  the hot set with 0 further inner reads (0/20); the identical sequence on the `'lru'`
  baseline loses the entire hot set (20/20)**. The contrast the ticket demanded appeared
  cleanly — the admission layer stays. (~3081 evictions churned during the 2Q scan, so the
  scan really did pressure the pool.)
- **Easy-case regression, MEASURED**: the prereq's cold-start workload under an explicit
  8 MB pool vs a 1 GB pool → identical per-method driver counts, and the ≥70%-cut assertion
  still holds against an uncached baseline (95.9% cut, unchanged from the prereq).
- **Thrash conformance, MEASURED**: the full raw-storage conformance suite runs green over
  a 2 KB pool (bypass limit below every entry's base charge — pure read-through) AND a
  16 KB pool (entries admit but churn constantly, so eviction lands at arbitrary instants,
  including between promote's coupled mutations). This is the broad proof that eviction at
  any instant never breaks coherence.
- **Remote-probe bound, MEASURED**: 2000 probes of nonexistent block metas through a 16 KB
  pool stay inside both rails (entries ≤ 32, bytes ≤ 16 KB, ghosts ≤ 16) while every probe
  of a new id falls through.

Asserted-not-measured: the charge constants (`ENTRY_BASE` 256, `REV_SLOT`/`INTERVAL_SLOT`
56, `ID_SLOT` 40, 2 bytes/char) are engineering approximations of JS object overhead, not
profiled numbers. They only need to be the right order of magnitude for the budget to mean
what it says; nothing correctness-bearing depends on them.

## Use cases for review validation

- **Pool mechanics** (`test/shared-cache-pool.spec.ts`, "SharedCachePool mechanics"):
  first admit → A1in; re-touches do NOT save an A1in entry from FIFO eviction; A1in
  eviction ghosts; ghosted re-admission → Am; Am LRU refresh on touch; Am evictions never
  ghost; both rails enforced; `updated()` growth can evict the updated entry itself;
  `drop()` never ghosts; ghost cap; store lifecycle sweep; double-admit throws; invalid
  budgets throw; `'lru'` mode behavior.
- **Coherence under eviction** ("CachedStoreDriver under a bounded pool"): pending-list
  completeness evicted → next list re-enumerates the inner driver and is correct; promote
  with the pending entry EVICTED → committed read falls through to the real transform
  (never synthesized, never a stale negative); two stores with the SAME name-derived block
  id never alias; `close()` on store A leaves B's cached entries served; large-value
  bypass reads fall through twice with zero pool occupancy.
- **The two measurements** above, each with a console table in the test output.

## Known gaps / judgement calls for the reviewer

- **Correlated-reference (`VisitId`) refinement: skipped, and the measurement supports
  skipping.** The concern was that one logical operation touches the same entry several
  times and could fake "reuse". Because A1in re-hits do not promote, intra-operation
  double-touches are absorbed by probation residency — confirmed indirectly by the
  pollution test: the 3000-block scan (whose entries ARE touched on fill) promoted nothing
  into Am (hot set intact ⇒ Am was not polluted by scan entries).
- **Fairness between stores: deliberately not enforced.** Nothing stops one store from
  occupying most of the pool. What WAS checked: the pollution test shows Am protection is
  what prevents indefinite starvation of a re-used working set — a store whose entries are
  genuinely re-used keeps them resident even while another store floods probation
  indefinitely. A greedy store can only starve entries that were never re-used, which is
  the policy working as intended, not a fairness failure.
- **Charge accounting is delta-tracked by hand** in the revs/pendList paths (per-rev,
  per-interval, per-id constants). A missed delta would skew the budget, not corrupt data.
  The byte rail was asserted (`bytes ≤ maxBytes`) across probe/flood tests, but there is no
  invariant test that recomputes an entry's charge from scratch and compares — a reviewer
  may want to spot-check `putRevision`/`rangeRevisions`/`listPendingActionIds` deltas
  (including the interval-merge shrink case).
- **`close()` always defined** is a deliberate exception to the passthrough-mirroring rule
  (documented in the field comment). Checked: only `cached-raw-storage.ts` and tests
  compose `CachedStoreDriver` in-repo, and the kernel never wires `close`.
- **The pollution scenario's constants** (150-probe flood, 3000-block scan, 32 KB /
  200-entry pool) were sized so the phases land where intended (hot set fully ghosted
  before re-touch; ghost cap not overrun before the re-touch). The test asserts the
  mechanism (ghost hits ≥ 20, zero post-scan reads), so drift would fail loudly rather
  than silently pass, but the sizing is coupled to the ~350-byte entry charge.
- **`defaultCachePool()` is process-global state.** The existing
  `cached-raw-storage.spec.ts` conformance/coherence tests now run against it (32 MB in
  Node) — inert at test scale, verified: op counts unchanged. Tests needing isolation pass
  their own pool; nothing resets the singleton (no API to do so — deliberate, it is a
  budget, not a registry).
- **Ghost keys live outside the byte budget**, bounded by their own cap — ~2 MB worst-case
  at the default Node budget (32 MB → 65536-entry cap → 32768 ghost keys × ~60-byte keys),
  proportionally less at smaller budgets. Documented in storage.md.
