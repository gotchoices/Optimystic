description: Add fault-injection tests covering mid-DDL / mid-transaction crashes and partial-state recovery on a solo node. Build a new `packages/db-p2p/test/mid-ddl-crash.spec.ts` that wraps `MemoryRawStorage` with a fault-injecting proxy, drives DDL/DML flows through the real production stack (`NetworkTransactor` → `CoordinatorRepo` → `StorageRepo` → `BlockStorage` → `IRawStorage`), injects a crash at a specified boundary, rebuilds the node stack over the preserved raw storage, and asserts the correct recovery behavior for each crash point. Gaps where current behavior is wrong become follow-up fix tickets.
dependencies:
  - tickets/complete/5-get-block-throws-on-pending-only-metadata.md (establishes that pending-only metadata returns empty state on read — crash-A relies on this)
  - existing mesh-harness infrastructure (packages/db-p2p/test/mesh-harness.ts)
files:
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (new)
  - packages/db-p2p/test/mesh-harness.ts (add a small export for rebuilding the node stack over an existing MemoryRawStorage; do not refactor existing createMesh consumers)
  - packages/db-p2p/test/fresh-node-ddl.spec.ts (pattern to mirror for the harness wiring — same 1-node solo mesh)
  - packages/db-p2p/src/storage/memory-storage.ts (MemoryRawStorage is the durable target — crashes wrap its 14 IRawStorage methods)
  - packages/db-p2p/src/storage/i-raw-storage.ts (interface the proxy must cover verbatim)
  - packages/db-p2p/src/storage/block-storage.ts (getBlock returns undefined for pending-only metadata; savePendingTransaction seeds metadata before writing the pending record — the two halves of crash-A)
  - packages/db-p2p/src/storage/storage-repo.ts (pend / commit — the write-batch boundaries across multiple blocks are crash-B and crash-C; internalCommit sequence is saveMaterializedBlock → saveRevision → promotePendingTransaction → setLatest — crash-D is inside this sequence)
  - packages/db-p2p/src/repo/coordinator-repo.ts (pend / commit short-circuit to storageRepo when peerCount <= 1; solo-node tests intentionally stay on this path)
----

## Architecture

### Durable boundaries under test

The DDL/DML write path crosses several durable boundaries. A crash between any two must leave recoverable state on the next restart. The crash points correspond to specific IRawStorage calls:

```
StorageRepo.pend(request)
  for each blockId:
    BlockStorage.savePendingTransaction(actionId, transform)
      rawStorage.getMetadata(blockId)               -- read
      rawStorage.saveMetadata(blockId, seeded)      [ crash-A1: metadata seeded, pending not yet persisted ]
      rawStorage.savePendingTransaction(...)         [ crash-A2: pending persisted for THIS block ]
  (loop advances to next block — crash-B boundary between iterations)

StorageRepo.commit(request)
  for each blockId, internalCommit:
    rawStorage.getPendingTransaction                -- read
    rawStorage.getMetadata / getMaterializedBlock    -- reads
    rawStorage.saveMaterializedBlock                 [ crash-D1 ]
    rawStorage.saveRevision                          [ crash-D2: revision durable, pending still present, latest not updated ]
    rawStorage.promotePendingTransaction             [ crash-D3: pending promoted to committed, latest not updated ]
    rawStorage.setLatest via saveMetadata            [ crash-D4: fully committed ]
  (loop advances to next block — crash-C boundary between iterations)
```

### CrashingRawStorage proxy

A test-only wrapper that implements `IRawStorage` by delegating to an underlying `MemoryRawStorage`, with a configurable "fault plan":

```ts
type FaultTrigger = {
  method: keyof IRawStorage;          // e.g. 'saveRevision', 'savePendingTransaction'
  blockId?: BlockId;                  // optional — trigger only for this block
  actionId?: ActionId;                // optional — trigger only for this action
  skipCount?: number;                 // fire after N matching calls have succeeded (default 0 → fire on first match)
  when: 'before' | 'after';           // throw before the underlying call, or after it completes successfully
};

class CrashingRawStorage implements IRawStorage {
  constructor(private inner: IRawStorage, private trigger: FaultTrigger) {}
  // each method checks match(method, blockId, actionId) against trigger + skipCount,
  // and either throws synchronously (before) or throws after delegating (after).
}
```

- `when: 'before'` models "process killed while the syscall was pending" — the underlying store did not change.
- `when: 'after'` models "syscall completed but process killed before returning to the caller" — the underlying store DID change.

Both are realistic mobile failures (OS kill at arbitrary instruction boundary). Use one or the other per case depending on which half of the boundary is being tested.

### Restart harness

`mesh-harness.ts` currently creates rawStorage, storageRepo, clusterMember, and coordinatorRepo eagerly inside `createMesh`. Add a small companion export that can rebuild a solo-node stack over an existing `IRawStorage`:

```ts
export async function rebuildSoloNode(
  rawStorage: IRawStorage,
  options: MeshOptions
): Promise<Mesh>;
```

Implementation: factor the per-node construction out of `createMesh` into a private helper, then have `createMesh` call it in a loop and `rebuildSoloNode` call it once with the given raw storage. Keep the existing `createMesh(nodeCount, options)` signature intact — this is additive.

Alternative (if refactor is noisier than expected): accept a preexisting-rawStorage hook on `MeshOptions`, e.g. `rawStorageFactory?: (idx: number) => IRawStorage`. Pick whichever is less invasive; the test spec just needs "given a raw storage, build a fresh stack that uses it."

### Test shape per crash case

Each `it(...)` does:

```
1. const raw = new MemoryRawStorage();
2. const crashing = new CrashingRawStorage(raw, { method, when, ... });
3. Build node1 with crashing storage; build NetworkTransactor.
4. Drive a DDL/DML flow (e.g. Tree.createOrOpen + tree.replace) and capture the expected throw.
5. Assert the expected post-crash on-disk state directly against `raw` (e.g. metadata has latest === undefined; pending map contains/does not contain actionId; revisions map has/does not have rev N).
6. Rebuild node2 over `raw` (no crashing wrapper). Drive the recovery action (retry-pend, retry-commit, cancel, or a fresh read) and assert it behaves per the case's contract.
```

The test spec does NOT drive cluster consensus — it runs on a 1-node mesh so that `peerCount <= 1` routes `pend`/`commit` straight to `storageRepo`. This is intentional and in scope per the ticket's "Out of scope: crashes during cluster-consensus commits".

### Per-case expectations

- **Crash-A1 — metadata seeded, pending not persisted** (fault: `savePendingTransaction`, `when: 'before'`, on the schema block).
  - Raw state: metadata exists with `latest: undefined`; no pending record for actionId.
  - Recovery-1: read via `StorageRepo.get({ blockIds })` returns `{ state: {} }` (guaranteed by the completed ticket).
  - Recovery-2: a fresh retry-pend with the same actionId/transforms succeeds, and a subsequent commit reaches success.
  - Recovery-3: a fresh `cancel({ actionId, blockIds })` is a no-op that leaves the node in a readable, retryable state.

- **Crash-A2 — pending persisted for one block, loop aborted** (fault: `savePendingTransaction`, `when: 'after'`, fire on the FIRST matching call in a multi-block pend).
  - Raw state: block[0] has pending record; block[1]+ do not.
  - Recovery: retry-pend of the SAME actionId/transforms. Two acceptable contracts — test documents which is enforced:
    - Idempotent: retry rewrites (or no-ops) block[0]'s pending and adds block[1]+'s. Subsequent commit succeeds.
    - Rejecting: pend returns `{ success: false, pending: [...] }` because of the orphaned pending, caller must `cancel` first, then re-pend.
  - If neither is true (e.g. the retry throws with a corrupted-state error), file a follow-up fix ticket.

- **Crash-B — partial pending across multiple blocks** (fault: `savePendingTransaction`, `when: 'after'`, on block index 1 of a 3-block pend).
  - Raw state: blocks 0,1 have pending; block 2 does not.
  - Recovery: same as crash-A2 but covering the "stray pending state on two blocks" variant. Verify those blockIds are not permanently wedged — a subsequent fresh pend (new actionId) on the same blocks must either succeed or fail with the correct `pending: [...]` list per `policy: 'f'` / `'r'` / default.
  - Specific check: after `cancel({ actionId: stale, blockIds: [b0, b1, b2] })` on the stale action, the block-set is fully writable again.

- **Crash-C — partial commit across multiple blocks** (fault: `setLatest`→`saveMetadata`, `when: 'after'`, on block index 1 of a 3-block commit).
  - Raw state: blocks 0,1 are fully committed (latest updated); block 2's internalCommit never ran — pending still present, no new revision, no materialized block, latest unchanged.
  - Recovery: retry-commit of the same actionId + rev. Expected behaviors:
    - For blocks 0,1: the stale-revision check (`latest.rev >= request.rev`) returns `missing` with an empty transform list, surfacing `success: false`. This is the current behavior per `storage-repo.ts:217-233`.
    - For block 2: would commit if it were the only block, but the mixed batch fails.
  - Document this as the current contract. Whether atomicity across blocks SHOULD be guaranteed is a design question — if the test reveals data is unrecoverably split, file a design ticket (`4-transaction-commit-phase-atomicity.md` in complete/ already covers adjacent territory; cross-reference it).

- **Crash-D2 — revision durable, pending not promoted, latest not updated** (fault: `promotePendingTransaction`, `when: 'before'`).
  - Raw state: `revisions[blockId:rev] = actionId` exists; `pendingActions[blockId:actionId]` still present; `actions[blockId:actionId]` absent; `metadata.latest` unchanged.
  - Recovery: retry-commit with same actionId/rev. Per current `storage-repo.ts:244-253`, the check `getPendingTransaction` still finds the pending (good), and `internalCommit` re-runs all four writes — but `saveRevision` for the same rev overwrites the existing entry. Assert the final state after retry matches a clean commit: latest updated, pending gone, action in committed log.

- **Crash-D3 — pending promoted, latest not updated** (fault: `saveMetadata` via `setLatest`, `when: 'before'`, matching only calls where `meta.latest !== undefined`).
  - Raw state: action in committed log; pending gone; revisions table has the new rev; `metadata.latest` unchanged.
  - Recovery: retry-commit fails at `getPendingTransaction` check (pending is gone → throws "Pending action not found"). This is a sharp edge — the commit is half-applied: durable evidence that rev N was committed exists (in `revisions` and `actions`), but `latest` says otherwise. A fresh read path sees the OLD latest. Document the current behavior; if reads don't recover to the new latest, file a follow-up fix ticket recommending `StorageRepo.get`'s context-driven promotion path be extended to detect this state at startup, OR a `recover` entry point that reconciles latest with max(revisions).
  - There is prior work in this area: `coordinator-repo.ts:100` exposes `recoverTransactions()` — verify whether that path helps here; if not, note the gap.

- **Crash during schema-block commit specifically** — rerun crash-D2 and crash-D3 using the Tree's internal schema block (the one materialized by `Tree.createOrOpen`). This is the "bricks the whole database" case from the ticket. Assert that after the crash, a fresh Tree.createOrOpen on the same id either:
  - Succeeds and sees the (possibly rolled-back) state.
  - Succeeds and sees the committed state.
  - Throws with a clear, recoverable error (not `non-existent chain` or similar silent corruption).

### Key tests (TDD outline)

Named under `describe('Mid-DDL crash recovery (solo node)')`:

```
describe('Crash-A: metadata seeded, pending not persisted')
  it('read after crash returns empty state')
  it('retry pend with same actionId reaches commit')
  it('cancel after crash leaves a retryable clean state')

describe('Crash-A2/B: partial pending across blocks')
  it('crash after block 0 pend leaves block 1 writable after cancel')
  it('crash in middle of 3-block pend does not permanently wedge any block')

describe('Crash-C: partial commit across blocks')
  it('crash mid-batch commit documents per-block outcome')
  it('recovery via retry-commit matches current contract (documented pass or file fix ticket)')

describe('Crash-D: committed but latest not updated')
  it('crash before promotePendingTransaction: retry-commit reaches full success')
  it('crash before setLatest: documents current recovery behavior')

describe('Crash during schema block commit')
  it('post-crash Tree.createOrOpen does not silently corrupt')
```

Each test runs with the 5-second timeout used by fresh-node-ddl.spec.ts (tighter than the package 10s default — fast-fail on hangs is the point of a forcing-function).

### Non-goals

- Disk-corruption / byte-level storage corruption — separate resilience ticket.
- Crashes during cluster-consensus (multi-node) commits — `byzantine-fault-injection.spec.ts` covers adjacent territory; extending it is a separate ticket if needed.
- Retry limits / exponential backoff / circuit-breakers — this ticket is correctness, not liveness.
- Fixing any discovered gaps inside this ticket. When a crash case reveals wrong behavior, document in the test (with a skipped "desired" assertion if needed) and file a follow-up fix ticket rather than expanding scope.

## TODO

Phase 1 — harness
- Add a solo-node rebuild surface to `packages/db-p2p/test/mesh-harness.ts` (either `rebuildSoloNode(rawStorage, options)` or a `rawStorageFactory` hook; pick the less invasive option).
- Add the `CrashingRawStorage` proxy class inside the spec file (or a sibling `test/helpers/crashing-raw-storage.ts` if more than one spec will use it; right now only mid-ddl-crash.spec.ts needs it, so inline is fine).

Phase 2 — tests
- Create `packages/db-p2p/test/mid-ddl-crash.spec.ts` with the `describe`/`it` layout above.
- Implement Crash-A1, A2, B cases first (pend-side is the most constrained contract and the harness plumbing gets exercised there).
- Implement Crash-C and D cases; for each, assert the CURRENT behavior as the baseline. Where current behavior is clearly wrong (silent data loss, permanent wedge, wrong error type), mark the test `.skip` with a TODO comment referencing the follow-up fix ticket filed in Phase 3.
- Implement the schema-block-specific variant last.

Phase 3 — follow-up tickets
- For each crash case where the test documents a bug rather than correct behavior, create a ticket in `tickets/fix/` referencing the specific test case and the observed vs desired contract.

Phase 4 — verify
- `cd packages/db-p2p && npm run build` is clean.
- `cd packages/db-p2p && npm test` passes (existing 391 + new cases; skipped cases should have clear TODOs pointing at filed fix tickets).
- Transition: move this ticket to `tickets/review/` with a summary of what was built and which follow-up fix tickets were filed.
