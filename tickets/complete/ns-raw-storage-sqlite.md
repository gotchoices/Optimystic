description: NativeScript SQLite storage backend (`@optimystic/db-p2p-storage-ns`) — IRawStorage, IKVStore, and a libp2p identity helper for NativeScript peers
files: packages/db-p2p-storage-ns/, root package.json, README.md, docs/architecture.md, docs/optimystic.md
----

# What landed

A new NativeScript-only workspace package, `@optimystic/db-p2p-storage-ns`, mirroring the shape of `db-p2p-storage-web`. Three public surfaces share one SQLite database:

- **`SqliteRawStorage`** — `IRawStorage` over six tables (`metadata`, `revisions`, `pending`, `transactions`, `materialized`, `kv`). Every CRUD operation goes through a prepared statement bound once in the constructor. `listRevisions` / `listPendingTransactions` issue bounded `SELECT … ORDER BY` queries, drained into an array before yielding (mirroring the IDB rationale — no holding a statement live across consumer awaits).
- **`SqliteKVStore`** — `IKVStore` over the shared `kv` table, namespaced by string prefix (default `optimystic:txn:`). `list(prefix)` is a `SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key`, with the upper bound built from `\u{10FFFF}` (highest valid Unicode code point) so any string starting with the prefix sorts strictly below it under SQLite's BINARY collation.
- **`loadOrCreateNSPeerKey(db, keyName?)`** — generates an Ed25519 libp2p `PrivateKey` on first call, persists `privateKeyToProtobuf(key)` as a `Uint8Array` in the `kv` table's `b_val` column, and decodes it on subsequent calls. Survives `close()` + reopen.

`openOptimysticNSDb(name?, version?)` returns a single `SqliteDb` handle (the package-private wrapper interface) safe to share between all three consumers. SQLite serializes writes inside the connection; the short-lived reads/writes of a client peer have no contention pathology.

# Key files

- `packages/db-p2p-storage-ns/src/db.ts` — internal `SqliteDb` / `SqliteStatement` interface, `SCHEMA_SQL`, `applySchema(db)`, constants. **Imports nothing platform-specific** — safe to load under plain Node.
- `packages/db-p2p-storage-ns/src/ns-opener.ts` — `openOptimysticNSDb()` and `wrapNSPluginDb()`; dynamically imports `@nativescript-community/sqlite` via `await import('…' as string)` so static module resolution stays clean even when the plugin isn't installed.
- `packages/db-p2p-storage-ns/src/sqlite-storage.ts` — `IRawStorage` impl.
- `packages/db-p2p-storage-ns/src/sqlite-kv-store.ts` — `IKVStore` impl.
- `packages/db-p2p-storage-ns/src/identity.ts` — `loadOrCreateNSPeerKey`.
- `packages/db-p2p-storage-ns/test/node-sqlite-driver.ts` — test-only `SqliteDb` driver wrapping Node's built-in `node:sqlite`. Caches prepared statements per SQL string.
- `packages/db-p2p-storage-ns/test/*.spec.ts` — 25 specs.
- `packages/db-p2p-storage-ns/README.md` — usage and persistence semantics.

# Review verdict

Code-review pass complete. Findings:

- **Interface match exact** — `SqliteRawStorage` implements all 14 required `IRawStorage` methods plus the optional `getApproximateBytesUsed`, signatures verbatim against `packages/db-p2p/src/storage/i-raw-storage.ts`. `SqliteKVStore` matches `IKVStore`'s four-method shape from `packages/db-p2p/src/storage/i-kv-store.ts`.
- **Atomicity of `promotePendingTransaction`** — runs as `BEGIN; INSERT…; DELETE…; COMMIT;` inside `SqliteDb.transaction(fn)`. Throws `Pending action … not found for block …` on missing pending (matching MMKV/IDB wording exactly). A crash mid-promote rolls back cleanly — better than the MMKV adapter's non-atomic remove/set + pending-index update.
- **Drained list queries** — `listRevisions` and `listPendingTransactions` issue `stmt.all(…)` and yield from the resulting array. Mirrors the IndexedDB pattern; the alternative (holding a SQLite statement live across `await`s on `node:sqlite`'s `iterate()`) introduces lifecycle hazards the IDB version explicitly avoids.
- **Prepared statements** — bound once per `SqliteRawStorage` / `SqliteKVStore` instance, against the shared `db`. Both `node:sqlite` and the NS plugin cache parsed SQL internally; this layer just avoids the re-parse overhead and gives the storage code a clean per-method statement object.
- **Schema** — six tables (`metadata`, `revisions`, `pending`, `transactions`, `materialized`, `kv`) mirror the IDB stores 1:1. JSON blobs in `TEXT` for everything except identity, which lives in `kv.b_val BLOB`. Composite primary keys (`block_id`, `rev` | `action_id`) give us O(log n) point lookups and prefix scans without secondary indexes.
- **Two-column `kv` (`s_val TEXT`, `b_val BLOB`)** — lets `SqliteKVStore` and the identity helper share the table without a base64 round-trip. `SqliteKVStore.set` issues `INSERT … ON CONFLICT DO UPDATE SET s_val = excluded.s_val` (and writes `b_val = NULL` on initial insert only); identity-helper writes do the same on `b_val` (with `s_val = NULL` only on initial insert). Each helper writes a distinct key (`peer-private-key` vs the prefixed KV keys), so the two never alias on the same row; the cross-row independence test verifies they don't clobber each other.
- **Materialized-undefined deletion** — `saveMaterializedBlock(blockId, actionId, undefined)` issues a `DELETE`, matching fs/rn/web semantics.
- **`getApproximateBytesUsed`** — `PRAGMA page_count` × `PRAGMA page_size`. Returns the SQLite database-file footprint; documented as DB-wide, not per-block. Adequate for `StorageMonitor`'s advisory ring-selection role.
- **Pragmas** — `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = OFF`. Schema versioning via `PRAGMA user_version` so future migrations can branch on it (no v2 yet).
- **Test seam (`SqliteDb`)** — package-private interface covering `exec`, `prepare`, `transaction(fn)`, `close`. Mirrors what the `@nativescript-community/sqlite` plugin needs to satisfy at the boundary and what `node:sqlite` can wrap for tests. Only `openOptimysticNSDb` and the storage/KV/identity classes are exported; the interface itself is internal.
- **`ns-opener.ts` quarantine** — `openOptimysticNSDb` uses `await import('@nativescript-community/sqlite' as string)` so the TS compiler doesn't try to statically resolve the module. The `NSPluginDb` shape is re-declared locally with structural typing of just `execSQL`, `get`, `select`, `close`, so the plugin's `.d.ts` is not needed at typecheck time. Tests never import `ns-opener.ts`, so the native bindings never load under Mocha.
- **Resource ownership** — `SqliteRawStorage` and `SqliteKVStore` do not close the `SqliteDb`; the caller owns the shared handle. Correct, since both consumers share one connection.
- **Schema DDL `;`-splitting** — `NSPluginDbWrapper.exec` splits on `;` to feed the plugin one statement at a time. Safe for our fixed `SCHEMA_SQL` (no embedded `;` in strings or comments). The method is package-private; only `applySchema` calls it.

# Test coverage

25 passing mocha + chai specs under `node:sqlite` (Node 22+, default-enabled on Node 23+; this dev env runs Node 24):

- **SqliteRawStorage** (14) — metadata round-trip + missing, revision round-trip + missing, `listRevisions` ascending / descending / with gaps + cross-block isolation, pending round-trip + listing + cross-block isolation, `deletePendingTransaction`, committed-transaction round-trip, materialized round-trip + undefined-delete, `promotePendingTransaction` happy path + missing-pending error, `getApproximateBytesUsed` non-throwing contract.
- **SqliteKVStore** (7) — set/get round-trip, missing key, delete, prefix listing, prefix isolation between two KV instances on the same table, empty-result list, plus a regression test that the identity helper's `b_val` writes don't clobber the KV store's `s_val` writes (and vice versa).
- **loadOrCreateNSPeerKey** (4) — same key on second call, persisted as `Uint8Array` BLOB, survives `close()` + reopen on a file-backed DB (the "restart" simulation), distinct `keyName`s yield distinct identities.

Run with: `yarn workspace @optimystic/db-p2p-storage-ns test` (or `test:verbose`).

# Validation performed at review

- `yarn workspace @optimystic/db-p2p-storage-ns build` — green (TypeScript strict + `noUncheckedIndexedAccess`).
- `yarn workspace @optimystic/db-p2p-storage-ns test:verbose` — 25 / 25 passing.
- `yarn build` (entire monorepo) — green.
- `yarn test` (entire monorepo) — green: db-core 302, db-p2p 437 (+5 pending), db-p2p-storage-ns 25, db-p2p-storage-rn 5, db-p2p-storage-web 24, quereus-crypto 50, quereus-optimystic 185 (+4 pending), reference-peer 4, demo 12.
- Interface check confirmed `SqliteRawStorage` matches `IRawStorage` exactly and `SqliteKVStore` matches `IKVStore` exactly.

# Documentation updates

- `README.md` — new package listed between `-fs` and `-rn`.
- `docs/architecture.md` — appears in both the storage-adapters block diagram and the package table.
- `docs/optimystic.md` — "Mobile (NativeScript)" deployment-target bullet between RN and Browser, calling out `@optimystic/db-p2p/rn`, `@optimystic/db-p2p-storage-ns`, the `@nativescript-community/sqlite` peer dep, and `loadOrCreateNSPeerKey`.

# Wired into root package.json

`clean`, `build`, `test`, `test:verbose`, and `pub` aggregates all include the new package, with corresponding `<verb>:db-p2p-storage-ns` scripts. Yarn workspaces auto-picks the package via `packages/*`.

# Usage

```ts
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import {
	openOptimysticNSDb,
	SqliteRawStorage,
	SqliteKVStore,
	loadOrCreateNSPeerKey,
} from '@optimystic/db-p2p-storage-ns';

const db = await openOptimysticNSDb();
const raw = new SqliteRawStorage(db);
const kv = new SqliteKVStore(db);
const privateKey = await loadOrCreateNSPeerKey(db);

const libp2p = await createLibp2pNode({ bootstrapNodes: [...], networkName: '...', privateKey });
```

# Follow-ups (deferred — not part of this ticket)

- Encryption-at-rest via SQLCipher (`@nativescript-community/sqlite` has a SQLCipher variant) — backlog if needed.
- Schema migrations beyond `user_version = 1` — opener is ready to grow but no v2 yet.
- A NativeScript demo app — `5.5-demo-app` covered the Node/web demos; an NS counterpart is a separate ticket if/when requested.
