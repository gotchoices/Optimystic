description: Add collection type registry and expand ICollection interface to support custom collection types
dependencies: none (builds on existing Collection<TAction> infrastructure)
files:
  - packages/db-core/src/collection/struct.ts (ICollection interface - expand)
  - packages/db-core/src/collection/collection.ts (Collection class - already implements needed methods)
  - packages/db-core/src/collection/collection-type-registry.ts (NEW - registry)
  - packages/db-core/src/collection/index.ts (exports)
  - packages/db-core/src/collections/diary/struct.ts (register built-in type)
  - packages/db-core/src/collections/tree/struct.ts (register built-in type)
  - packages/db-core/test/collection-type-registry.spec.ts (NEW - tests)
  - packages/db-core/test/test-transactor.ts (existing test helper)
  - packages/db-core/docs/collections.md (update docs)
----

## Context

The `Collection<TAction>` class with `CollectionInitOptions<TAction>` already provides the mechanical
extensibility for custom collection types. Diary and Tree are thin wrappers that define action handlers
and a header block factory, then delegate to `Collection.createOrOpen()`. Consumers can follow this
pattern today, but two concrete gaps prevent the system from treating collection types as first-class:

1. **`ICollection<TAction>` is too minimal** — only `update()` and `sync()`. Generic framework code
   (e.g. quereus plugin, management tools) can't act on, iterate, or even identify a collection through
   the interface. The `Collection` class has `id`, `act()`, `updateAndSync()`, and `selectLog()` but
   these aren't on the interface.

2. **No collection type registry** — given a header block (whose `header.type` is `"DIH"`, `"TRE"`,
   or a custom type), there's no way to discover what kind of collection it represents or how to
   instantiate the right wrapper. Each block header type (`registerBlockType`) uniquely identifies
   a collection type, but nothing maps these to collection-level metadata or factories.

Additionally, `CollectionHeaderType = 'CH'` in `struct.ts` is dead code — the actual header block types
are the registered block types (`"DIH"`, `"TRE"`). This should be cleaned up.

## Design

### 1. Expand `ICollection<TAction>` Interface

Add the common operations that `Collection` already implements:

```typescript
// In collection/struct.ts
export interface ICollection<TAction> {
    readonly id: CollectionId;
    act(...actions: Action<TAction>[]): Promise<void>;
    update(): Promise<void>;
    sync(): Promise<void>;
    updateAndSync(): Promise<void>;
    selectLog(forward?: boolean): AsyncIterableIterator<Action<TAction>>;
}
```

The `Collection` class already has all these methods — this is just interface promotion.
No changes needed to Diary or Tree (they wrap Collection, they don't implement ICollection directly).

### 2. Collection Type Registry

New file `collection/collection-type-registry.ts`:

```typescript
export interface CollectionTypeDescriptor {
    /** The block type used for this collection's header block (e.g. "DIH", "TRE") */
    blockType: BlockType;
    /** Human-readable name (e.g. "Diary", "Tree") */
    name: string;
    /** Optional factory to open a collection with default settings.
     *  Not all types support this (e.g. Tree requires keyFromEntry/compare). */
    open?: (transactor: ITransactor, id: CollectionId) => Promise<ICollection<any>>;
}
```

Functions:
- `registerCollectionType(descriptor)` — registers a collection type by its block type. Throws if already registered (same pattern as `registerBlockType`).
- `getCollectionType(blockType)` — looks up a descriptor by block type. Returns undefined if not found.
- `getCollectionTypes()` — returns all registered descriptors as a `ReadonlyMap`.

### 3. Register Built-in Types

Diary registers itself in `collections/diary/struct.ts` (side-effect, same pattern as `registerBlockType`):
```typescript
registerCollectionType({
    blockType: DiaryHeaderBlockType,
    name: "Diary",
    open: (transactor, id) => Diary.create(transactor, id),
});
```

Tree registers itself in `collections/tree/struct.ts`:
```typescript
registerCollectionType({
    blockType: TreeHeaderBlockType,
    name: "Tree",
    // No default `open` — Tree requires keyFromEntry and compare parameters
});
```

Note: Diary's `open` is straightforward. Tree cannot provide a default `open` because it requires
`keyFromEntry` and `compare` parameters that vary per instance. This is by design — the registry
supports type identification even when generic opening isn't possible.

### 4. Clean up `CollectionHeaderType`

Remove the dead `CollectionHeaderType = 'CH'` type alias and the corresponding field from
`CollectionHeaderBlock`. The actual collection type discriminator is the block header's `type` field
(a registered `BlockType`). `CollectionHeaderBlock` should just be `IBlock` — the collection header
is identified by having `header.id === collectionId`, not by a special type marker.

Check for any references before removing — `CollectionHeaderBlock` is referenced in `struct.ts`
(the type) and `collection.ts` (line 46 cast). Update these references.

### 5. Update Exports

Add to `collection/index.ts`:
```typescript
export * from "./collection-type-registry.js";
```

This makes `registerCollectionType`, `getCollectionType`, `getCollectionTypes`, and
`CollectionTypeDescriptor` available from `@optimystic/db-core`.

## Tests

New file: `packages/db-core/test/collection-type-registry.spec.ts`

Key test cases:

- **Registry basics**: register a type, look it up, get all types, duplicate registration throws
- **Built-in types registered**: after importing collections, Diary ("DIH") and Tree ("TRE") are in the registry
- **Custom collection type end-to-end**: define a simple custom collection (e.g. Counter that tracks
  an integer via increment/decrement actions), register it, create an instance via the registry's
  `open`, perform actions, verify sync works, verify log iteration works
- **ICollection interface**: verify that `Collection` satisfies the expanded `ICollection` interface
  (acts, syncs, reads log through the interface type)
- **Registry open with default factory**: open a Diary through the registry's generic `open` function,
  append entries, verify they round-trip through `selectLog`
- **Type without open factory**: Tree is registered but has no `open` — verify `getCollectionType("TRE")?.open`
  is undefined

## TODO

### Phase 1: Interface and Registry
- Expand `ICollection<TAction>` in `collection/struct.ts` to include `id`, `act`, `updateAndSync`, `selectLog`
- Clean up `CollectionHeaderType = 'CH'` — remove the dead type and update `CollectionHeaderBlock`
- Create `collection/collection-type-registry.ts` with `registerCollectionType`, `getCollectionType`, `getCollectionTypes`
- Export new module from `collection/index.ts`

### Phase 2: Built-in Registration
- Register Diary type in `collections/diary/struct.ts` (note: circular import risk — Diary.create is in diary.ts, struct.ts imports from index; may need to register in diary.ts or a separate init file instead)
- Register Tree type in `collections/tree/struct.ts` (simpler — no factory, just metadata)

### Phase 3: Tests
- Write registry unit tests (register, lookup, duplicate, enumeration)
- Write custom collection type test (define Counter, register, create, act, sync, verify)
- Write ICollection interface test (use Collection through ICollection type)
- Verify existing tests still pass (diary, tree, collection tests)

### Phase 4: Docs
- Update `packages/db-core/docs/collections.md` "Custom Collections" section to reference the registry pattern
- Add example showing how to register a custom collection type

### Build and test
- Run `npm run build` and `npm test` across db-core to verify no regressions
