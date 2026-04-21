description: A multi-block commit that crashes partway through leaves later blocks stranded — their pending is still present, no revision was written, latest is unchanged — while earlier blocks in the same batch are fully committed. Retry-commit with the same (actionId, rev) is then rejected because the earlier blocks report `latest.rev >= request.rev` and surface as `missing` (with empty transforms), short-circuiting the commit before it can advance the stranded block. There is no automatic path that detects "this actionId is committed on some blocks but still pending on others" and finishes the rollforward.
dependencies:
  - tickets/complete/4-transaction-commit-phase-atomicity.md (adjacent territory — already addressed single-block/intra-commit atomicity; this ticket is about inter-block atomicity on a commit batch)
  - tickets/review/5-mid-ddl-crash-fault-injection-tests.md (established the repro; Crash-C `it` asserts the current contract)
files:
  - packages/db-p2p/src/storage/storage-repo.ts (commit loop at 258-269 is sequential per-block; internalCommit at 279-314; stale-revision check at 217-233 is what rejects the retry)
  - packages/db-p2p/src/storage/block-storage.ts (internalCommit delegates here — the per-block sequence that either runs to completion or aborts)
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (Crash-C asserts current behavior: retry is rejected and b2 remains stranded)
----

## Current behavior

`StorageRepo.commit` processes blocks sequentially:

```ts
// storage-repo.ts lines 258-269
for (const { blockId, storage } of blockStorages) {
    try {
        await this.internalCommit(blockId, request.actionId, request.rev, storage);
    } catch (err) {
        return { success: false, reason: ... };
    }
}
```

If `internalCommit` on block[i] throws (e.g. OS kill mid-syscall), block[0..i-1] are fully committed, block[i+1..N-1] are untouched: pending still present, no revision, latest unchanged.

On retry-commit with the same (actionId, rev), the stale-revision check at 217-233 observes `block[0..i].latest.rev >= request.rev` for already-committed blocks, collects them into `missedCommits` (with empty transforms, since request.rev === latest.rev), and returns `{ success: false, missing: [...] }` — without advancing the stranded blocks.

The stranded blocks can be recovered by cancelling (`cancel({ actionId, blockIds: [stranded] })`) and re-pending with a fresh actionId — but that requires the caller to know the specific mix of committed-vs-stranded blocks and to reconcile application-level state manually.

## Options

**(a) Commit idempotency across blocks.** Extend the retry path: if a block's `latest.rev === request.rev && latest.actionId === request.actionId`, treat it as already-done (not a conflict) and proceed to commit the remaining blocks. The stranded blocks advance on retry.

**(b) Explicit recover entry-point.** A dedicated `StorageRepo.recoverCommit(actionId, blockIds, rev)` that detects partial state and drives the remaining blocks forward. Keeps the regular commit path simple.

**(c) Two-phase commit / WAL.** Persist the commit intent (actionId+rev+blockIds) before any internalCommit runs, and have a dedicated recovery pass finish any in-flight commit on startup. Heavier but closer to "real" atomicity.

Likely the right shape is (a) for the simple retry case + (b) for the startup case, since application code retrying a commit should Just Work and startup recovery should not require application involvement.

## Test / acceptance

The Crash-C `it` in `mid-ddl-crash.spec.ts` currently pins the WRONG behavior as the contract (retry-commit rejected, b2 stranded). That assertion should be flipped to:

1. After crash: b0,b1 fully committed, b2 has pending + no revision + unchanged latest.
2. On retry-commit of the same (actionId, rev): b2 advances; final state is b0,b1,b2 all at rev=1.

## TODO

- Decide the shape (a vs b vs c). (a) is the lightest and handles the dominant case; recommend starting there.
- Update the stale-revision check to recognize "already committed with this same actionId" as an idempotent no-op rather than a stale conflict.
- Flip the Crash-C test assertion; keep the test in place as the forcing-function repro.
- If going with (b) or (c), add startup recovery wiring and a companion test (can reuse the CrashingRawStorage harness + rebuildCleanMesh).
