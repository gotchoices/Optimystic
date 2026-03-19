# Non-Tail Block Commits Must Eventually Converge After Tail Commit

description: NetworkTransactor.commit() silently drops non-tail block commit failures with no retry or recovery path, leaving committed actions with permanently unreachable blocks
dependencies: none (5-collection-createOrOpen-missing-block is the read-side complement)
files:
  - packages/db-core/src/transactor/network-transactor.ts (lines 418-429)
  - packages/db-p2p/src/repo/coordinator-repo.ts (get, fetchBlockFromCluster)
  - packages/db-core/src/network/struct.ts (BlockGets, ActionContext)
----

## Bug

When `NetworkTransactor.commit()` succeeds for the tail block but non-tail block commits fail (all peers in-flight), the error is logged and discarded:

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

The comment promises "reconciliation paths" but no such paths currently exist to drive these blocks to committed state. The block data from the `pend` phase sits in pending state on whichever coordinator received it, but nothing ever pushes it to committed. If the client process dies, this information is permanently lost.

### Observed Behavior

In a 3-node mesh (both `fretProfile: 'edge'` and `'core'`), the non-tail commit warning shows ALL 3 peers as `(in-flight)`:

```
[NetworkTransactor] non-tail commit had errors; proceeding after tail commit:
Some peers did not complete: PeerA[blocks:1](in-flight), PeerB[blocks:1](in-flight), PeerC[blocks:1](in-flight)
```

The block ID is then permanently missing. `CoordinatorRepo.get()` tries `fetchBlockFromCluster()` (line 156-173) but `queryClusterForLatest()` finds no peer with a committed version, so recovery doesn't fire.

### Design Intent and What's Missing

The design intent is sound: tail commit = action is recorded; non-tail blocks should eventually converge. Two pieces are missing:

**1. Coordinator-side: serve pending blocks that belong to committed actions.**

When `CoordinatorRepo.get()` or `StorageRepo.get()` receives a request with `context` that includes a committed `ActionRev`, and the requested block is in pending state for that action, it should serve the block (and ideally promote it to committed). The tail commit is proof the action is valid — the non-tail blocks just haven't been finalized.

This is the "reads with context" reconciliation path the NetworkTransactor comment references. The `BlockGets.context` field and `ActionContext` type already exist. The `TransactorSource.tryGet()` already passes `this.actionContext` on reads. The gap is on the coordinator/storage side — context-bearing reads don't currently serve from pending state.

**2. Reader-driven convergence: readers naturally repair on encounter.**

When any reader discovers (via the tail) that non-tail blocks should exist but aren't committed, the read with proper context should both:
- Return the block data (from pending state)
- Trigger commit finalization for that block as a side effect

This means every subsequent reader/writer that touches the collection naturally drives convergence. No background process needed. The companion ticket (5-collection-createOrOpen-missing-block) handles bootstrapping the context from the tail so that reads carry the right proof.

### Relationship to Companion Ticket

- **5-collection-createOrOpen-missing-block**: fixes the read side — ensures `Collection.createOrOpen` bootstraps `ActionContext` from the tail before reading non-tail blocks
- **This ticket**: fixes the storage/coordinator side — ensures context-bearing reads can serve and finalize pending blocks belonging to committed actions

Both are needed for full convergence. The read-side fix provides the context; this fix ensures the context is honored.

### Tests

- Unit test: `StorageRepo.get()` with `context: { committed: [{ actionId: X, rev: N }] }` for a block that is in pending state for action X — should return the block
- Unit test: after serving a pending block via context, a subsequent `get()` without context should also find the block (promotion to committed)
- Integration test: 3-node mesh, write with non-tail failure, new reader opens collection — should succeed and see all data (end-to-end convergence)
