description: Fixed partial-commit stranded-block bug by teaching `StorageRepo.commit` to treat per-block idempotent retries as no-ops. A mid-batch commit crash that committed blocks 0..i-1 but left block i+1..N-1 pending can now be rolled forward by retrying the same (actionId, rev) — already-done blocks are skipped, remaining blocks proceed to commit.
dependencies:
  - tickets/complete/4-transaction-commit-phase-atomicity.md (single-block atomicity, sibling territory)
  - tickets/complete/5-mid-ddl-crash-fault-injection-tests.md (Crash-C is the forcing-function repro)
files:
  - packages/db-p2p/src/storage/storage-repo.ts (commit() — idempotency check at the stale-revision gate; pending-check + internalCommit loop now only visit blocks that still need committing)
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (Crash-C assertion flipped; Crash-D3 retry-commit assertion updated to reflect the new success path via the leaked in-memory latest)
----

## Summary

Fixed the "partial commit leaves blocks stranded" gap surfaced by Crash-C. Commit chose option (a) from the ticket — per-block idempotency — as it handles the dominant retry case with minimal surface area.

### Behavior change

`StorageRepo.commit` now partitions its input blocks into three buckets at the stale-revision gate:

- **Already-done** (new): `latest.rev === request.rev && latest.actionId === request.actionId`. Treat as an idempotent no-op; skip the pending-check and internalCommit for this block.
- **Stale conflict** (unchanged): `latest.rev >= request.rev` but the actionId doesn't match — caller gets `{ success: false, missing: [...] }` as before.
- **To-commit** (unchanged): `latest.rev < request.rev` or no latest — normal commit path.

The pending-check and internalCommit loop only iterate over "to-commit" blocks. The per-block locks are still held across the critical section, so the partitioning and subsequent commits are atomic with respect to concurrent commits on the same blocks.

### Why this works for the Crash-C scenario

1. Multi-block commit starts; b0,b1 complete their full internalCommit (revision + promote + setLatest).
2. Crash on b1's setLatest is impossible here — but crash on b2's first syscall (or any point in b2/b3/...) aborts the outer loop, leaving b2 with pending present, no revision, and unchanged latest. b0,b1 are fully at rev=1.
3. Retry-commit with same (actionId, rev): b0,b1 hit the new idempotency path and are skipped; b2 goes through normal commit path; end state is all blocks at rev=1.

## Testing

### Crash-C test (`packages/db-p2p/test/mid-ddl-crash.spec.ts`)

Assertion flipped to require the desired behavior:

- After retry-commit: `success === true`, all three blocks at `rev=1` with the same actionId.
- b2's pending is promoted; b2's revision is written; b2's materialized block is readable via `get()`.

### Crash-D3 retry-commit test (same file)

Updated to document that the retry now succeeds on MemoryRawStorage via the new idempotency path — because the reference-leak mutation of `meta.latest` makes the retry's `latest.rev === request.rev && latest.actionId === request.actionId` check match. The residual gap on a persistent store (no leak → idempotency wouldn't fire → pending-missing → fail) is still tracked by the two follow-up tickets referenced in the test comment.

### Run results

- `npm run test` (db-p2p): 417 passing, 7 pending, 0 failing.
- All Mid-DDL crash tests pass (11 passing, 1 pending).
- `tsc --build` across packages clean.

## Use cases

- Any multi-block commit that partially crashes on the internalCommit loop in `StorageRepo.commit`. A caller (or coordinator) retrying with the same (actionId, rev) now rolls forward automatically.
- Safe under the existing per-block lock discipline: idempotency check and commit run inside the same critical section.

## Review-stage TODO

- Confirm idempotency check is correct under the `rev=0` / pending-only / insert-after-delete edge cases.
- Verify that callers up the stack (`CoordinatorRepo`, `NetworkTransactor` commit path) surface retry opportunities naturally — i.e., that the layer above StorageRepo will actually retry on `{ success: false, reason: ... }` from a partial crash.
- Confirm that the "startup recovery" case (option c in the source ticket) is genuinely not needed given option (a) handles the retry case; if not, file a follow-up.
