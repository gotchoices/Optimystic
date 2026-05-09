----
description: New @optimystic/db-p2p-storage-web package providing IndexedDB-backed IRawStorage and IKVStore for browser nodes
prereq:
files: packages/db-p2p-storage-web (new), packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p-storage-rn/src/mmkv-storage.ts, packages/db-p2p-storage-rn/src/mmkv-kv-store.ts, packages/db-p2p-storage-fs/src/file-storage.ts
----

Browser peers running `@optimystic/db-p2p/rn` (which is browser-safe, not just RN-safe) currently have no persistent backend — only `MemoryRawStorage`. Mirror the `db-p2p-storage-rn` package shape with an IndexedDB implementation so a browser node survives a page reload with full transactional state (metadata, revisions, pending transactions, committed transactions, materialized blocks) and so its persistent transaction state store (`IKVStore`) can recover crashed two-phase commits.

Unblocks the Sereus web reference app and `../sereus/tickets/plan/3-quereus-plugin-sereus-browser-bundle.md`.

### Package layout
- `packages/db-p2p-storage-web/`
	- `package.json` — name `@optimystic/db-p2p-storage-web`, version `0.13.0`, ESM, peer-deps on `@optimystic/db-core` and `@optimystic/db-p2p` (workspace), runtime dep on `idb` (^8). Mirror the build/test scripts from `db-p2p-storage-rn`.
	- `src/index.ts` — re-export the storage classes, the KV store, and the identity helper.
	- `src/db.ts` — `openOptimysticWebDb(name = 'optimystic', version = 1)` returns a shared `IDBPDatabase` with the schema below.
	- `src/indexeddb-storage.ts` — `IndexedDBRawStorage` implementing `IRawStorage`.
	- `src/indexeddb-kv-store.ts` — `IndexedDBKVStore` implementing `IKVStore`.
	- `src/identity.ts` — `loadOrCreateBrowserPeerKey(db, keyName?)` helper.
	- `src/logger.ts` — `debug` logger matching the rn package shape.
	- `register.mjs`, `tsconfig.json` — match `db-p2p-storage-rn`.
	- `test/indexeddb-storage.spec.ts`, `test/indexeddb-kv-store.spec.ts`, `test/identity.spec.ts` — mocha + chai using `fake-indexeddb` (devDep).

### IndexedDB schema (single database, multiple object stores)

| Store | Key path | Value | Notes |
|---|---|---|---|
| `metadata` | `blockId` (string) | `BlockMetadata` JSON | direct keyed get/put |
| `revisions` | `[blockId, rev]` | `ActionId` (string) | range scan via `IDBKeyRange.bound` cursor — both directions |
| `pending` | `[blockId, actionId]` | `Transform` JSON | `listPendingTransactions(blockId)` is a key cursor over `[blockId, ...]` |
| `transactions` | `[blockId, actionId]` | `Transform` JSON | direct keyed get/put |
| `materialized` | `[blockId, actionId]` | `IBlock` JSON | save with `block === undefined` performs a `delete` |
| `kv` | `key` (string) | `string` | backs both `IKVStore` and the identity helper |

Use real IndexedDB cursors for `listRevisions(start, end)` and `listPendingTransactions(blockId)` — never `getAllKeys()` + JS filter (the MMKV backend's pattern, acceptable there because MMKV has no range API; here we have one). Wrap reads/writes that touch a single store in single-store transactions for parallelism. `promotePendingTransaction` runs as one read-write transaction over `pending` + `transactions`.

`getApproximateBytesUsed()` returns `(await navigator.storage.estimate()).usage ?? 0`. Document in the README that this is per-origin, not per-database — adequate for `StorageMonitor`'s advisory use.

### Identity helper

```ts
export async function loadOrCreateBrowserPeerKey(
	db: IDBPDatabase,
	keyName = 'peer-private-key',
): Promise<PrivateKey>
```

On first call generates `Ed25519` via `generateKeyPair`, persists `privateKeyToProtobuf(key)` bytes (as `Uint8Array`, IndexedDB stores typed arrays natively) into the `kv` store under `keyName`. On subsequent calls reads + decodes via `privateKeyFromProtobuf`. Caller passes the result into `createLibp2pNode({ privateKey })`.

### Cross-platform constraint

This package must not import any Node built-in. Browser already provides `crypto.subtle`, `EventTarget`, `Promise.withResolvers`, `structuredClone`, `ReadableStream` — no polyfill story to write. Tests run under `fake-indexeddb` in Node only for CI convenience.

### Validation
- `yarn workspace @optimystic/db-p2p-storage-web build && yarn workspace @optimystic/db-p2p-storage-web test` passes.
- Tests cover every `IRawStorage` method, both directions of `listRevisions`, the materialized-undefined deletion path, and identity round-trip.

## TODO
- [ ] Scaffold package skeleton matching db-p2p-storage-rn shape
- [ ] Implement `db.ts` open/upgrade with the five+one stores above
- [ ] Implement `IndexedDBRawStorage` with cursor-based list operations
- [ ] Implement `IndexedDBKVStore` (prefix scan via key cursor over `kv`)
- [ ] Implement `loadOrCreateBrowserPeerKey`
- [ ] Mocha specs covering every IRawStorage method (range direction, undefined materialized, promote), KV prefix scan, identity round-trip
- [ ] README documenting browser usage and identity persistence pattern
- [ ] Add to root `package.json` workspaces if not auto-picked
- [ ] Build + test green
