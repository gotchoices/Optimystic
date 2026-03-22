description: Coordinator/storage repos don't serve pending blocks even when ActionContext proves they belong to a committed action — non-tail blocks never converge after partial commit
dependencies: none (5-context-bootstrap-on-collection-open is the read-side complement)
files:
  - (optimystic) packages/db-core/src/transactor/network-transactor.ts — commit(), lines 418-429
  - (optimystic) packages/db-p2p/src/repo/coordinator-repo.ts — get(), fetchBlockFromCluster()
  - (optimystic) packages/db-core/src/network/struct.ts — BlockGets, ActionContext
----

### Problem

`NetworkTransactor.commit()` treats non-tail block commit failures as non-fatal:

```ts
// network-transactor.ts:425-429
if (error) {
    // Non-tail block commit failures should not fail the overall action
    // once the tail has committed.
    // Proceed and rely on reconciliation paths (e.g. reads with context)
    // to finalize state on lagging peers.
    console.warn('[NetworkTransactor] non-tail commit had errors; ...');
}
return { success: true };
```

The comment promises "reconciliation paths (e.g. reads with context)" but no such path exists. The plumbing is there — `BlockGets.context` carries `ActionContext`, `TransactorSource.tryGet()` passes it — but neither `StorageRepo` nor `CoordinatorRepo` uses it to serve blocks from pending state.

Result: non-tail blocks from a committed action are permanently unreachable. No reader or writer can recover them. If the originating client dies, the data is lost despite a successful tail commit.

### Observed behavior

3-node mesh, all peers report `(in-flight)` for non-tail blocks:

```
[NetworkTransactor] non-tail commit had errors; proceeding after tail commit:
Some peers did not complete: PeerA[blocks:1](in-flight), PeerB[blocks:1](in-flight), PeerC[blocks:1](in-flight)
```

`CoordinatorRepo.get()` tries `fetchBlockFromCluster()` → `queryClusterForLatest()` but no peer has committed the block, so recovery doesn't fire. The block data sits in pending state on whichever coordinator received the pend, but no read path can reach it.

### Design intent

The tail commit is proof the action is valid. Any block belonging to that action should be recoverable from pending state. Readers that carry `ActionContext` (listing the committed action) should be able to:

1. **Receive** pending block data — the context proves the action succeeded
2. **Trigger promotion** — the pending block should be finalized to committed as a side effect

This is reader-driven convergence: every reader/writer that touches the collection naturally repairs any lagging blocks. No background process needed. The companion ticket (5-context-bootstrap-on-collection-open) ensures readers bootstrap context from the tail before requesting non-tail blocks.

### Fix

When `StorageRepo.get()` (or `CoordinatorRepo.get()`) receives a request with `context.committed` listing an `ActionRev`, and the requested block is in pending state for that action:

- Serve the block (return it in the `GetBlockResults`)
- Promote the block from pending to committed (side effect — makes it durable for future contextless reads)

If the block is not available locally but context proves it should exist, `CoordinatorRepo.fetchBlockFromCluster()` should query cluster peers using the context to find the pending data.

### Relationship to companion ticket

- **5-context-bootstrap-on-collection-open**: read side — ensures `Collection.createOrOpen` bootstraps `ActionContext` from the tail before reading non-tail blocks (provides the proof)
- **This ticket**: storage side — ensures context-bearing reads serve and finalize pending blocks (honors the proof)

Both needed for convergence. Without context bootstrap, readers never send proof. Without this fix, proof arrives but is ignored.

### Tests

- Unit test: `StorageRepo.get()` with `context: { committed: [{ actionId: X, rev: N }] }` for a block in pending state for action X — should return the block
- Unit test: after context-driven serving, a subsequent contextless `get()` should also find the block (confirms promotion)
- Integration test: 3-node mesh, write with non-tail commit failure, new `Collection.createOrOpen` — should succeed and return full collection state
