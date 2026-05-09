---
description: Review the new @optimystic/db-p2p-storage-web IndexedDB backend (IRawStorage + IKVStore + identity helper) for browser peers
prereq:
files: packages/db-p2p-storage-web/package.json, packages/db-p2p-storage-web/tsconfig.json, packages/db-p2p-storage-web/register.mjs, packages/db-p2p-storage-web/README.md, packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/indexeddb-kv-store.ts, packages/db-p2p-storage-web/src/identity.ts, packages/db-p2p-storage-web/src/logger.ts, packages/db-p2p-storage-web/src/index.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-web/test/indexeddb-kv-store.spec.ts, packages/db-p2p-storage-web/test/identity.spec.ts, package.json
---

# What was built

A new browser-only workspace package, `@optimystic/db-p2p-storage-web`, mirroring the shape of `db-p2p-storage-rn`. Three public surfaces, one shared IndexedDB database:

- **`IndexedDBRawStorage`** — `IRawStorage` over six object stores (`metadata`, `revisions`, `pending`, `transactions`, `materialized`, `kv`). Range scans use real IndexedDB cursors (`openCursor` / `openKeyCursor`) — never `getAllKeys()` + JS filter.
- **`IndexedDBKVStore`** — `IKVStore` over the shared `kv` object store, namespaced by a string prefix (default `optimystic:txn:`). `list(prefix)` is a range-bounded key cursor.
- **`loadOrCreateBrowserPeerKey(db, keyName?)`** — generates an Ed25519 libp2p `PrivateKey` on first call, persists `privateKeyToProtobuf(key)` as a `Uint8Array` in the `kv` store, and decodes it on subsequent calls. Survives close/reopen.

`openOptimysticWebDb(name?, version?)` returns a single `IDBPDatabase` handle that can be safely shared between all three consumers — IndexedDB permits concurrent transactions across disjoint object stores.

# Key implementation details a reviewer should check

- **Atomicity of `promotePendingTransaction`** (`packages/db-p2p-storage-web/src/indexeddb-storage.ts:121-133`) runs as one `readwrite` transaction over `['pending', 'transactions']`, so a crash mid-promote cannot leave a duplicate or a hole.
- **Cursor snapshot before yield** — `listRevisions` and `listPendingTransactions` drain the cursor into an array and `await tx.done` *before* yielding to consumers. IndexedDB auto-commits transactions that go idle across awaits, which would invalidate the cursor between yields if the consumer did any awaiting. The trade-off is materialising the result set in memory; for the typical block fan-out this is negligible.
- **Prefix-scan upper bound** — `listPendingTransactions` uses `IDBKeyRange.bound([blockId], [blockId, []])`. This relies on the W3C IDB key-ordering rule that arrays sort above all primitive types and that a length-1 prefix array is less than any length-2 array sharing that prefix. The KV store uses `[fullPrefix, fullPrefix + '￿']` (UTF-16 code-unit ceiling) — both approaches verified by tests.
- **Materialized-undefined deletion** — `saveMaterializedBlock(blockId, actionId, undefined)` issues a `delete`, mirroring the fs/rn semantics.
- **Identity bytes** — stored as raw `Uint8Array` (no base64), since IndexedDB stores typed arrays natively. `loadOrCreateBrowserPeerKey` discriminates by `instanceof Uint8Array` so a stale string value cannot poison the load path.
- **Cross-platform constraint** — no Node built-ins. Uses only `idb`, `@libp2p/crypto`, `@libp2p/interface`, and the browser-provided `navigator.storage` (with a try/catch for Node test envs that lack it).
- **`getApproximateBytesUsed`** returns `(await navigator.storage.estimate()).usage ?? 0`. Per-origin, not per-database — documented in the README. Adequate for `StorageMonitor`'s advisory ring-selection role.

# Test coverage

24 passing mocha + chai specs under `fake-indexeddb/auto`:

- **IndexedDBRawStorage** (15) — metadata round-trip + missing, revision round-trip + missing, `listRevisions` ascending / descending / with gaps + cross-block isolation, pending round-trip + listing + cross-block isolation, `deletePendingTransaction`, committed-transaction round-trip, materialized round-trip + undefined-delete, `promotePendingTransaction` happy path + missing-pending error, `getApproximateBytesUsed` non-throwing contract.
- **IndexedDBKVStore** (5) — set/get round-trip, missing key, delete, prefix listing, prefix isolation between two KV instances on the same `kv` store, empty-result list.
- **loadOrCreateBrowserPeerKey** (4) — same key on second call, persisted as `Uint8Array`, survives `close()` + reopen (simulating a page reload), distinct `keyName`s yield distinct identities.

Run with: `yarn workspace @optimystic/db-p2p-storage-web test` (or `test:verbose`).

# Validation performed

- `yarn install` resolved cleanly (added `idb@8.0.3`, `fake-indexeddb@6.2.5`).
- `yarn workspace @optimystic/db-p2p-storage-web build` — green (TypeScript strict + `noUncheckedIndexedAccess`).
- `yarn workspace @optimystic/db-p2p-storage-web test:verbose` — 24 / 24 passing.
- `yarn workspace @optimystic/db-p2p-storage-rn test` — still green (no regression to sibling).

# Wired into root package.json

`clean`, `build`, `test`, `test:verbose`, and `pub` aggregates all include the new package, with corresponding `<verb>:db-p2p-storage-web` scripts. Yarn workspaces auto-picks the package via `packages/*`.

# Usage (for downstream review of the Sereus browser bundle ticket)

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

# Reviewer focus areas

1. Confirm the transaction-snapshot pattern in `listRevisions` / `listPendingTransactions` is the right call vs. yielding directly from the cursor. Yielding directly is more memory-efficient but races with IDB auto-commit when consumers `await` anything between iterations; this implementation chose correctness.
2. Confirm the `metadata` / `materializedBlock` clone-on-read pitfall called out in `MemoryRawStorage` does not apply here. IndexedDB's `get()` always returns a freshly structured-cloned value, so callers cannot mutate the persisted state by mutating the returned object.
3. Confirm the schema version `1` and the upgrade path are sufficient. Future schema changes will need to bump `DEFAULT_DB_VERSION` and add a migration in `openOptimysticWebDb.upgrade`.
4. (Optional polish) `idb` is currently a runtime `dependencies` entry — but the only browser consumer will need it bundled anyway. Consider whether it should be a `peerDependencies` entry instead so app authors pin their own `idb` version. Current choice keeps the public surface simple.
