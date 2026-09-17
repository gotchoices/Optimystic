description: Each table keeps a history of its changes, and that history is meant to be summarized now and then so readers do not have to walk all of it. Nothing ever writes the summary, so every refresh walks the whole history and every block request carries a list of every write ever made. Both costs grow without limit as a table is used.
files:
  - packages/db-core/src/log/log.ts (`addCheckpoint` — no caller outside tests; `getFrom`, `findCheckpoint`, `getActionContext`)
  - packages/db-core/src/log/struct.ts (`CheckpointEntry`)
  - packages/db-core/src/collection/collection.ts (`updateInternal`, `advanceContext`; the sync/commit path that could append a checkpoint)
  - packages/db-core/src/transactor/transactor-source.ts (line 44 — `context: this.actionContext` sent on every get)
  - packages/db-p2p/src/storage/storage-repo.ts (~line 310–345 — uses `context.committed` to serve pending blocks)
  - docs/architecture.md (line ~130, "CHECKPOINT — each collection's log appends a checkpoint entry", describes a step that does not happen)
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: A checkpoint changes what "the committed list" means to storage when it serves a block that is still pending, so getting its contents wrong could hide rows. Today's cost is linear and small for young tables, so a maintainer may prefer to wait until a real deployment's tables are old enough to feel it.
----
# The collection log never writes a checkpoint, so the context and the refresh walk grow with every write

## Measured

A db-core counting test (see `refresh-of-an-unchanged-collection-refetches-the-same-blocks`) wrote 500 single-row writes, then refreshed a second handle:

- The handle's `actionContext.committed` held **500** entries. `TransactorSource.tryGet` sends that context with every block `get` (`transactor-source.ts:44`), so on a p2p node every read request carries it over the wire.
- A refresh made 22 `get` calls, against 8 after 50 writes. The extra calls are `Log.getFrom` walking back through every log block (32 entries per block).

## Why

`Log.getFrom` walks backwards to the most recent checkpoint, collecting every action as "pending" for the context ("Can't stop at rev, because we need to collect all pending actions for the context"). `findCheckpoint` and `getActionContext` do the same. `Log.addCheckpoint` exists, but `git log -S "addCheckpoint("` shows it was only ever called from tests. `docs/architecture.md` lists checkpointing as a commit step, but no code path performs it.

## What a fix has to decide

- **When** to append a checkpoint. Candidates: every K entries on the commit path, or when the tail block rolls over.
- **What `pendings` must restate.** Actions whose non-tail blocks might not yet be committed on every member are the ones storage needs `context.committed` for, to serve pending blocks (`storage-repo.ts` ~310–345). A checkpoint that drops an action too early makes those blocks unreadable to readers pinned below it.
- **Interaction** with torn-write completion (`Collection.completeOwnEntry` reads its own entry's rev out of `context.committed`; entries older than a checkpoint fall back to the attempt's rev) and with durable invalidation walks (`findInvalidation` scans the whole chain regardless).
