description: Collection type registry and expanded ICollection interface
dependencies: none
files:
  - packages/db-core/src/collection/struct.ts (ICollection expanded, CollectionHeaderType removed)
  - packages/db-core/src/collection/collection-type-registry.ts (registry)
  - packages/db-core/src/collection/index.ts (exports)
  - packages/db-core/src/collections/diary/diary.ts (registers Diary type)
  - packages/db-core/src/collections/tree/struct.ts (registers Tree type)
  - packages/db-core/test/collection-type-registry.spec.ts (11 tests)
  - packages/db-core/docs/collections.md (Custom Collections section + CollectionHeaderBlock)
  - packages/db-core/docs/blocks.md (CollectionHeaderBlock reference)
  - packages/db-core/docs/chains.md (CollectionHeaderBlock reference)
----

## Summary

Added a collection type registry (`registerCollectionType`, `getCollectionType`, `getCollectionTypes`)
that maps block header types to collection-level metadata and optional open factories. Expanded
`ICollection<TAction>` to include `id`, `act()`, `updateAndSync()`, and `selectLog()` — promoting
methods already on the concrete `Collection` class to the interface. Built-in Diary (`"DIH"`) and
Tree (`"TRE"`) types self-register via side-effect imports.

Cleaned up dead `CollectionHeaderType` alias and simplified `CollectionHeaderBlock` to
`IBlock & Partial<IChainHeader>`.

## Testing

11 tests in `collection-type-registry.spec.ts`:
- Built-in Diary and Tree registered with expected descriptors
- `getCollectionTypes()` returns both built-ins
- Duplicate registration throws
- Unknown block type returns undefined
- `Collection` satisfies `ICollection` (act, updateAndSync, selectLog round-trip)
- Diary opened via registry factory, append + selectLog round-trips
- Tree has no open factory (requires parameters)
- Custom Counter type: register, lookup, create, act, sync, iterate, and open via factory

## Review notes

- Registry is clean: module-level Map, small single-purpose functions, ReadonlyMap return
- No DRY violations, no security issues, no resource leaks
- Docs updated in collections.md, blocks.md, chains.md
- Removed unused type imports from test file during review
- Build and all 284 tests pass

## Usage

```typescript
import {
  registerCollectionType, getCollectionType, getCollectionTypes,
  type CollectionTypeDescriptor, type ICollection
} from '@optimystic/db-core';

// Register a custom type
registerCollectionType({ blockType: "MYT", name: "MyType", open: myFactory });

// Look up and open via registry
const desc = getCollectionType("DIH");
const collection = await desc?.open?.(transactor, id);

// Use expanded ICollection interface
await collection.act({ type: 'append', data: someData });
await collection.updateAndSync();
for await (const action of collection.selectLog()) { ... }
```
