description: A block read that finalizes an already-committed pending change now takes the same per-block lock every writer uses, closing a race where a read could roll a block back to an older version or mix two writers' data. Review also closed the same gap in the crash-recovery entry point.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# Completed: read-driven promotion (and crash recovery) brought under the per-block commit latch

## What the bug was

`StorageRepo` serializes every writer of a block's `meta.latest` on a per-block mutex
(the "commit latch", key `StorageRepo.commit:<blockId>`, taken via `withBlockCommitLatch`).
`get()` promotes a pending transaction that has landed elsewhere by calling `internalCommit`
directly — and that per-block promotion loop ran with **no latch held**. A read-driven
promotion racing a concurrent `commit()` (or a second read-driven promotion) on the same
block could regress `meta.latest` non-monotonically or cross-write a revision entry.

## What the implementation did (verified correct)

`get()`'s promotion loop is now wrapped in `withBlockCommitLatch(blockId, …)`, with the
promotion decision re-made inside the latch:

- **Fast path stays latch-free.** An unlatched pre-scan (`preLatest`/`preMissing`) runs
  first; the latch is entered only when `context` is present *and* the pre-scan found ≥1
  candidate. Verified: the gate is sound — skipping is correct whenever `preLatest.rev >=`
  a committed entry's rev (that entry is already promoted or superseded, matching
  `commit()`'s stale handling), and `preLatest === undefined` funnels the whole
  `context.committed` into the latch.
- **Re-read inside the latch.** Re-reads `getLatest`, recomputes `missing` from the *fresh*
  latest (drops superseded), and re-fetches `getPendingTransaction` per entry (skips
  already-promoted). Idempotent under races, mirroring `commit()`'s alreadyDone/stale split.
- **Preserved unchanged:** the `[...missing].sort()` copy-before-sort, the `promotions`
  push per successful `internalCommit`, and `emitPromotions` after `Promise.all` (emission
  outside the latch, matching `commit()`/`saveReplicatedBlock`).
- **No deadlock:** a `get()` closure holds at most one block latch at a time, so it cannot
  cycle against `commit()`'s sorted, up-front multi-latch acquisition. Confirmed.

## Review findings

### What was checked
- The full implement-stage diff (`get()` latching, the `internalCommit` header-comment
  broadening, and the two added tests), read before the handoff summary.
- **Every `meta.latest`-mutating write site**, for latch coverage:
  `commit()` (latched), `saveReplicatedBlock()` (latched), the invalidation-apply path
  (latched, `invalidation.ts:565`), `get()`'s read-driven promotion (latched by this
  ticket), and `recoverBlock()` — see finding below.
- Fast-path gate correctness; inside-latch re-derivation of `missing` from a fresh
  `getLatest`; superseded-skip and already-promoted-skip semantics.
- The no-deadlock argument against `commit()`'s multi-latch path.
- The two new tests, plus a bug-injection check (reverted the fix, confirmed each fails).
- Docs: `packages/db-p2p/docs/storage.md` — high-level only; its "Block-level Locking…
  prevents concurrent modifications" claim is now *more* accurate (it never asserted `get()`
  was latch-free), so no doc edit was needed.
- Build (`tsc`, which is this package's type check — no separate lint script) and the full
  test suite.

### What was found — one gap, fixed inline (minor, dormant)
- **`recoverBlock()` mutated `meta.latest` without the commit latch** (`storage-repo.ts`).
  `recoverBlock` → `storage.recover()` is a read-modify-write: it reads the metadata object,
  probes forward for the highest contiguous durable revision, then writes the *same*
  metadata object back. Its "advance only if `maxRev > currentRev`" guard is TOCTOU — a
  concurrent latched `commit()`/`saveReplicatedBlock` that advanced `latest` between
  `recover()`'s read and write would be clobbered (a non-monotonic regression / lost
  update). Exactly the bug-class this ticket exists to close, and the one remaining
  unlatched `latest`-writer.
  - **Reachability:** dormant. `recoverBlock` currently has *no production caller* (only
    tests invoke it); `commit()`'s own `recover()` call is already under the held latch and
    does not route through `recoverBlock`, so there is no double-acquire / deadlock.
  - **Disposition:** fixed inline rather than deferred — a one-line, strictly-safer change
    that wraps the `recover()` call in `withBlockCommitLatch(blockId, …)`, bringing the last
    `latest`-writer into the uniform invariant. Added a deterministic held-latch regression
    test (`recoverBlock does not reconcile meta.latest while another writer holds the block
    commit latch`) and verified it fails without the fix (`expected true to equal false`)
    and passes with it.

### What was found — nothing else
- **No major findings → no new tickets filed.** The single gap above was minor and
  inline-fixable.
- **No new tripwires introduced.** The pre-existing NOTEs (the `setLatest` re-sort at
  `block-storage.ts:98`, and the `get()`-path stale Crash-D3 NOTE at `storage-repo.ts:201`)
  are unchanged and still accurate.
- **No blocked decisions.**
- **Test-2 timing shape reviewed and accepted.** The concurrent-race test ("keeps
  meta.latest monotonic…") is deterministic under the fix; its bug-catching direction leans
  on a 25ms window, but the held-latch tests (Test 1 for `get()`, and the new one for
  `recoverBlock`) are the hermetic guards. Left as-is; if it ever flakes in CI, widen the
  window or drop it in favor of the deterministic tests.
- **Global-latch test isolation** (`Latches` is a process-global static `Map`, not reset per
  test) is a real sharp edge but pre-existing; all three held-latch tests here release in a
  `finally`. Flagged for anyone adding future latch-holding tests; not a defect of this work.
- **Superseded-skip is a legitimate no-op, not a lost write** — agreed with the
  implementer's semantics: a read-driven promotion that re-reads a higher `latest` correctly
  leaves the superseded action pending / its rev a permanent gap.

## Tests

`packages/db-p2p/test/storage-repo.spec.ts`, describe block
"read-driven promotion under the commit latch (st-storage-repo-promotion-latch-bypass)":
- **"does not promote while another writer holds the block commit latch"** — deterministic
  held-latch guard for `get()`.
- **"keeps meta.latest monotonic and revisions single-actionId when a read-driven promotion
  races a commit"** — integration-shaped concurrent race for `get()`.
- **"recoverBlock does not reconcile meta.latest while another writer holds the block commit
  latch"** — added in review; deterministic held-latch guard for `recoverBlock()`.

All three were confirmed to fail with their respective fix reverted, then pass restored.

## Validation

- `yarn workspace @optimystic/db-p2p build` — clean (`tsc`, no errors).
- `yarn workspace @optimystic/db-p2p test` — **1164 passing, 36 pending, 0 failing**
  (was 1163 before the review's added test). `db-core` untouched.
