description: A block read that finalizes an already-committed pending change now takes the same per-block lock every writer uses, closing a race where a read could roll a block back to an older version or mix two writers' data.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# Review handoff: read-driven promotion brought under the per-block commit latch

## What the bug was

`StorageRepo` serializes every writer of a block's `meta.latest` on a per-block mutex
(the "commit latch", key `StorageRepo.commit:<blockId>`, taken via the exported helper
`withBlockCommitLatch`). Three write sites already held it: `commit()`,
`saveReplicatedBlock()`, and the invalidation-apply path.

A fourth write site did **not**: `get()` promotes a pending transaction that has landed
elsewhere by calling `internalCommit` directly (`getLatest → saveRevision →
promotePendingTransaction → setLatest`). That per-block promotion loop ran with **no
latch held**. So a read-driven promotion racing a concurrent `commit()` (or a second
read-driven promotion) on the same block could:

- regress `meta.latest` non-monotonically — move `latest` *backward* to an older rev
  after a newer one was already visible; or
- cross-write `revs/<N>` for different actions depending on interleaving.

Same lost-update class that `5-invalidation-apply-commit-latch` (now in `complete/`)
closed for the invalidation path — just a different, previously-missed write site.

## What changed

**`packages/db-p2p/src/storage/storage-repo.ts`, `get()` (around line 159):**

The per-block promotion loop body is now wrapped in `withBlockCommitLatch(blockId, …)`,
with the promotion decision **re-made inside the latch**:

- **Fast path stays latch-free.** An unlatched pre-scan (`preLatest`/`preMissing`)
  runs first; the latch is entered only when `context` is present *and* the pre-scan
  found ≥1 candidate. The common contextless read and the no-pending read never pay for
  latch acquisition. The pre-scan is a cheap filter only — never the authoritative
  decision.
- **Re-read inside the latch.** Re-reads `getLatest`, recomputes which
  `context.committed` entries are still `rev > latest.rev` (drops the *superseded* — a
  concurrent commit advanced `latest` past them), and re-fetches
  `getPendingTransaction(actionId)` inside the loop (skips the *already-promoted* —
  pending gone). This makes the promotion idempotent under races, mirroring `commit()`'s
  alreadyDone/stale partitioning.
- **Preserved unchanged:** the `[...missing].sort()` copy-before-sort (guards the
  aliased `context.committed` — regression test at `spec.ts` "does not mutate the caller
  context.committed array…"); the `promotions` push per successful `internalCommit`; and
  `emitPromotions(promotions)` called after the `Promise.all` (emission stays outside the
  latch, matching `commit()`/`saveReplicatedBlock` ordering).
- `internalCommit` is **unchanged** (it already re-reads `getLatest` internally); only
  its header comment was broadened to name the read-driven promotion as a second latched
  caller.

**No deadlock risk:** `withBlockCommitLatch` acquires/releases one block latch per call,
and a `get()` closure never holds two block latches at once, so it cannot deadlock
against `commit()`'s sorted, up-front multi-latch acquisition. (The parallel per-block
closures in `get()` each acquire at most one latch and release it before returning — no
hold-and-wait cycle.)

## Tests added

Both in `packages/db-p2p/test/storage-repo.spec.ts`, new describe block
"read-driven promotion under the commit latch (st-storage-repo-promotion-latch-bypass)".
Imports added: `commitLatchKey` (from storage-repo), `Latches` + `ActionRev` (from
db-core).

- **"does not promote while another writer holds the block commit latch"** — the strong,
  fully-deterministic guard. Manually holds the block's commit latch
  (`Latches.acquire(commitLatchKey('block-1'))`), fires a context-proving `get()`, and
  asserts after a 25ms window that the promotion has **not** happened (`resolved===false`,
  `latest.rev===1`, `revs/2===undefined`). Then releases and asserts it lands (`rev 2`,
  `revs/2==='a2'`). A held mutex never self-releases, so this is not a timing race. The
  latch acquire is wrapped in `try/finally` so a failed assertion still releases the
  process-global latch (a leaked hold would wedge later tests that commit block-1).
- **"keeps meta.latest monotonic and revisions single-actionId when a read-driven
  promotion races a commit"** — real concurrent `get()`-promotion of `a2@2` vs
  `commit(a3@3)` on one block, via a gate on `block-1`'s `setLatest` (gates only the
  `a2` write) plus a double `Promise.race` so it neither hangs nor deadlocks regardless
  of which side wins the latch. Asserts final `latest.rev===3` (monotonic), `revs/1==='setup'`,
  `revs/3==='a3'`, and `revs/2 ∈ {undefined, 'a2'}` (single-actionId, no cross-write).

### Both tests verified to actually catch the bug

I temporarily reverted the fix (restored the unlatched loop) and confirmed each test
fails, then restored the fix:

- Test 1 fails `expected true to equal false` (promotes despite the held latch).
- Test 2, run in isolation, fails `expected 2 to equal 3` — the exact non-monotonic
  `latest` regression (rev 2 clobbering rev 3).

## Validation run

- `yarn workspace @optimystic/db-p2p build` — clean (tsc, no errors).
- `yarn workspace @optimystic/db-p2p test` — **1163 passing, 36 pending** with the fix in
  place. `db-core` untouched.

## Honest gaps / where to look hardest

- **Test 2 is timing-shaped, not hermetic.** Its buggy-detection relies on the in-memory
  `commit()` completing inside a 25ms `Promise.race` window; under the fix it is
  deterministic (the latch serializes the two sides), but the *bug-catching* direction
  leans on that window. It caught the regression cleanly in isolation, but a reviewer who
  wants a bulletproof guard should lean on Test 1 (deterministic, held-latch) — Test 2 is
  the integration-shaped companion, matching the shape the ticket asked for. If Test 2
  ever flakes in CI, widen the 25ms window or delete it in favor of Test 1; the coverage
  it adds over Test 1 is the "revs/<N> single-actionId under a real concurrent commit"
  assertion.
- **Global-latch test isolation.** `Latches` is a process-global static `Map`, not reset
  between tests (only `rawStorage` is fresh per `beforeEach`). Test 1 now releases in a
  `finally`; if any future test acquires a commit latch and can throw before releasing,
  it will wedge downstream tests on the same block id. Worth a reviewer eye if more
  latch-holding tests get added. (Discovered exactly this way: an earlier Test 1 failure
  leaked the latch and timed out Test 2.)
- **Superseded-skip is a legitimate no-op, not a completeness bug.** In the race where
  `commit(a3@3)` wins the latch first, the read-driven promotion of `a2@2` re-reads
  `latest===3`, sees `a2@2` is superseded, and skips it — leaving `rev 2` a permanent gap
  and `a2` still pending. That is correct (a2 was a stale/superseded action); it is not a
  lost write. Confirm you agree with that semantics — it is the same alreadyDone/stale
  logic `commit()` uses.
- **Tripwire (parked in code, not a ticket):** none newly introduced by this change. The
  pre-existing `setLatest` re-sort NOTE (`block-storage.ts:98`) and the get()-path stale
  Crash-D3 NOTE (`storage-repo.ts` in `get()`) are unchanged and still accurate.

## Suggested review focus

1. Confirm the fast-path gate is correct: latch is entered iff `context && preMissing.length>0`.
   Verify no path that must promote is skipped (e.g. `latest` undefined → `preMissing`
   is the whole `context.committed`, so any committed entry still enters the latch).
2. Confirm the inside-latch re-read genuinely re-derives `missing` from a fresh
   `getLatest` (not the pre-scan's `preLatest`), and that superseded/already-promoted
   entries are both handled inside the latch.
3. Sanity-check the no-deadlock argument against `commit()`'s multi-latch path.
4. Decide whether Test 2's timing shape is acceptable in your CI or should be reduced to
   Test 1 only.
