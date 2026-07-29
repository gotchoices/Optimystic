----
description: A node can accept and store revision 2 of a block without ever having revision 1, leaving it holding an update it cannot apply to anything. The block is then permanently unreadable on that node, it cannot serve the block to anyone else, and it starts rejecting later writes to it.
files: packages/db-p2p/src/storage/storage-repo.ts (internalCommit), packages/db-core/src/transform/helpers.ts (applyTransform), packages/db-p2p/src/storage/block-storage.ts (getBlock, materializeBlock), packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations), packages/db-p2p/src/libp2p-node-base.ts (reconcileBlock / fetchArchiveFromPeer)
difficulty: hard
----

# A cohort member commits a forward transform with no base revision, and is then stuck forever

Reported by the Sereus embedder, diagnosed from a full `DEBUG='optimystic:*'` trace of a
two-node convergence scenario. Every claim below is backed by that trace or by code reading;
where the two disagree, trust the trace and say so.

## What happens

Two nodes, A (writer) and B. Sequence, verified from the trace:

1. A creates a collection. `findCluster` reports `fretCohort=1 connected=1` — the peer
   connection is already up, but FRET's cohort for that key has not caught up yet — so
   **revision 1 commits solo, on A only**. In 16 336 log lines,
   `block-storage commit blockId=default/CadrePeer` appears exactly once.
2. ~300 ms later FRET catches up (`fretCohort=2`).
3. A writes a row. Revision 2 is consensus-committed on **both** nodes.
4. B now holds revision 2 of the tree blocks and **no revision 1**.

Step 4 is the defect. `internalCommit` calls `applyTransform(undefined, transform)`, and
`applyTransform` (`packages/db-core/src/transform/helpers.ts:138-149`) only applies `updates`
`if (block && …)`. With no base it returns `undefined`, so `saveMaterializedBlock` is skipped
(`storage-repo.ts:650-652`) — **but `setLatest({rev: 2})` runs anyway.** B records that it is at
revision 2 while holding nothing it can produce revision 2 from.

## The three consequences, all observed

**B cannot read the block.** `materializeBlock` throws, verbatim from the trace:

```
Failed to find materialized block pS0f9rc6wY-dCSVflrOJRDv7pkcS0wVlB5Uig0hl3zs for revision 2
    at BlockStorage.materializeBlock (…/storage/block-storage.ts:335:10)
    at BlockStorage.getBlock (…/storage/block-storage.ts:51:10)
    at StorageRepo.get (…/storage/storage-repo.ts:156:19)
    at ClusterMember.validatePendOperations (…/cluster/cluster-repo.ts:997:27)
```

**B cannot serve the block, so the cohort silently loses redundancy.** `SyncService.buildArchive`
returns undefined (`sync/service.ts:158-161`), so B contributes no claim. The reader sees
`cluster-fetch:no-quorum { responders: 0, required: 1 }` — and the trace shows B *answering in
5 ms*, so this is a genuine "I cannot serve it", not the 1 s timeout.

**B poisons subsequent writes to that block.** The throw above happens inside
`validatePendOperations`, so B rejects the pend:

```
cluster-tx:supermajority-failed { approvals: 1, superMajority: 2 }
coordinator-repo:pend-error { error: 'Failed to get super-majority: 1/2 approvals' }
```

The block is permanently wedged on that node with no self-healing path.

## What to build

**A member asked to commit revision N for a block whose local `latest` is absent, or is older
than N−1, must obtain the base before committing — or refuse the commit.** It must never record
a revision it cannot materialize.

The machinery already exists: `reconcileBlock` / `fetchArchiveFromPeer`
(`libp2p-node-base.ts:673-701`) fetch a full archive from a peer and are already used on the
rebalance path. The trace confirms they work — the same block *does* produce
`storage:restoration` lines when reached that way (`conv.log:11610`).

Decide and document which of these the commit path should do:

- **Fetch-then-commit**: pull the base archive, then apply the transform. Converges without
  operator involvement; costs a network round trip inside the commit path and needs a bounded
  timeout and a clear failure mode when no peer can supply the base.
- **Refuse-and-heal**: reject the pend with a distinct, greppable reason (not a generic throw
  from deep inside `materializeBlock`), and let the existing reconcile path repair the node
  before it participates again. Keeps the commit path fast and simple; requires that something
  actually triggers reconcile, so verify that end-to-end rather than assuming it.

Either is defensible. Pick one, implement it fully, and state the tradeoff in the handoff. Do
not implement half of each.

Whatever you choose, `setLatest` must not advance past what the node can materialize. Treat that
as the invariant under test.

## Secondary defects found in the same trace — fix these too, they are small

1. **`cluster-fetch:synced` is logged unconditionally** (`coordinator-repo.ts:347-350`), even
   when the restore did nothing. This produced 222 false "synced" lines in one run and actively
   misled the investigation for two sessions. Log the outcome, not the attempt.
2. **Read-path restore is unreachable for a block with no local metadata.**
   `BlockStorage.getBlock` (`block-storage.ts:38-40`) returns `undefined` *before*
   `ensureRevision` (`:50`) when `getMetadata` is empty, and `restoreCallback` is only ever
   invoked from `ensureRevision` → `restoreBlock`. So a node that has never seen a block can
   never obtain it by reading. Confirmed by absence: no `storage:restoration` line accompanies
   any of the 222 `cluster-fetch:synced` lines. Decide whether the read path *should* be able to
   pull a block it has never seen; if yes, fix it; if no, make the early return say so and
   remove the illusion that read-repair covers this case.

## Edge cases & interactions

- **Legitimately absent blocks.** A node asked for a block that genuinely does not exist
  anywhere must still return absent cheaply. Do not turn every miss into a network fetch.
- **Base fetch fails** (no peer has it, all time out): must not commit, must not leave partial
  state, must surface a distinct error.
- **Concurrent commits** of N and N+1 arriving out of order at the same member.
- **Gap larger than one revision** (local at rev 1, asked to commit rev 5) — the fix must handle
  an arbitrary gap, not just the off-by-one that this trace happened to produce.
- **Self / solo cohort**: a single-node cluster must keep working unchanged.
- **Re-entrancy**: a fetch inside the commit path must not deadlock against the storage lock the
  commit already holds. Check this explicitly; it is the most likely way to break the suite.

## Testing

- The invariant, directly: commit rev 2 to a storage repo with no rev 1 present, then assert the
  block is readable **and** that `latest` never advanced past a materializable revision.
- Two real nodes, one of which missed the creating revision: assert the second converges and can
  subsequently serve the block to a third reader.
- A member that missed a revision does not reject later pends for that block.
- Assert `cluster-fetch:synced` is absent when nothing was restored.

## Related

- `bug-read-repair-unrepairable-small-cluster` (fixed, `50af693`) — revision *selection* at small
  cluster sizes. Necessary but, as this ticket shows, nowhere near sufficient.
- `read-repair-cannot-transfer-block-content` (in `fix/`) — overlaps secondary defect 2 above;
  reconcile the two rather than fixing the same thing twice.

## TODO

- [ ] Choose fetch-then-commit or refuse-and-heal; document the tradeoff.
- [ ] Enforce that `setLatest` never advances past a materializable revision.
- [ ] Fix the unconditional `cluster-fetch:synced` log.
- [ ] Resolve the no-local-metadata read-restore gap, or document it honestly.
- [ ] Tests per the list above, including the arbitrary-gap case.
- [ ] Full `db-p2p` suite green (baseline 1333 passing / 0 failing) and root `yarn lint` clean.
