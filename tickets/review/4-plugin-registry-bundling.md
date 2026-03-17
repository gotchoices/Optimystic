# Plugin Registry Bundling Isolation — Move to Factory

description: Moved custom transactor/key-network registration from global module state to `CollectionFactory` instance state, and enabled tsup code splitting.
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/src/index.ts
  - packages/quereus-plugin-optimystic/src/types.ts
  - packages/quereus-plugin-optimystic/tsup.config.ts
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts

----

## Summary

The module-scoped `customRegistry` in `key-network.ts` was duplicated across tsup output chunks (`index.js` and `plugin.js`) because `splitting: false` caused each entry point to get its own copy. Registrations via `registerTransactor()` from `index.js` were invisible to `CollectionFactory` in `plugin.js`.

### What changed

1. **CollectionFactory** now owns custom implementation registration via instance-level maps (`customTransactorCtors`, `customKeyNetworkCtors`) and two new public methods:
   - `registerCustomTransactor(name, ctor)` — register a transactor class by name
   - `registerCustomKeyNetwork(name, ctor)` — register a key network class by name

2. **key-network.ts** — removed `customRegistry`, `registerKeyNetwork()`, `registerTransactor()`, `getCustomRegistry()`. Only built-in `createKeyNetwork('libp2p'|'test')` remains.

3. **types.ts** — removed `CustomImplementationRegistry` interface (no longer needed).

4. **index.ts** — removed re-exports of `registerKeyNetwork` and `registerTransactor` (breaking change, but the old exports were already broken due to the bundling bug).

5. **tsup.config.ts** — set `splitting: true` as defense-in-depth. The shared chunk is now correctly shared between entry points.

6. **createNetworkTransactor** — uses `resolveKeyNetwork()` which supports both built-in `'libp2p'` and custom key network types registered on the factory.

### Public API

```ts
// Register custom implementations via factory instance (works correctly)
const plugin = register(db, config);
plugin.collectionFactory.registerCustomTransactor('my-tx', MyTransactorClass);
plugin.collectionFactory.registerCustomKeyNetwork('my-kn', MyKeyNetworkClass);

// Instance injection (unchanged, already worked)
plugin.collectionFactory.registerTransactor('my-tx:my-kn', myTransactorInstance);
```

## Testing use cases

- **Custom transactor class registration**: Register via `registerCustomTransactor()`, verify it's instantiated by `createTransactor()`
- **Custom key network registration**: Register via `registerCustomKeyNetwork()`, verify no errors
- **Instance injection**: `registerTransactor(key, instance)` still works for direct transactor injection
- **Unknown transactor error**: Unregistered custom name throws with message mentioning `registerCustomTransactor()`
- **Cross-entry-point**: With `splitting: true`, `plugin.js` and `index.js` share one chunk — no more registry duplication
- **All 42 adapter-integration tests pass**
- **Pre-existing failures** (18) in distributed-quereus, index-support, schema-support, quereus-engine are unrelated
