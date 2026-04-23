# Plugin Registry Bundling Isolation — Complete

description: Moved custom transactor/key-network registration from global module state to `CollectionFactory` instance state, and enabled tsup code splitting to fix cross-entry-point registry duplication.

----

## What was built

The module-scoped `customRegistry` in `key-network.ts` was duplicated across tsup output chunks when `splitting: false` caused each entry point to get its own copy. Registrations from `index.js` were invisible to `CollectionFactory` in `plugin.js`.

### Changes

1. **CollectionFactory** now owns custom implementation registration via instance-level maps and two new public methods:
   - `registerCustomTransactor(name, ctor)` — register a transactor class by name
   - `registerCustomKeyNetwork(name, ctor)` — register a key network class by name

2. **key-network.ts** — removed global `customRegistry`, `registerKeyNetwork()`, `registerTransactor()`, `getCustomRegistry()`. Only built-in `createKeyNetwork('libp2p'|'test')` remains.

3. **types.ts** — removed `CustomImplementationRegistry` interface.

4. **index.ts** — removed re-exports of `registerKeyNetwork` and `registerTransactor`.

5. **tsup.config.ts** — `splitting: true` as defense-in-depth. Shared chunk is correctly shared between `index.js` and `plugin.js`.

## Key files

- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` — factory with registration methods
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts` — built-in key network creation only
- `packages/quereus-plugin-optimystic/src/index.ts` — public exports (broken re-exports removed)
- `packages/quereus-plugin-optimystic/src/types.ts` — type definitions (dead interface removed)
- `packages/quereus-plugin-optimystic/tsup.config.ts` — code splitting enabled
- `packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts` — 42 tests covering the changes

## Public API

```ts
const plugin = register(db, config);

// Register custom implementations via factory instance
plugin.collectionFactory.registerCustomTransactor('my-tx', MyTransactorClass);
plugin.collectionFactory.registerCustomKeyNetwork('my-kn', MyKeyNetworkClass);

// Instance injection (unchanged)
plugin.collectionFactory.registerTransactor('my-tx:my-kn', myTransactorInstance);
```

## Testing

- **42 adapter-integration tests pass** covering:
  - Custom transactor class registration and instantiation
  - Custom key network registration
  - Instance injection via `registerTransactor(key, instance)`
  - Unknown custom transactor throws with message mentioning `registerCustomTransactor()`
  - Transactor caching, collection caching within transactions, clearCache
  - Full CRUD lifecycle, explicit/implicit transactions, rollback, multi-table transactions
  - Plugin registration exposes `collectionFactory` and `txnBridge`
- **Build produces shared chunk**: `plugin.js` (128 B), `index.js` (4 KB), shared chunk (63 KB)
- 18 pre-existing failures in other test suites (distributed-quereus, index-support, schema-support, quereus-engine) are unrelated

## Review notes

- Minor pre-existing DRY opportunity: `createLocalTransactor` and `createTestTransactor` are identical implementations
- `syncCollection` is a no-op stub (pre-existing)
- `resolveKeyNetwork` return type uses `as unknown as Libp2pKeyPeerNetwork` for custom implementations — pragmatic given caller constraints
