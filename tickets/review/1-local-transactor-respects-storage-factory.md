description: Review the `rawStorageFactory` option that lets bootstrap-mode (`transactor: 'local'`) writes land in a host-supplied persistent backend instead of the hardcoded `MemoryRawStorage`.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/types.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/test/local-transactor-storage.spec.ts
----

## What changed

Added an optional `rawStorageFactory?: () => IRawStorage` to both `OptimysticOptions` and `ParsedOptimysticOptions`. The `'local'` transactor branch in `CollectionFactory` now consumes it:

```ts
private async createLocalTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
  const rawStorage = options.rawStorageFactory?.() ?? new MemoryRawStorage();
  const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));
  // …unchanged wrapper…
}
```

`createTestTransactor` and the `'test'` switch case are intentionally untouched (callers want ephemeral storage).

Forwarded the option through the two non-spread `ParsedOptimysticOptions` builders in `optimystic-module.ts`:

- `createSchemaManager`: explicit copy now includes `rawStorageFactory: tableOptions.rawStorageFactory`.
- `parseTableSchema`: pulls a function reference off `vtabAuxData['rawStorageFactory']` (plugin-level config), since per-table `USING optimystic(...)` args can't carry function values. The two existing `indexOptions` builders use `{ ...this.options, ... }` and pick the field up automatically.

## How to test

`packages/quereus-plugin-optimystic/test/local-transactor-storage.spec.ts` covers:

- **Factory honoured**: passes a `CountingRawStorage` (subclass of `MemoryRawStorage` that increments a counter on each save method) via `rawStorageFactory`, drives a `Tree.replace` through the local transactor, and asserts the factory was invoked **and** the supplied storage observed at least one write.
- **Default still works**: same flow with no factory — write succeeds, no assertion on internal state.

Run:

```bash
yarn workspace @optimystic/quereus-plugin-optimystic build
yarn workspace @optimystic/quereus-plugin-optimystic test --grep "local transactor honours rawStorageFactory"
```

Full suite stayed green (185 passing, 4 pending).

## Verification checklist for the reviewer

- Confirm there is no behavioural change when `rawStorageFactory` is omitted (existing tests cover this; the default path remains `new MemoryRawStorage()`).
- Confirm `createTestTransactor` is unchanged.
- Confirm the option flows through the schema-tree and index-tree builders so persistent storage is shared across the table, schema, and indexes (relevant for the downstream sereus `wire-strand-storage-into-bootstrap-transactor` ticket that consumes this hook).
- Pre-existing typecheck errors in `index-manager.ts` and `manual-mesh-test.ts` are unrelated to this change (verified by stashing the working tree and re-running `tsc --noEmit`).

## Downstream consumer

The sereus-health repo's ticket `wire-strand-storage-into-bootstrap-transactor` is the consumer — it'll wire its RN/MMKV-backed `IRawStorage` into the plugin via `register(db, { rawStorageFactory: () => mmkvBackedStorage, default_transactor: 'local', ... })` (or by constructing `ParsedOptimysticOptions` directly when bypassing the plugin's vtable layer).
