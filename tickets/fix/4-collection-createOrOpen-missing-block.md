# Collection.createOrOpen Fails on Non-Tail Blocks After Partial Commit

description: Collection.createOrOpen reads log chain blocks with context=undefined, causing Missing Block errors when non-tail blocks are uncommitted but the tail is committed - breaks read-your-own-writes serializability
dependencies: 5-nontail-commit-convergence (related but independently fixable)
files:
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/src/chain/chain.ts
  - packages/db-core/src/log/log.ts
----

## Bug

`Collection.createOrOpen` breaks serializability by failing to read data that was successfully committed moments earlier by the same (or any) client.

### Root Cause

When a `NetworkTransactor.commit()` succeeds for the tail block but non-tail blocks remain in-flight, the commit returns `{ success: true }`. The caller reasonably believes the write is durable. But when a new `Collection.createOrOpen` is called for the same collection (e.g., because the Tree instance wasn't cached), the read path fails:

```
Collection.createOrOpen(transactor, id, init)
  source = new TransactorSource(id, transactor, undefined)  ← context=undefined
  header = await source.tryGet(id)                          ← succeeds (header is tail, committed)
  log = await Log.open(tracker, id)                         ← walks chain, reads non-tail blocks
    Chain.open → reads headerBlock.tailId                   ← succeeds
    log.getActionContext() → walks chain backwards           ← reads non-tail data blocks
      source.tryGet(nonTailBlockId)                         ← context=undefined, block not found
        💥 Missing block (rUjt0JGd...)
```

The `ActionContext` that would allow the coordinator to serve the non-tail block (from pending state or via cluster recovery) is only set AFTER `log.getActionContext()` completes — a chicken-and-egg problem. The context needed to read the chain is derived from the chain itself.

### Reproduction

Run from `packages/quereus-plugin-optimystic`:
```bash
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/distributed-quereus.spec.ts" --timeout 120000 --exit
```

Test 1 ("create table on one node and access from another") passes. Tests 2-4 fail with `Missing block` on the schema tree's non-tail blocks, created during test 1.

The same pattern occurs with `distributed-transaction-validation.spec.ts` using `fretProfile: 'core'`.

### Fix

Bootstrap the `ActionContext` from the tail block before reading the rest of the chain. The header block contains `tailId`. The tail block's `state.latest` contains `{ actionId, rev }`. That's sufficient context for the coordinator to serve associated non-tail blocks.

Sequence:

1. Read header block with `context=undefined` (works — header is the collection ID block)
2. From header, extract `tailId`
3. Read tail block with `context=undefined` (works — tail was committed)
4. From tail's `state.latest`, construct `ActionContext: { committed: [{ actionId, rev }], rev }`
5. Set `source.actionContext` BEFORE `Log.open` walks the chain
6. Non-tail block reads now carry context → coordinator can serve from pending state or trigger cluster recovery

This makes every `createOrOpen` self-repairing: if the tail is ahead of the data blocks, the reader discovers the gap from the tail itself and carries the proof forward. No background process, no client-local state — subsequent readers and writers naturally converge the collection to a consistent state.

### Key Design Property

The tail block is the proof that the action succeeded. Any reader that can see the tail can construct enough context to recover the non-tail blocks. This aligns with the existing comment in `NetworkTransactor.commit()` (line 427): "rely on reconciliation paths (e.g. reads with context)."

### Tests

- Unit test: `Collection.createOrOpen` on a collection where tail is committed but a non-tail data block is only in pending state — should succeed and return the full collection state
- Integration test: two sequential `Tree.createOrOpen` calls on the same collection via `NetworkTransactor` where the first write has in-flight non-tail blocks — second open should see the first write's data
