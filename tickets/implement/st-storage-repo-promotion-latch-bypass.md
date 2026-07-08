description: When a block is read, the code that finalizes an already-committed pending change runs without the lock every other writer uses, so a read racing a write can silently roll the block back to an older version or mix up two writers' data. Fix by taking that lock and re-checking inside it.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# Bring read-driven promotion under the per-block commit latch

## Background

`StorageRepo` serializes every writer of a block's `meta.latest` on a per-block
mutex — the "commit latch" — keyed by `commitLatchKey(blockId)` and taken through
the helper `withBlockCommitLatch(blockId, fn)` (`storage-repo.ts:26-45`). Three
write sites already hold it:

- `commit()` — acquires all its blocks' latches up front, sorted, then runs the
  per-block `internalCommit` inside the critical section (`storage-repo.ts:360-540`).
- `saveReplicatedBlock()` — wraps its `getLatest → saveReplica` read-modify-write
  in the latch (`storage-repo.ts:566-596`).
- the invalidation-apply path — hands `applyInvalidation` a `withBlockCommitLatch`
  runner and wraps each compensating write in it (`invalidation.ts:565-575`).

`internalCommit`'s own header comment asserts it "is called within the locked
critical section of commit()" (`storage-repo.ts:599-602`).

## The bug

`get()` promotes a landed pending transaction by calling `internalCommit`
**directly, with no latch held** (`storage-repo.ts:171`). The surrounding loop
(`storage-repo.ts:160-177`) runs, per block, entirely unlatched:

```js
if (context) {
    const latest = await blockStorage.getLatest();                 // unlatched read
    const missing = latest
        ? context.committed.filter(c => c.rev > latest.rev)
        : context.committed;
    for (const { actionId, rev } of [...missing].sort((a, b) => a.rev - b.rev)) {
        const pending = await blockStorage.getPendingTransaction(actionId);  // unlatched
        if (pending) {
            const collectionId = await this.internalCommit(blockId, actionId, rev, blockStorage); // unlatched!
            if (collectionId !== undefined) {
                promotions.push({ collectionId, blockId, actionId, rev });
            }
        }
    }
}
```

`internalCommit` itself does `getLatest → getBlock → saveMaterializedBlock →
saveRevision → promotePendingTransaction → setLatest` (`storage-repo.ts:604-638`).
Because nothing serializes this against a concurrent `commit()` (or a second
read-driven promotion) on the same block, two such sequences can interleave.
Observable consequences (both are the lost-update / non-monotonic-`latest` class
that `5-invalidation-apply-commit-latch` — now in `complete/` — closed for the
invalidation path):

- `setLatest` regresses non-monotonically: `meta.latest` moves **backward** to an
  older revision after a newer one was already visible.
- Two writers cross-write `revs/<N>` entries for different `actionId`s, so the
  materialization served for revision N depends on interleaving.

This is the same defect on a **different, previously-missed** unlatched write site.
The latch key and helper already exist; this site was never brought under them.

## The fix

Wrap the per-block promotion loop body in `withBlockCommitLatch(blockId, ...)` and
**re-read state inside the latch** before promoting. Mirror the scope
`saveReplicatedBlock` uses: acquire the latch, do the read-modify-write, release —
one block's latch held at a time, so no deadlock against `commit()`'s sorted
multi-latch acquisition (a `get()` closure never holds two block latches at once).

Design points the implementer must honor:

- **Re-check inside the latch, not just outside.** A concurrent commit may have
  promoted or superseded the pending between the unlatched decision and latch
  acquisition. Inside the latch: re-read `getLatest`, recompute which
  `context.committed` entries are still `rev > latest.rev`, and re-fetch
  `getPendingTransaction(actionId)` — skip any whose pending is now gone (already
  promoted) or whose rev is now `<= latest.rev` (superseded). This makes the
  promotion idempotent under races, exactly like `commit()`'s alreadyDone/stale
  partitioning.
- **Keep the fast path latch-free.** Only enter `withBlockCommitLatch` when there
  is actually something to promote (`context` present *and* the unlatched pre-scan
  found at least one candidate `missing` entry). The common contextless read and
  the no-pending read must not pay for latch acquisition. The unlatched pre-scan is
  a cheap filter only — the authoritative decision is the re-read inside the latch.
- **Preserve the shared-array `.sort()` fix.** `missing` may alias the caller's
  `context.committed` when `latest` is undefined; the existing `[...missing].sort()`
  copies before sorting (`storage-repo.ts:166-168`). Keep that — there is a
  regression test for it (`storage-repo.spec.ts:383-405`, "does not mutate the
  caller context.committed array…").
- **`promotions` collection is unchanged.** Still push
  `{ collectionId, blockId, actionId, rev }` on each successful `internalCommit`,
  and still call `emitPromotions(promotions)` after the `Promise.all` — emission
  stays outside the latch, matching `commit()`/`saveReplicatedBlock` ordering.
- **`internalCommit` needs no change.** It already re-reads `getLatest` internally;
  the only defect is that its caller in `get()` never held the latch. Its comment
  at `storage-repo.ts:599` becomes accurate once this site is fixed — optionally
  broaden it to "called under the per-block commit latch (by `commit()` and the
  read-driven promotion in `get()`)".

## Reproduction / test

Model the new test on the existing latch + interleaving tests in
`packages/db-p2p/test/storage-repo.spec.ts`:

- Concurrency is driven with `Promise.all([...])` of two repo operations on one
  block (see "concurrent commits (TEST-5.4.1)", `spec.ts:444-476`).
- Interleaving is injected by wrapping a `BlockStorage` method in the repo factory
  closure to gate/yield at a chosen point (see the `saveRevision`-throws-once
  pattern, `spec.ts:834-848` and `spec.ts:911-925`) — here use a gated micro-yield
  (an `await` on a controllable promise) inside, e.g., `setLatest` or
  `promotePendingTransaction` on the block, so a read-driven promotion and a
  concurrent `commit()` (or a second context-driven `get()`) can be forced to
  interleave.

Assertions after the race, on that block's storage:

- `meta.latest.rev` is monotonic — it never ends below a rev that was observably
  current at any earlier point.
- Each `revs/<N>` entry holds a single, consistent `actionId` (no cross-write).
- Existing behavior still holds: the get()-driven-promotion event tests
  (`spec.ts:760-826`) and the caller-context-not-mutated test (`spec.ts:383-405`)
  still pass.

## Validation

Build + test the `db-p2p` package (and `db-core` if touched — it should not be).
From the repo root, streaming output so the runner's idle timer sees progress:

```
yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log
```

Confirm the exact package script name against `packages/db-p2p/package.json` and
the monorepo layout in `AGENTS.md` before running; adjust the command if the
workspace name or script differs.

## TODO

- Refactor the per-block promotion loop in `get()` (`storage-repo.ts:160-177`) so
  the promotion decision and `internalCommit` run inside
  `withBlockCommitLatch(blockId, ...)`, re-reading `getLatest` and
  `getPendingTransaction` inside the latch and skipping already-promoted /
  superseded actions.
- Keep the fast path latch-free: enter the latch only when `context` is present and
  the unlatched pre-scan found ≥1 candidate.
- Preserve the `[...missing].sort()` copy-before-sort and the `promotions` /
  `emitPromotions` flow unchanged.
- Optionally update `internalCommit`'s comment (`storage-repo.ts:599`) to name the
  read-driven promotion as a second latched caller.
- Add a regression test to `packages/db-p2p/test/storage-repo.spec.ts` that forces
  a read-driven promotion to interleave with a concurrent `commit()` (or a second
  promotion) on one block and asserts monotonic `meta.latest` + single-actionId
  `revs/<N>`.
- Build and run the `db-p2p` test suite (stream output with `tee`); ensure the new
  test and all existing storage-repo tests pass.
