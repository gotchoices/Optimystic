# Plugin Registry Bundling Isolation — Move to Factory

description: Eliminate the duplicated global `customRegistry` by moving custom transactor/key-network registration to `CollectionFactory` instance state, and enable tsup code splitting.
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/src/index.ts
  - packages/quereus-plugin-optimystic/src/types.ts
  - packages/quereus-plugin-optimystic/tsup.config.ts
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts

----

## Context

`tsup` bundles two entry points (`index.ts`, `plugin.ts`) with `splitting: false`. The module-scoped `customRegistry` in `key-network.ts` gets duplicated into each output chunk. Code importing `registerTransactor` from `index.js` writes to one copy; `CollectionFactory` in `plugin.js` reads from a different copy. Custom transactors/key-networks registered via the public API are invisible to the factory.

## Design (Option 2 from plan ticket)

Replace the global `customRegistry` with instance-level maps on `CollectionFactory`. This removes implicit global state, makes the dependency explicit, and is immune to bundling topology.

### CollectionFactory changes

Add two new private maps and public registration methods:

```ts
// Instance-level custom implementation registry
private customTransactorCtors = new Map<string, new (...args: any[]) => ITransactor>();
private customKeyNetworkCtors = new Map<string, new (...args: any[]) => IKeyNetwork>();

registerCustomTransactor(name: string, ctor: new (...args: any[]) => ITransactor): void {
  this.customTransactorCtors.set(name, ctor);
}

registerCustomKeyNetwork(name: string, ctor: new (...args: any[]) => IKeyNetwork): void {
  this.customKeyNetworkCtors.set(name, ctor);
}
```

Update `createCustomTransactor()` (line ~212) to read from `this.customTransactorCtors` instead of `getCustomRegistry()`. Remove the import of `getCustomRegistry`.

Wire up custom key networks in `createNetworkTransactor()` or a new method so that `options.keyNetwork` values other than `'libp2p'`/`'test'` resolve from `this.customKeyNetworkCtors`.

### key-network.ts changes

- Remove `customRegistry` module variable, `registerKeyNetwork()`, `registerTransactor()`, and `getCustomRegistry()`.
- Keep `createKeyNetwork()` for the built-in types (`libp2p`, `test`), but remove the `default` branch that reads from the deleted registry. If the function becomes unused, remove it.

### types.ts changes

- Remove `CustomImplementationRegistry` interface (no longer needed).

### index.ts changes

- Remove the re-exports of `registerKeyNetwork` and `registerTransactor`.
- This is a breaking change to the public API, but the exported functions were **already broken** due to the bundling bug. The workaround (`plugin.collectionFactory.registerTransactor()`) already exists and works.

### tsup.config.ts changes

- Set `splitting: true` as defense-in-depth. With the global state removed, this is no longer critical but prevents similar issues with any future shared module state.

### Test changes

- `adapter-integration.spec.ts` lines 645/657: The two tests that call the global `registerKeyNetwork()`/`registerTransactor()` from `dist/index.js` need to switch to factory instance methods (`plugin.collectionFactory.registerCustomKeyNetwork()` / `plugin.collectionFactory.registerCustomTransactor()`).
- Update the import line 16 to remove `registerKeyNetwork, registerTransactor`.
- The existing tests that use `factory.registerTransactor(key, instance)` for direct instance injection remain unchanged.

### Public API after change

```ts
// Before (broken):
import { registerTransactor } from '@optimystic/quereus-plugin-optimystic';
registerTransactor('my-tx', MyTransactorClass);

// After (works):
const plugin = register(db, config);
plugin.collectionFactory.registerCustomTransactor('my-tx', MyTransactorClass);
plugin.collectionFactory.registerCustomKeyNetwork('my-kn', MyKeyNetworkClass);

// Instance injection (unchanged, already worked):
plugin.collectionFactory.registerTransactor('my-tx:my-kn', myTransactorInstance);
```

## Key tests for validation

- **Registry isolation**: Register a custom transactor via `plugin.collectionFactory.registerCustomTransactor()`, then verify `factory.createTransactor()` finds and instantiates it.
- **Cross-entry-point**: Import `register` from `plugin.js`, call `registerCustomTransactor` on the returned factory, then exercise `createOrGetCollection` with the custom transactor — should use the same instance.
- **Unknown custom transactor**: `createTransactor()` with an unregistered name should throw with a helpful message mentioning the factory method.
- **Custom key network**: Register a custom key network class, verify it's instantiated when `options.keyNetwork` matches.
- **Existing tests pass**: All existing adapter-integration, distributed-transaction-validation, and distributed-quereus tests continue to pass.

## TODO

### Phase 1 — Move registry to factory

- Add `customTransactorCtors` and `customKeyNetworkCtors` maps to `CollectionFactory`
- Add `registerCustomTransactor(name, ctor)` and `registerCustomKeyNetwork(name, ctor)` methods
- Update `createCustomTransactor()` to use `this.customTransactorCtors`
- Wire custom key network lookup into transactor creation path (respect `options.keyNetwork` for custom values)
- Remove `getCustomRegistry` import from `collection-factory.ts`

### Phase 2 — Clean up global registry

- Remove `customRegistry`, `registerKeyNetwork()`, `registerTransactor()`, `getCustomRegistry()` from `key-network.ts`
- Remove `CustomImplementationRegistry` from `types.ts`
- Remove `registerKeyNetwork`, `registerTransactor` re-exports from `index.ts`

### Phase 3 — Enable splitting

- Set `splitting: true` in `tsup.config.ts`

### Phase 4 — Update tests

- Update `adapter-integration.spec.ts` to use factory-based registration
- Add test for custom transactor class registration via factory
- Add test for custom key network class registration via factory
- Verify build passes and all tests green
