description: The `'local'` transactor in `quereus-plugin-optimystic` now consumes a host-supplied `rawStorageFactory`, letting bootstrap-mode writes land on a persistent `IRawStorage` instead of always using `MemoryRawStorage`.
files:
  - packages/quereus-plugin-optimystic/src/types.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/test/local-transactor-storage.spec.ts
  - packages/quereus-plugin-optimystic/README.md
----

## What was built

`OptimysticOptions` and `ParsedOptimysticOptions` gained an optional
`rawStorageFactory?: () => IRawStorage`. `CollectionFactory.createLocalTransactor`
consumes it (`options.rawStorageFactory?.() ?? new MemoryRawStorage()`) so that
when `transactor: 'local'` is in effect, the host can plug in a persistent
backend (e.g. RN/MMKV in sereus-health). All other transactor branches
(`'network'`, `'test'`, `'mesh-test'`, custom) are unchanged.

The hook flows through every `ParsedOptimysticOptions` construction site:

- `OptimysticModule.parseTableSchema` (per-table options) reads
  `vtabAuxData['rawStorageFactory']` (function-typed, plugin-level only).
- `OptimysticModule.createSchemaManager` explicitly forwards the factory to
  the schema-tree options.
- `OptimysticVirtualTable.doInitialize` and `addIndex` use spread
  (`{ ...this.options, ... }`) so the factory propagates to every index tree.

## Key files

| File | Change |
|---|---|
| `src/types.ts` | Added `rawStorageFactory?: () => IRawStorage` on both `OptimysticOptions` and `ParsedOptimysticOptions`. |
| `src/optimystic-adapter/collection-factory.ts` | `createLocalTransactor` now uses the factory; `createTestTransactor` untouched. |
| `src/optimystic-module.ts` | `parseTableSchema` extracts the factory from `vtabAuxData`; `createSchemaManager` forwards it explicitly. |
| `test/local-transactor-storage.spec.ts` | Asserts both factory invocation and that the supplied storage observed writes; default path covered. |
| `README.md` | Added `'local'` to the documented transactor values; added a "Plugin-Level Configuration" section listing `rawStorageFactory`. |

## Testing notes

- Targeted: `yarn workspace @optimystic/quereus-plugin-optimystic test --grep "local transactor honours rawStorageFactory"` — 2 passing.
- Full suite: 185 passing, 4 pending. No regressions.
- Pre-existing `tsc --noEmit` errors in `src/schema/index-manager.ts` (lines 105, 157) and `test/manual-mesh-test.ts` (line 65) are unrelated to this change — confirmed against `git log` of those files.

## Usage

Plugin-level wiring (the path used by sereus-health):

```ts
import { register } from '@optimystic/quereus-plugin-optimystic';
import { MyMmkvStorage } from './my-storage.js';

register(db, {
  default_transactor: 'local',
  rawStorageFactory: () => new MyMmkvStorage(),
});
```

Direct construction (for tests or callers that bypass the vtable layer):

```ts
const options: ParsedOptimysticOptions = {
  collectionUri: 'tree://app/data',
  transactor: 'local',
  keyNetwork: 'test',
  libp2pOptions: {},
  cache: false,
  encoding: 'json',
  rawStorageFactory: () => myStorage,
};
const collection = await collectionFactory.createOrGetCollection(options);
```

The factory is invoked only when the `'local'` branch runs; for all other
transactor types it is ignored. Omitting it preserves the historical
`MemoryRawStorage` default — verified by the second spec case and the rest of
the suite.

## Downstream consumer

sereus-health's `wire-strand-storage-into-bootstrap-transactor` ticket is the
primary consumer. It supplies an MMKV-backed `IRawStorage` so SQL writes
issued before the mesh comes online persist across app restarts.
