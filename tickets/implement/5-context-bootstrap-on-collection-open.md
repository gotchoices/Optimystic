description: Bootstrap ActionContext from committed tail block in Collection.createOrOpen before walking the log chain — fixes Missing Block when non-tail blocks are still pending after a partial commit
dependencies: 5-pending-block-context-serving (storage-side complement; both needed for full convergence)
files:
  - packages/db-core/src/collection/collection.ts — Collection.createOrOpen, updateInternal
  - packages/db-core/src/transactor/transactor-source.ts — TransactorSource.tryGet
  - packages/db-core/src/chain/chain.ts — Chain.open, getTail, select
  - packages/db-core/src/chain/chain-nodes.ts — ChainHeaderNode (tailId field)
  - packages/db-core/src/log/log.ts — Log.open, getActionContext
  - packages/db-core/src/network/struct.ts — BlockGets, GetBlockResult, BlockActionState
  - packages/db-core/src/collection/action.ts — ActionContext, ActionRev
  - packages/db-core/test/test-transactor.ts — TestTransactor.get (needs context.committed support)
  - packages/db-core/test/collection.spec.ts — new tests
----

## Root cause

`Collection.createOrOpen` constructs a `TransactorSource` with `actionContext: undefined`, then calls `Log.open` → `Chain.open` → `log.getActionContext()`. Every block read during this sequence passes `context: undefined` to the transactor. When a prior commit completed its tail but non-tail blocks are still in-flight (pending), coordinators can't serve those pending blocks without context proving the reader is aware of the committed action. Result: `Missing block`.

```
Collection.createOrOpen(transactor, id, init)
  source = new TransactorSource(id, transactor, undefined)    ← context=undefined
  header = await source.tryGet(id)                            ← OK (header committed)
  log = await Log.open(tracker, id)                           ← chain walk may need pending blocks
    source.tryGet(nonTailBlockId) with context=undefined       ← coordinator can't serve
      💥 Missing block
  source.actionContext = await log.getActionContext()          ← never reached
```

The `ActionContext` that would let coordinators serve in-flight blocks is derived from the log — but reading the log requires the very blocks that need context. Chicken-and-egg.

## Fix

Bootstrap `ActionContext` from the committed tail block's state BEFORE walking the chain. The tail was committed first (commit protocol guarantees this), so it's always readable. Its `state.latest` contains the `ActionRev` of the most recent committed action — exactly the proof needed.

### In `Collection.createOrOpen` (line 48, the `if (header)` branch)

After reading the header block, before `Log.open`:

1. Extract `tailId` from the header block (the collection header doubles as the chain header — it has `headId`/`tailId` properties set by `Chain.open`)
2. Read the tail block directly from the transactor with `context: undefined` — this succeeds because the tail was committed
3. From the tail's `state.latest` (`ActionRev`), construct a bootstrap `ActionContext`: `{ committed: [{ actionId, rev }], rev }`
4. Set `source.actionContext` to this bootstrap context
5. Proceed with `Log.open` — the source now carries context for all subsequent reads
6. After `log.getActionContext()` returns the full context, overwrite `source.actionContext` with it (existing line)

```typescript
if (header) {
    // Bootstrap ActionContext from the committed tail before walking the chain
    const tailId = Object.hasOwn(header, 'tailId') ? (header as any).tailId as BlockId : undefined;
    if (tailId) {
        const tailResult = await transactor.get({ blockIds: [tailId] });
        const tailState = tailResult?.[tailId]?.state;
        if (tailState?.latest) {
            source.actionContext = {
                committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
                rev: tailState.latest.rev,
            };
        }
    }

    const log = (await Log.open<Action<TAction>>(tracker, id))!;
    source.actionContext = await log.getActionContext();  // existing line — refines to full context
}
```

Key points:
- `tailId` access uses `Object.hasOwn` check — consistent with `Chain.open`'s pattern for accessing chain properties on the collection header block
- The transactor `get` call uses `context: undefined` (omitted) for the tail — this is safe because the tail was committed
- If `tailId` or `state.latest` is absent (fresh collection, never committed), no bootstrap occurs — falls through to existing behavior
- The `log.getActionContext()` call on the next line overwrites the bootstrap context with the full context derived from walking the log — the bootstrap is only a stepping stone

### In `Collection.updateInternal` (line 99)

Same pattern applies. `updateInternal` creates a fresh `TransactorSource` with `context: undefined` and calls `Log.open`. Add the bootstrap between source creation and `Log.open`:

```typescript
private async updateInternal() {
    const source = new TransactorSource(this.id, this.transactor, undefined);
    const tracker = new Tracker(source);

    // Bootstrap context from committed tail
    const header = await source.tryGet(this.id);
    if (header) {
        const tailId = Object.hasOwn(header, 'tailId') ? (header as any).tailId as BlockId : undefined;
        if (tailId) {
            const tailResult = await this.transactor.get({ blockIds: [tailId] });
            const tailState = tailResult?.[tailId]?.state;
            if (tailState?.latest) {
                source.actionContext = {
                    committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
                    rev: tailState.latest.rev,
                };
            }
        }
    }

    const actionContext = this.source.actionContext;
    const log = await Log.open<Action<TAction>>(tracker, this.id);
    // ... existing code
}
```

Note: the explicit header read caches in the tracker, so `Chain.open` inside `Log.open` reuses it. No duplicate transactor calls.

### Consider extracting a helper

Both `createOrOpen` and `updateInternal` share the bootstrap pattern. Extract a private static method:

```typescript
private static async bootstrapContext(
    source: TransactorSource<IBlock>,
    transactor: ITransactor,
    header: IBlock,
): Promise<void> {
    const tailId = Object.hasOwn(header, 'tailId') ? (header as any).tailId as BlockId : undefined;
    if (tailId) {
        const tailResult = await transactor.get({ blockIds: [tailId] });
        const tailState = tailResult?.[tailId]?.state;
        if (tailState?.latest) {
            source.actionContext = {
                committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
                rev: tailState.latest.rev,
            };
        }
    }
}
```

## Test infrastructure: TestTransactor enhancement

The `TestTransactor.get()` method needs to serve pending blocks when `context.committed` includes a matching `actionId`. Currently it only serves pending blocks for `context.actionId` (the in-flight writer case). This enhancement is needed for the test to verify the fix end-to-end.

In `packages/db-core/test/test-transactor.ts`, modify the `get` method's block resolution logic:

```typescript
// Current: three branches — actionId, rev, latest
// New: add context.committed check between actionId and rev branches

let block: IBlock | undefined;
if (blockGets.context?.actionId !== undefined) {
    // Existing: serve pending for specific in-flight action
    const pendingTransform = blockState.pendingActions.get(blockGets.context.actionId);
    if (pendingTransform) {
        const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
        block = applyTransformSafe(baseBlock, pendingTransform);
    } else {
        block = undefined;
    }
} else {
    // NEW: Check context.committed for matching pending actions
    if (blockGets.context?.committed) {
        for (const { actionId: cId } of blockGets.context.committed) {
            const pendingTransform = blockState.pendingActions.get(cId);
            if (pendingTransform) {
                const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
                block = applyTransformSafe(baseBlock, pendingTransform);
                break;
            }
        }
    }
    // Fall through to standard resolution if no pending match
    if (block === undefined) {
        if (blockGets.context?.rev !== undefined) {
            block = structuredClone(latestMaterializedAt(blockState, blockGets.context.rev));
        } else {
            block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
        }
    }
}
```

This mirrors the real coordinator behavior: context.committed proves the action succeeded, so pending blocks for that action should be served.

## Test plan

### Test 1: Unit — createOrOpen succeeds with pending non-tail blocks

Scenario: partial commit where tail + header are committed, chain data blocks and action handler blocks are pending.

```
1. Create a PartialCommitTransactor wrapper around TestTransactor:
   - partialMode: boolean — when true, commit() only commits headerId + tailId blocks
   - Delegates all other methods to inner TestTransactor

2. Create collection, add 33+ entries in separate syncs (fills first log chain
   block at 32 entries, overflows to second block on entry 33) — partialMode OFF

3. Turn partialMode ON. Add one more entry + sync.
   - The sync overflows the log chain if entry 33 hasn't yet (or creates a new
     action that extends the chain)
   - With partialMode: only header and tail block are committed
   - Old chain data block's update (nextId) and action handler blocks remain pending

4. Create a fresh collection handle: Collection.createOrOpen(wrapper, id, init)
   - Without fix: chain walk reads old block with context=undefined → missing block data
   - With fix: bootstrap context from tail → chain walk gets pending block via context.committed

5. Assert: createOrOpen succeeds, returned collection can iterate log and see all entries
```

### Test 2: Unit — createOrOpen with newly created collection (partial commit on first sync)

```
1. Use PartialCommitTransactor with partialMode ON from the start
2. Create collection, add entry, sync — only header + tail committed
3. Create fresh collection handle via createOrOpen
4. Assert: succeeds and reads the log entry
```

### Test 3: Verify updateInternal also works with partial commit

```
1. Create and sync collection normally (partialMode OFF)
2. partialMode ON, add entry + sync (partial commit)
3. On a DIFFERENT collection handle (same id), call update()
4. Assert: update succeeds and sees the new entry
```

### PartialCommitTransactor (test helper)

```typescript
class PartialCommitTransactor implements ITransactor {
    partialMode = false;
    constructor(private inner: TestTransactor) {}

    get = (b: BlockGets) => this.inner.get(b);
    getStatus = (a: ActionBlocks[]) => this.inner.getStatus(a);
    pend = (r: PendRequest) => this.inner.pend(r);
    cancel = (a: ActionBlocks) => this.inner.cancel(a);

    async commit(request: CommitRequest) {
        if (this.partialMode) {
            // Only commit header (if present) and tail — leave rest as pending
            const committed = request.blockIds.filter(id =>
                id === request.tailId || id === request.headerId
            );
            return this.inner.commit({ ...request, blockIds: committed });
        }
        return this.inner.commit(request);
    }
}
```

## Relationship to companion ticket

| Ticket | Side | What it does |
|--------|------|-------------|
| **This ticket** | Read/client | Bootstraps ActionContext from committed tail so reads carry proof |
| **5-pending-block-context-serving** | Storage/coordinator | Uses proof in context to serve and promote pending blocks |

Both are needed for full convergence. Without bootstrap, readers never send proof. Without coordinator support, proof arrives but is ignored. The TestTransactor enhancement in this ticket is the test-infrastructure analog of the coordinator fix.

---

## TODO

### Phase 1: Test infrastructure
- Enhance `TestTransactor.get()` in `packages/db-core/test/test-transactor.ts` to serve pending blocks when `context.committed` includes a matching actionId
- Create `PartialCommitTransactor` test helper (in `test/test-transactor.ts` or inline in the test)

### Phase 2: Fix
- Extract `bootstrapContext` helper in `Collection` class (`packages/db-core/src/collection/collection.ts`)
- Apply bootstrap in `Collection.createOrOpen` — after header read, before `Log.open`
- Apply bootstrap in `Collection.updateInternal` — after fresh source creation, before `Log.open`

### Phase 3: Tests
- Add test: createOrOpen with partial commit (chain overflow scenario, 33+ entries)
- Add test: createOrOpen with partial commit on first sync (newly created collection)
- Add test: updateInternal with partial commit
- Verify all existing collection tests still pass

### Phase 4: Build & verify
- Run `npm run build` in packages/db-core
- Run full test suite: `npm run test` in packages/db-core
- Verify no regressions
