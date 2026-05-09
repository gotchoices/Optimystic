----
description: Browser IndexedDB storage backend (`@optimystic/db-p2p-storage-web`) — IRawStorage, IKVStore, and a libp2p identity helper for browser peers
files: packages/db-p2p-storage-web/, root package.json, README.md, docs/architecture.md, docs/optimystic.md
----

# What landed

A new browser-only workspace package, `@optimystic/db-p2p-storage-web`, mirroring the shape of `db-p2p-storage-rn`. Three public surfaces share one IndexedDB database:

- **`IndexedDBRawStorage`** — `IRawStorage` over six object stores (`metadata`, `revisions`, `pending`, `transactions`, `materialized`, `kv`). Range scans use real IDB cursors (`openCursor` / `openKeyCursor`) — no `getAllKeys()` + JS filter.
- **`IndexedDBKVStore`** — `IKVStore` over the shared `kv` object store, namespaced by string prefix (default `optimystic:txn:`). `list(prefix)` is a range-bounded key cursor.
- **`loadOrCreateBrowserPeerKey(db, keyName?)`** — generates an Ed25519 libp2p `PrivateKey` on first call, persists `privateKeyToProtobuf(key)` as a `Uint8Array` in the `kv` store, and decodes it on subsequent calls. Survives `close()` + reopen.

`openOptimysticWebDb(name?, version?)` returns a single `IDBPDatabase` handle that is shared safely between all three consumers — IndexedDB permits concurrent transactions across disjoint object stores.

# Key files

- `packages/db-p2p-storage-web/src/db.ts` — schema typedefs and `openOptimysticWebDb`.
- `packages/db-p2p-storage-web/src/indexeddb-storage.ts` — `IRawStorage` impl.
- `packages/db-p2p-storage-web/src/indexeddb-kv-store.ts` — `IKVStore` impl.
- `packages/db-p2p-storage-web/src/identity.ts` — `loadOrCreateBrowserPeerKey`.
- `packages/db-p2p-storage-web/test/*.spec.ts` — 24 specs.
- `packages/db-p2p-storage-web/README.md` — usage and persistence semantics.

# Review notes

- **Atomicity of `promotePendingTransaction`** runs as one `readwrite` transaction over `['pending', 'transactions']`, so a crash mid-promote cannot leave a duplicate or a hole. Throws `Pending action … not found` on missing pending (matches MMKV; `MemoryRawStorage` silently no-ops).
- **Cursor snapshot before yield** — `listRevisions` and `listPendingTransactions` drain the cursor into an array and `await tx.done` *before* yielding to consumers. IndexedDB auto-commits transactions that go idle across awaits, which would invalidate the cursor between yields if the consumer awaited anything between iterations. The trade-off is materialising the result set in memory; for typical block fan-out this is negligible.
- **Prefix-scan upper bound** — `listPendingTransactions` uses `IDBKeyRange.bound([blockId], [blockId, []])`. Per the W3C IDB key-ordering rule arrays sort above primitives and a length-1 prefix array is < any length-2 array sharing that prefix. The KV store uses `[fullPrefix, fullPrefix + '￿']` (highest BMP code unit ceiling). Tests verify both.
- **Materialized-undefined deletion** — `saveMaterializedBlock(blockId, actionId, undefined)` issues a `delete`, mirroring the fs/rn semantics.
- **Identity bytes** stored as raw `Uint8Array` (no base64) since IndexedDB stores typed arrays natively. Discriminates by `instanceof Uint8Array` so a stale string value cannot poison the load path.
- **Cross-platform constraint** — no Node built-ins. Uses only `idb`, `@libp2p/crypto`, `@libp2p/interface`, and the browser-provided `navigator.storage` (with try/catch for Node test envs that lack it).
- **Clone-on-read pitfall** called out in `MemoryRawStorage` does not apply here — IndexedDB's `get()` always returns a freshly structured-cloned value, so callers cannot mutate persisted state by mutating the returned object.
- **`getApproximateBytesUsed`** returns `(await navigator.storage.estimate()).usage ?? 0`. Per-origin, not per-database — documented in the README. Adequate for `StorageMonitor`'s advisory ring-selection role.

# Test coverage

24 passing mocha + chai specs under `fake-indexeddb/auto`:

- **IndexedDBRawStorage** (15) — metadata round-trip + missing, revision round-trip + missing, `listRevisions` ascending / descending / with gaps + cross-block isolation, pending round-trip + listing + cross-block isolation, `deletePendingTransaction`, committed-transaction round-trip, materialized round-trip + undefined-delete, `promotePendingTransaction` happy path + missing-pending error, `getApproximateBytesUsed` non-throwing contract.
- **IndexedDBKVStore** (5) — set/get round-trip, missing key, delete, prefix listing, prefix isolation between two KV instances on the same `kv` store, empty-result list.
- **loadOrCreateBrowserPeerKey** (4) — same key on second call, persisted as `Uint8Array`, survives `close()` + reopen (page-reload simulation), distinct `keyName`s yield distinct identities.

Run with: `yarn workspace @optimystic/db-p2p-storage-web test` (or `test:verbose`).

# Validation performed

- `yarn workspace @optimystic/db-p2p-storage-web build` — green (TypeScript strict + `noUncheckedIndexedAccess`).
- `yarn workspace @optimystic/db-p2p-storage-web test:verbose` — 24 / 24 passing.
- `yarn workspace @optimystic/db-p2p-storage-rn test` — still green (no regression to sibling).
- Interface check confirmed `IndexedDBRawStorage` matches `IRawStorage` exactly and `IndexedDBKVStore` matches `IKVStore` exactly.

# Documentation updates

- `README.md` — added the new package to the package list.
- `docs/architecture.md` — added to both the storage-adapters block diagram and the package table.
- `docs/optimystic.md` — extended the "Browser" deployment-target bullet to mention `@optimystic/db-p2p-storage-web` and `loadOrCreateBrowserPeerKey`.

# Wired into root package.json

`clean`, `build`, `test`, `test:verbose`, and `pub` aggregates all include the new package, with corresponding `<verb>:db-p2p-storage-web` scripts. Yarn workspaces auto-picks the package via `packages/*`.

# Usage

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import {
	openOptimysticWebDb,
	IndexedDBRawStorage,
	IndexedDBKVStore,
	loadOrCreateBrowserPeerKey,
} from '@optimystic/db-p2p-storage-web';

const db = await openOptimysticWebDb();
const raw = new IndexedDBRawStorage(db);
const kv = new IndexedDBKVStore(db);
const privateKey = await loadOrCreateBrowserPeerKey(db);

const libp2p = await createLibp2pNode({ bootstrapNodes: [...], networkName: '...', privateKey });
```

# Follow-ups

- A backlog ticket already exists for an OPFS-backed alternative (`tickets/backlog/web-raw-storage-opfs.md`) — promote when there's a measured perf reason.
- Consider whether `idb` should move to `peerDependencies` so app authors pin their own version. Current choice keeps the public surface simple.
