description: React Native LevelDB storage backend (`@optimystic/db-p2p-storage-rn`) — replaces MMKV with `rn-leveldb` for atomic batch writes, real range scans, and stack alignment with `@quereus/plugin-react-native-leveldb`
files: packages/db-p2p-storage-rn/, README.md, docs/architecture.md, docs/optimystic.md
----

# What shipped

`@optimystic/db-p2p-storage-rn` was rewritten from MMKV to LevelDB. The package name and role are unchanged (the "RN storage adapter"), but the public exports, peer deps, and on-device format are all new. Hard replace, version bumped to `0.14.0`; pre-1.0, no migration of on-device MMKV data (peers rebuild from the cluster).

Three public surfaces share one LevelDB instance, partitioned by leading tag byte:

- **`LevelDBRawStorage`** — `IRawStorage` over the shared database. `promotePendingTransaction` is a single LevelDB `WriteBatch` (atomic), `listRevisions` / `listPendingTransactions` use real range iterators drained into arrays before yielding (so a native iterator never spans a consumer await — same rationale as the IndexedDB and SQLite backends).
- **`LevelDBKVStore`** — `IKVStore` over `TAG_KV` (`0x10`), namespaced by a user-chosen string prefix. `list(prefix)` is a bounded range scan: `gte = TAG_KV || prefix-utf8`, `lt = TAG_KV || prefix-utf8 || 0xFF` (exact because UTF-8 never emits a 0xFF byte).
- **`loadOrCreateRNPeerKey(db, keyName?)`** — generates an Ed25519 libp2p `PrivateKey` on first call, persists `privateKeyToProtobuf(key)` as raw bytes under `TAG_IDENTITY` (`0x20`), decodes on subsequent calls. Survives `close()` + reopen.

`openOptimysticRNDb({ openFn, WriteBatch, name? })` opens the database. The caller passes `rn-leveldb`'s `LevelDB` and `LevelDBWriteBatch` constructors in, so the storage code never imports `rn-leveldb` directly — keeping the unit tests runnable under Node mocha against `classic-level`.

# Key files

- `src/leveldb-like.ts` — package-private `LevelDBLike` / `LevelDBWriteBatchLike` / `LevelDBIteratorLike` interfaces plus a `drain()` helper. Not re-exported from `index.ts`.
- `src/keys.ts` — key encoding `tag (1) || len(blockId) (4 BE) || blockId UTF-8 || suffix` (with 8-byte BE rev for revisions), tag constants, and range builders.
- `src/leveldb-storage.ts` — `LevelDBRawStorage` (`IRawStorage` impl).
- `src/leveldb-kv-store.ts` — `LevelDBKVStore` (`IKVStore` impl).
- `src/identity.ts` — `loadOrCreateRNPeerKey`.
- `src/rn-opener.ts` — `openOptimysticRNDb` / `wrapRNLevelDB`. The adapter classes translate `rn-leveldb`'s synchronous API to the async `LevelDBLike` interface, including bounded reverse iteration (driven manually via `seek` / `seekLast` / `prev` / `next` because `rn-leveldb`'s iterator has no `reverse` flag).
- `src/index.ts` — public exports: `LevelDBRawStorage`, `LevelDBKVStore`, `loadOrCreateRNPeerKey`, `openOptimysticRNDb`, `wrapRNLevelDB`, and the `RN*` native interface types.
- `test/classic-level-driver.ts` — test-only `LevelDBLike` driver wrapping `classic-level`, with an `openAtPath(path)` helper used by the identity-persistence test that closes and reopens the same database.
- `test/*.spec.ts` — 27 specs across `LevelDBRawStorage` (17), `LevelDBKVStore` (6), and `loadOrCreateRNPeerKey` (4).

# Behavioral parity vs. NS (SQLite) and Web (IndexedDB)

All 14 `IRawStorage` methods + `getApproximateBytesUsed` are implemented, signatures verbatim against `packages/db-p2p/src/storage/i-raw-storage.ts`.

| Concern | NS (SQLite) | Web (IDB) | RN (LevelDB) |
|---|---|---|---|
| Atomic `promotePendingTransaction` | `BEGIN; INSERT; DELETE; COMMIT` | single `readwrite` IDB txn | single `WriteBatch` |
| `listRevisions` ordering | `ORDER BY rev ASC/DESC` | range cursor `next`/`prev` | range iterator `reverse:true` |
| `listPendingTransactions` per-block | `WHERE block_id = ?` | `[blockId] … [blockId, []]` | `blockEnvelopeRange(TAG_PENDING, blockId)` |
| `saveMaterializedBlock(undefined)` | `DELETE` | `db.delete` | `db.delete` |
| Drained list before yield | yes | yes | yes |
| `getApproximateBytesUsed` | `PRAGMA page_count × page_size` | `navigator.storage.estimate()` | `Σ keyBuf().byteLength + valueBuf().byteLength` (advisory, O(n)) |
| Throws on missing pending in promote | `Pending action … not found for block …` | same | same |

# Test coverage

27 mocha + chai specs under `classic-level`:

- **`LevelDBRawStorage`** (17) — metadata round-trip + missing; revision round-trip + missing; `listRevisions` ascending / descending / with gaps / cross-block isolation; pending round-trip + listing + cross-block isolation; `deletePendingTransaction`; committed-transaction round-trip; materialized round-trip + undefined-delete; `promotePendingTransaction` happy path + missing-pending error + **atomicity-on-failure** (decorate `db.batch()` so the next `write()` throws and assert neither row is half-written); `getApproximateBytesUsed` non-throwing + 0-on-empty.
- **`LevelDBKVStore`** (6) — set/get round-trip, missing key, delete, prefix listing, prefix isolation between two KV instances on the same database, empty-result list.
- **`loadOrCreateRNPeerKey`** (4) — same key on second call, distinct `keyName`s yield distinct identities, survives `close()` + reopen on a file-backed database, identity-tag bytes don't collide with KV-store-tag bytes.

Run with: `yarn workspace @optimystic/db-p2p-storage-rn test` (or `test:verbose`).

# Validation performed during review

- `yarn workspace @optimystic/db-p2p-storage-rn clean && yarn workspace @optimystic/db-p2p-storage-rn build` — green (TS strict + `noUncheckedIndexedAccess`).
- `yarn workspace @optimystic/db-p2p-storage-rn test:verbose` — **27 / 27 passing**.
- `yarn workspace @optimystic/db-p2p-storage-web test` — **24 / 24 passing** (no regression).
- `yarn workspace @optimystic/db-p2p-storage-ns test` — **25 / 25 passing** (no regression).

# Review notes / cleanup performed

- Trimmed a comparative-to-removed-implementation JSDoc line on `LevelDBRawStorage` (referenced "the prior MMKV adapter") — kept the timeless statement about `WriteBatch` atomicity, dropped the historical comparison that will rot.
- No other code or doc changes required. README, `docs/architecture.md`, and `docs/optimystic.md` are accurate (LevelDB language + `loadOrCreateRNPeerKey` + the `rn-leveldb`-shared-with-Quereus story).

# Usage

```ts
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import {
  openOptimysticRNDb,
  LevelDBRawStorage,
  LevelDBKVStore,
  loadOrCreateRNPeerKey,
} from '@optimystic/db-p2p-storage-rn';

const db = openOptimysticRNDb({
  openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
  WriteBatch: LevelDBWriteBatch,
});
const raw = new LevelDBRawStorage(db);
const kv = new LevelDBKVStore(db);
const privateKey = await loadOrCreateRNPeerKey(db);

const libp2p = await createLibp2pNode({ bootstrapNodes: [...], networkName: '...', privateKey });
```

# Known follow-ups (out of scope, not blocking)

- **Shared abstract sorted-KV skeleton** between `db-p2p-storage-rn` and `db-p2p-storage-ns` — both now have similar `IRawStorage` shape over an ordered byte-keyed store. Extracting a shared core could remove ~40% of the duplication; backlog if/when a third sorted-KV backend appears.
- **MMKV → LevelDB on-device data migration** — explicitly out of scope; peers rebuild from the cluster.
- **Encryption-at-rest** — `rn-leveldb` doesn't offer it; platform-level decision if needed.
