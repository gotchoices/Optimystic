# Chain Header Merge: IChainHeader Interface Extraction

description: Extract IChainHeader interface so upstream headers (e.g. CollectionHeaderBlock) can formally include chain pointer fields, eliminating type-unsafe casts and clarifying the already-existing runtime merge pattern.
dependencies: none
files:
  - packages/db-core/src/chain/chain-nodes.ts — define IChainHeader, refactor ChainHeaderNode
  - packages/db-core/src/chain/chain.ts — update Chain.create() to support existing header blocks
  - packages/db-core/src/chain/index.ts — export chain-nodes
  - packages/db-core/src/collection/struct.ts — extend CollectionHeaderBlock with Partial<IChainHeader>
  - packages/db-core/src/collection/collection.ts — remove `any` cast in bootstrapContext
  - packages/db-core/src/log/log.ts — update Log.create() to accept existingHeaderId
  - packages/db-core/docs/chains.md — document IChainHeader and merged header pattern
  - packages/db-core/docs/logs.md — note that log headers can be merged into upstream headers
  - packages/db-core/test/chain.spec.ts — add tests for merged header creation
  - packages/db-core/test/log.spec.ts — add test for log with existing header

----

## Context

At runtime, the chain header merge already happens for the collection case: `Collection.createOrOpen()` inserts a `CollectionHeaderBlock`, then `Chain.open()` dynamically adds `headId`/`tailId` to it via `apply()`. The collection header and chain header are the **same block** (same ID). There is no extra level of indirection.

However, the type system doesn't express this. `CollectionHeaderBlock` doesn't include `headId`/`tailId`, so `bootstrapContext` at `collection.ts:259` casts through `any`:
```typescript
const tailId = Object.hasOwn(header, 'tailId') ? (header as any).tailId as BlockId : undefined;
```

Additionally, collections use `Log.open()` for *new* logs (line 59) because `Log.create()` → `Chain.create()` always inserts a new header block, which would conflict with the already-inserted collection header.

## Design

### IChainHeader interface (chain-nodes.ts)

Extract the chain pointer fields into a standalone interface:

```typescript
export type IChainHeader = {
    headId: BlockId;
    tailId: BlockId;
};

export type ChainHeaderNode = IBlock & IChainHeader;
```

`ChainHeaderNode` is unchanged structurally — it just extends the new interface. All existing code referencing `ChainHeaderNode` continues to work.

### Chain.create() existing-header support (chain.ts)

Add an `existingHeaderId` option to `ChainCreateOptions`:

```typescript
export type ChainCreateOptions<TEntry> = ChainInitOptions<TEntry> & {
    newId?: BlockId;
    /** Use an already-inserted block as the chain header instead of creating a new one.
     *  headId and tailId will be set on it via apply(). */
    existingHeaderId?: BlockId;
};
```

When `existingHeaderId` is provided, `Chain.create()` fetches the existing block and sets `headId`/`tailId` on it via `apply()` instead of inserting a new header block. This makes the merge pattern explicit rather than relying on `Chain.open()`'s "missing field" fallback.

### CollectionHeaderBlock (collection/struct.ts)

Extend with `Partial<IChainHeader>` so that chain fields are part of the type:

```typescript
import type { IChainHeader } from "../chain/chain-nodes.js";

export type CollectionHeaderBlock = IBlock & Partial<IChainHeader> & {
    header: {
        type: CollectionHeaderType;
    };
};
```

### bootstrapContext cleanup (collection/collection.ts)

Replace the `any` cast with proper typed access:

```typescript
const tailId = header.tailId;  // now typed via Partial<IChainHeader>
```

### Log.create() support (log/log.ts)

Update `Log.create()` to accept an optional `existingHeaderId`, passing it through to `Chain.create()`:

```typescript
static async create<TAction>(store: BlockStore<IBlock>, options?: { newId?: BlockId; existingHeaderId?: BlockId }) {
    return new Log<TAction>(await Chain.create<LogEntry<TAction>>(store, {
        ...Log.getChainOptions(store),
        newId: options?.newId,
        existingHeaderId: options?.existingHeaderId,
    }));
}
```

This is a breaking signature change for `Log.create()` (second param changes from `BlockId` to options object). Update the single call site in `Collection.createOrOpen()` accordingly.

### Barrel export (chain/index.ts)

Add export of chain-nodes so `IChainHeader` is available through the standard barrel:

```typescript
export * from "./chain.js";
export * from "./chain-nodes.js";
```

### Documentation updates

- **chains.md**: Add section on `IChainHeader` and the merged header pattern, showing how upstream headers can include chain pointer fields.
- **logs.md**: Note that `Log.create()` accepts `existingHeaderId` for embedded log headers.

## TODO

### Phase 1: Interface & types
- Define `IChainHeader` in `chain-nodes.ts`, refactor `ChainHeaderNode` to extend it
- Export `chain-nodes.ts` from `chain/index.ts`
- Update `CollectionHeaderBlock` in `collection/struct.ts` to include `Partial<IChainHeader>`

### Phase 2: Chain.create() with existing header
- Add `existingHeaderId` to `ChainCreateOptions` in `chain.ts`
- Implement the existing-header path in `Chain.create()`: fetch block, apply headId/tailId, skip insert
- Remove the TODO comment at line 28

### Phase 3: Log.create() update
- Change `Log.create()` signature to accept options object with `newId?` and `existingHeaderId?`
- Update `Collection.createOrOpen()` call site (line 59) — could use `Log.create()` with `existingHeaderId` instead of `Log.open()` for new collections

### Phase 4: Type cleanup
- Replace `(header as any).tailId` in `bootstrapContext` with typed access through `CollectionHeaderBlock`
- Cast the header parameter in `bootstrapContext` to `CollectionHeaderBlock` (it already is, but the signature uses `IBlock`)

### Phase 5: Tests
- **chain.spec.ts**: Test `Chain.create()` with `existingHeaderId` — verify chain operations work on a pre-existing header block
- **chain.spec.ts**: Test that an existing header block gets `headId`/`tailId` set by `Chain.create()`
- **log.spec.ts**: Test `Log.create()` with `existingHeaderId` option

### Phase 6: Documentation
- Update `chains.md` with `IChainHeader` section and merged header usage
- Update `logs.md` with `existingHeaderId` option documentation

### Phase 7: Build & test
- Run `yarn build` and `yarn test` from `packages/db-core`
