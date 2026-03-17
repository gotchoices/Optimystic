# Plugin Registry Bundling Isolation

## Subsystem

`quereus-plugin-optimystic` — key-network.ts, collection-factory.ts, tsup.config.ts

## Problem

The plugin uses `tsup` with `splitting: false` and two entry points (`index.ts`, `plugin.ts`). This causes the module-scoped `customRegistry` in `key-network.ts` to be duplicated into each bundle. Code that calls `registerTransactor()` or `registerKeyNetwork()` from the `index.js` entry point writes to a different registry instance than the one `CollectionFactory` reads from in `plugin.js`.

This means:
- `import { registerTransactor } from '@optimystic/quereus-plugin-optimystic'` registers into one registry
- `register(db, config)` from `@optimystic/quereus-plugin-optimystic/plugin` reads from a different registry
- Custom transactors/key networks registered via the public API are invisible to the factory

## Involved Files

- `packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts` — `customRegistry` module variable
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` — reads from `getCustomRegistry()`
- `packages/quereus-plugin-optimystic/tsup.config.ts` — `splitting: false`
- `packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts` — documents the issue

## Workaround

Users can use `plugin.collectionFactory.registerTransactor(key, instance)` to register transactor instances directly on the factory (bypasses the global registry). This works but requires access to the plugin return object.

## Design Options

1. **Enable splitting** (`splitting: true` in tsup) — shared modules get their own chunk, ensuring a single registry instance. May require consumers to handle chunk loading.

2. **Move registry to factory** — Replace the global `customRegistry` with instance-level registration on `CollectionFactory`. The `register()` function already returns `collectionFactory`, so callers can register directly. Remove the standalone `registerTransactor`/`registerKeyNetwork` exports.

3. **Externalize the registry** — Create a separate, non-bundled module for the registry (e.g., a thin wrapper file listed in tsup `external`). Both entry points would import the same module instance.

4. **Single entry point** — Merge `plugin.ts` into `index.ts` as a single entry point. Simplest fix but changes the public API surface.

## Recommendation

Option 2 (move to factory) is the cleanest — it removes implicit global state and makes the dependency explicit.
