description: Review the change that emits a CollectionChangeEvent when a block lands on a node via churn re-replication, so reactive watchers on the new owner are woken.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: easy
----

## What was done

`StorageRepo.saveReplicatedBlock` now emits a tail-less `CollectionChangeEvent` after a genuine advance, matching the read-driven promotion path. The commit path latch already covered the entire `getLatest` + `saveReplica` + advancement-detect sequence, so the decision is race-free.

### Key change (`storage-repo.ts`, `saveReplicatedBlock`)

- Reads `priorLatest = await storage.getLatest()` inside the latch, before `saveReplica`.
- Captures `effective = await storage.saveReplica(block, source)`.
- Derives `advanced = priorLatest === undefined || effective.rev > priorLatest.rev`.
- Guards on `block.header?.collectionId !== undefined` (mirrors `internalCommit`'s headerless defense).
- Emits via `this.emitCollectionChanges(...)` **after** `release()`, matching commit's post-latch ordering.
- No `tailId` is passed — correct for a tail-less event; the cohort-topic bridge drops such events via its `selfIsCohortMember` gate.

`BlockStorage.saveReplica` signature is unchanged.

### Tests added (`storage-repo.spec.ts`, new `describe('change notification on replica-persist')`)

6 tests covering:
1. Fresh replica fires exactly one event with correct `collectionId`, `blockIds`, `actionId`, `rev`, and `tailId === undefined`.
2. Idempotent re-push (same `{ actionId, rev }`) fires no additional event.
3. Older-rev re-push after a newer replica fires no event.
4. Distinct collection subscriber stays silent when a different collection's block is replicated.
5. No event when block already at equal rev via the normal commit path.
6. Catch-all feed (`onAnyCollectionChange`) also receives the fresh-replica event exactly once.

## Validation

`yarn build` and `yarn test` in `packages/db-p2p`: **1016 passing, 31 pending, 0 failures** (exit 0).

## Use cases for testing

- Subscribe to a collection on a fresh node, then call `saveReplicatedBlock` on a block belonging to that collection — the subscriber should fire exactly once.
- Re-call `saveReplicatedBlock` with the same `(blockId, source)` — the subscriber must not fire again.
- Call with an older `source.rev` than already held — no event.
- Call with no `source` (nil `rev`/`actionId`) — the hash-based fallback `actionId` is used; one event fires on first push, none on exact re-push.

## Known gaps / reviewer notes

- No end-to-end multi-node integration test for the reactive-watch path. That is tracked in `tickets/backlog/enhancements/optimystic-network-reactive-watch-integration-test.md`.
- The `changeListeners` registry is node-local — this change does not affect cross-node behavior. The cohort-topic bridge's `selfIsCohortMember` gate is relied on (not tested here) to prevent a tail-less replica event from re-originating a signed cohort-topic notification.

## Review findings

*(to be filled in by reviewer)*
