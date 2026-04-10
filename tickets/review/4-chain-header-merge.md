# Chain Header Merge: IChainHeader Interface Extraction

description: Extracted IChainHeader interface so upstream headers can formally include chain pointer fields, eliminating type-unsafe casts and making the merged header pattern explicit.
dependencies: none
files:
  - packages/db-core/src/chain/chain-nodes.ts — IChainHeader type, ChainHeaderNode extends it
  - packages/db-core/src/chain/chain.ts — Chain.create() existingHeaderId support
  - packages/db-core/src/chain/index.ts — barrel export of chain-nodes
  - packages/db-core/src/collection/struct.ts — CollectionHeaderBlock extends Partial<IChainHeader>
  - packages/db-core/src/collection/collection.ts — bootstrapContext uses typed access (no `any` cast)
  - packages/db-core/src/log/log.ts — Log.create() accepts options object with existingHeaderId
  - packages/db-core/docs/chains.md — IChainHeader and merged header pattern docs
  - packages/db-core/docs/logs.md — existingHeaderId option docs
  - packages/db-core/test/chain.spec.ts — 3 new tests for existingHeaderId
  - packages/db-core/test/log.spec.ts — 1 new test for existingHeaderId

----

## What was built

### IChainHeader interface
Extracted `{ headId: BlockId; tailId: BlockId }` into `IChainHeader` in `chain-nodes.ts`. `ChainHeaderNode` is now `IBlock & IChainHeader` — structurally identical, but the fields are reusable. Exported through `chain/index.ts` barrel.

### Chain.create() with existingHeaderId
`ChainCreateOptions` gained an `existingHeaderId?: BlockId` option. When provided, `Chain.create()` fetches the existing block and applies `headId`/`tailId` via `apply()` instead of inserting a new header. Throws if the block doesn't exist.

### Log.create() signature change
`Log.create()` second parameter changed from `BlockId` (positional `newId`) to `{ newId?: BlockId; existingHeaderId?: BlockId }`. All existing callers pass no second arg, so this is backwards-compatible at the call site level.

### CollectionHeaderBlock type safety
`CollectionHeaderBlock` now extends `Partial<IChainHeader>`, so `headId` and `tailId` are part of the type. The `bootstrapContext` method parameter narrowed from `IBlock` to `CollectionHeaderBlock`, eliminating the `(header as any).tailId` cast.

### Removed TODO
The `// TODO: Generalize the header access...` comment at chain.ts:28 was removed — this ticket implements that generalization.

## Testing notes

4 new tests added (273 total, all passing):

- **chain.spec.ts**: "should create with existingHeaderId, reusing a pre-inserted block" — verifies headId/tailId are applied and upstream fields preserved
- **chain.spec.ts**: "should support full chain operations on a chain created with existingHeaderId" — add, pop, dequeue, iterate
- **chain.spec.ts**: "should throw when existingHeaderId references a non-existent block" — error path
- **log.spec.ts**: "should create a log with existingHeaderId" — full log operations on merged header, upstream fields preserved

## Usage

```typescript
// Upstream header can now formally include chain fields
type MyHeader = IBlock & Partial<IChainHeader> & { myField: string };

// Create chain on pre-existing header block — no extra block
const chain = await Chain.create<Entry>(store, { existingHeaderId: myHeader.header.id });

// Same for logs
const log = await Log.create<Action>(store, { existingHeaderId: myHeader.header.id });
```
