description: Collection type registry and expanded ICollection interface
dependencies: none
files:
  - packages/db-core/src/collection/struct.ts (ICollection expanded, CollectionHeaderType removed)
  - packages/db-core/src/collection/collection-type-registry.ts (NEW - registry)
  - packages/db-core/src/collection/index.ts (exports)
  - packages/db-core/src/collections/diary/diary.ts (registers Diary type)
  - packages/db-core/src/collections/tree/struct.ts (registers Tree type)
  - packages/db-core/test/collection-type-registry.spec.ts (NEW - 11 tests)
  - packages/db-core/docs/collections.md (updated Custom Collections section + CollectionHeaderBlock)
  - packages/db-core/docs/blocks.md (updated CollectionHeaderBlock reference)
  - packages/db-core/docs/chains.md (updated CollectionHeaderBlock reference)
----

## What was built

### 1. Expanded `ICollection<TAction>` interface
Added `id`, `act()`, `updateAndSync()`, and `selectLog()` to the interface. These methods already existed
on the `Collection` class — this is interface promotion so generic framework code can work through the
interface without depending on the concrete class.

### 2. Collection type registry (`collection-type-registry.ts`)
- `registerCollectionType(descriptor)` — registers by block type, throws on duplicate
- `getCollectionType(blockType)` — lookup by block type, returns undefined if not found
- `getCollectionTypes()` — returns all registered as `ReadonlyMap`
- `CollectionTypeDescriptor` — includes `blockType`, `name`, and optional `open` factory

### 3. Built-in type registrations
- **Diary** (`"DIH"`) — registered in `diary.ts` (after class definition) with an `open` factory
  that creates a raw `Collection` with diary init options. Registered in `diary.ts` rather than
  `struct.ts` to avoid circular imports.
- **Tree** (`"TRE"`) — registered in `struct.ts` without an `open` factory (Tree requires
  `keyFromEntry` and `compare` parameters that vary per instance).

### 4. Cleanup
- Removed dead `CollectionHeaderType = 'CH'` type alias
- Simplified `CollectionHeaderBlock` to `IBlock & Partial<IChainHeader>` (collection type is
  discriminated by the block header's registered `type` field, not a separate type marker)

## Testing (11 tests in `collection-type-registry.spec.ts`)

- Built-in types: Diary and Tree are registered, listed in `getCollectionTypes()`
- Registry operations: duplicate throws, unknown returns undefined
- ICollection interface: `Collection` satisfies expanded interface (act, sync, iterate)
- Registry open factory: Diary opened via registry, append + selectLog round-trips
- Tree has no open factory: `getCollectionType("TRE")?.open` is undefined
- Custom collection type: Counter registered, created, acted on, synced, iterated, and opened via registry

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
