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

- **IChainHeader** type (`{ headId: BlockId; tailId: BlockId }`) extracted in `chain-nodes.ts`, exported through barrel. `ChainHeaderNode = IBlock & IChainHeader`.
- **Chain.create()** gained `existingHeaderId` option — reuses an already-inserted block as chain header, applying headId/tailId via `apply()`.
- **Log.create()** signature changed from positional `BlockId` to `{ newId?, existingHeaderId? }` options object, passing through to Chain.create.
- **CollectionHeaderBlock** now `IBlock & Partial<IChainHeader>`, giving typed access to `tailId` in `bootstrapContext` — eliminated `(header as any).tailId` cast.
- Removed the `// TODO: Generalize the header access...` comment.

## Testing

284 tests passing (db-core). 4 new tests:

- **chain.spec.ts**: "should create with existingHeaderId, reusing a pre-inserted block" — headId/tailId applied, upstream fields preserved
- **chain.spec.ts**: "should support full chain operations on a chain created with existingHeaderId" — add, pop, dequeue, iterate
- **chain.spec.ts**: "should throw when existingHeaderId references a non-existent block" — error path
- **log.spec.ts**: "should create a log with existingHeaderId" — full log operations, upstream fields preserved

## Usage

```typescript
// Upstream header can formally include chain fields
type MyHeader = IBlock & Partial<IChainHeader> & { myField: string };

// Create chain on pre-existing header block — no extra block
const chain = await Chain.create<Entry>(store, { existingHeaderId: myHeader.header.id });

// Same for logs
const log = await Log.create<Action>(store, { existingHeaderId: myHeader.header.id });
```
