description: Thread an optional `rawStorageFactory` through `ParsedOptimysticOptions` so bootstrap-mode (`transactor: 'local'`) writes can land in a host-supplied persistent backend instead of the hardcoded `MemoryRawStorage`.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/src/types.ts
  - packages/quereus-plugin-optimystic/src/index.ts
  - packages/quereus-plugin-optimystic/test/ (new spec file)
----

## Why

In bootstrap mode (`transactor: 'local'`), the local transactor IS the data path — there is no peer/cluster fallback. Today, `createLocalTransactor` hardcodes `new MemoryRawStorage()` (`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:162-184`), so every write is lost on process exit. A downstream RN/MMKV host (sereus-health) needs to inject a persistent `IRawStorage` here so writes survive cold relaunch. The downstream sereus ticket `wire-strand-storage-into-bootstrap-transactor` consumes this fix.

`createTestTransactor` (collection-factory.ts:189+) has the same pattern and is intentionally **out of scope** — its callers want ephemeral storage.

## Contract

Add an optional `rawStorageFactory?: () => IRawStorage` to both the public `OptimysticOptions` and the parsed `ParsedOptimysticOptions` (`types.ts`). `createLocalTransactor` reads it from options and uses `options.rawStorageFactory?.() ?? new MemoryRawStorage()` to construct the raw storage. Otherwise the function is unchanged. With no factory supplied, behavior is identical to today (existing tests must keep passing).

`IRawStorage` is already exported from `@optimystic/db-p2p` (`packages/db-p2p/src/index.ts:16`); import the type in `types.ts`.

```ts
// types.ts (additions only)
import type { IRawStorage } from '@optimystic/db-p2p';

export interface OptimysticOptions {
  // ... existing fields ...
  /** Optional factory for the raw storage backing a 'local' transactor.
   *  Defaults to MemoryRawStorage when omitted. Has no effect for non-local transactor types. */
  rawStorageFactory?: () => IRawStorage;
}

export interface ParsedOptimysticOptions {
  // ... existing fields ...
  rawStorageFactory?: () => IRawStorage;
}
```

```ts
// collection-factory.ts
case 'local':
  return await this.createLocalTransactor(options);

private async createLocalTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
  const rawStorage = options.rawStorageFactory?.() ?? new MemoryRawStorage();
  const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));
  // ... unchanged wrapper below ...
}
```

## Options-parsing path

`types.ts` only declares the shapes; the actual parsing (where `OptimysticOptions` becomes `ParsedOptimysticOptions`) lives elsewhere — find the call that produces a `ParsedOptimysticOptions` value and forward `rawStorageFactory` through it untouched (it carries no validation/coercion, just a function reference). Likely in `optimystic-module.ts` or a small helper near it; grep for `ParsedOptimysticOptions` and the field assignments to locate.

## Verification

- All existing optimystic tests continue to pass — no caller in this repo supplies a factory.
- Type-check passes for the package.
- Add one new spec under `packages/quereus-plugin-optimystic/test/` (e.g. `local-transactor-storage.spec.ts`) that:
  - Calls the factory's local-transactor path with a custom `IRawStorage` (a tiny in-memory stub or a fresh `MemoryRawStorage` instance the test holds a reference to), pends + commits a block, and asserts the supplied storage observed the write (e.g. via `getMaterial`/whatever read API `IRawStorage` exposes — check `packages/db-p2p/src/storage/i-raw-storage.ts`).
  - Calls the local-transactor path with no factory and asserts it still works (commits succeed). Don't assert anything about the default storage — that's an internal implementation detail.

## TODO

- Read `packages/db-p2p/src/storage/i-raw-storage.ts` to confirm the `IRawStorage` surface and pick the right read method for the assertion in the new spec.
- In `types.ts`: add `import type { IRawStorage } from '@optimystic/db-p2p';` and add the optional `rawStorageFactory` field to both `OptimysticOptions` and `ParsedOptimysticOptions`.
- Locate the parser that turns `OptimysticOptions` into `ParsedOptimysticOptions` (grep for usages of both types) and forward `rawStorageFactory` through unchanged.
- In `collection-factory.ts`: change the call in `createTransactor` to `createLocalTransactor(options)`. Update `createLocalTransactor` to accept `options: ParsedOptimysticOptions` and use `options.rawStorageFactory?.() ?? new MemoryRawStorage()`.
- Leave `createTestTransactor` and the `'test'` switch case untouched.
- Add the new spec file described in **Verification**.
- Run the package's type-check and tests; confirm green. Stream output (e.g. `... 2>&1 | tee /tmp/<name>.log`) to avoid the 10-minute idle timeout.
- Hand off to review with a short summary: what changed, the new option name, how to test it, and a pointer to the downstream sereus ticket that consumes it.
