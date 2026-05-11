description: React Native LevelDB storage backend (`@optimystic/db-p2p-storage-rn`) — replaces MMKV with `rn-leveldb` for atomic batch writes, real range scans, and stack alignment with `@quereus/plugin-react-native-leveldb`
files: packages/db-p2p-storage-rn/, root package.json, README.md, docs/architecture.md, docs/optimystic.md
----

# What landed

A full rewrite of `@optimystic/db-p2p-storage-rn` from MMKV to LevelDB, on the same workspace name (the package's role — "the RN storage adapter" — hasn't changed) but with new public exports. The MMKV files are gone (`mmkv-storage.ts`, `mmkv-kv-store.ts`, and the v4-remove regression test), replaced with LevelDB-backed equivalents that share one native module with `@quereus/plugin-react-native-leveldb` (Quereus's RN storage plugin).

Three public surfaces share one LevelDB instance:

- **`LevelDBRawStorage`** — `IRawStorage` over a single LevelDB database, with keys partitioned by a leading tag byte per logical store (metadata / revisions / pending / transactions / materialized). Range scans for `listRevisions` and `listPendingTransactions` use real iterators with explicit `gte`/`lt` bounds, drained into an array before yielding (same rationale as the IndexedDB / SQLite backends — never hold a native iterator open across consumer awaits). `promotePendingTransaction` runs as a single LevelDB `WriteBatch` so the pending → committed move is atomic against crashes — a hard requirement that the MMKV adapter couldn't satisfy (it had to issue separate `set`/`remove` calls plus update a JSON-encoded pending index, racing under concurrent saves).
- **`LevelDBKVStore`** — `IKVStore` over the shared database under a distinct `TAG_KV` byte (`0x10`), namespaced by string prefix (default `optimystic:txn:`). `list(prefix)` is a bounded range scan: `gte = TAG_KV || prefix-utf8`, `lt = TAG_KV || prefix-utf8 || 0xFF` (0xFF never appears in valid UTF-8 so the bound is exact). No `getAllKeys` + JS-side filter.
- **`loadOrCreateRNPeerKey(db, keyName?)`** — generates an Ed25519 libp2p `PrivateKey` on first call, persists `privateKeyToProtobuf(key)` as raw bytes under `TAG_IDENTITY` (`0x20`) + the UTF-8 keyName, and decodes it on subsequent calls. Survives `close()` + reopen.

`openOptimysticRNDb({ openFn, WriteBatch, name? })` opens the database; the caller passes `rn-leveldb`'s `LevelDB` constructor and `LevelDBWriteBatch` constructor in (same pattern as `@quereus/plugin-react-native-leveldb`'s opener), so the storage code never directly imports `rn-leveldb`. That keeps the unit tests runnable under Node mocha.

# Key files

- `packages/db-p2p-storage-rn/src/leveldb-like.ts` — internal `LevelDBLike` / `LevelDBWriteBatchLike` / `LevelDBIteratorLike` interfaces, plus a `drain()` helper. **Package-private** — not re-exported from `index.ts`. Mirrors the `SqliteDb` seam in `db-p2p-storage-ns` and the `OptimysticWebDBHandle` seam in `db-p2p-storage-web`.
- `packages/db-p2p-storage-rn/src/keys.ts` — key encoding (`tag (1) || len(blockId) (4 BE) || blockId UTF-8 || suffix`), tag constants (`TAG_METADATA … TAG_IDENTITY`), and range builders (`blockEnvelopeRange`, `kvPrefixRange`).
- `packages/db-p2p-storage-rn/src/leveldb-storage.ts` — `LevelDBRawStorage` (`IRawStorage` impl).
- `packages/db-p2p-storage-rn/src/leveldb-kv-store.ts` — `LevelDBKVStore` (`IKVStore` impl).
- `packages/db-p2p-storage-rn/src/identity.ts` — `loadOrCreateRNPeerKey`.
- `packages/db-p2p-storage-rn/src/rn-opener.ts` — `openOptimysticRNDb`, `wrapRNLevelDB`, and the `RNLevelDBNative` interface re-declared locally so `rn-leveldb`'s types don't have to be installed for typecheck. The adapter classes (`RNLevelDBAdapter`, `RNLevelDBWriteBatchAdapter`, `RNLevelDBIteratorAdapter`) translate the synchronous `rn-leveldb` API to the async `LevelDBLike` interface, including bounded reverse iteration which `rn-leveldb`'s iterator doesn't expose natively (we drive `seek` / `seekLast` / `next` / `prev` manually and bail when we cross the requested range).
- `packages/db-p2p-storage-rn/src/index.ts` — exports `LevelDBRawStorage`, `LevelDBKVStore`, `loadOrCreateRNPeerKey`, `openOptimysticRNDb`, `wrapRNLevelDB`, and the `RN*` native interface types. The `LevelDBLike` family is **not** exported.
- `packages/db-p2p-storage-rn/test/classic-level-driver.ts` — test-only `LevelDBLike` driver wrapping `classic-level` (the Node-native LevelDB binding maintained by Level). Each `openTestDb()` returns an isolated, file-backed database in a fresh temp directory; `openAtPath(path)` is used by the identity persistence test that closes and reopens the same database.
- `packages/db-p2p-storage-rn/test/*.spec.ts` — 27 specs.

# Migration story

This is **Option A: hard replace** (per the plan ticket's recommendation). The package is pre-1.0, demo apps are the only known consumers in-tree, and project conventions discourage backwards-compat shims. Bumped to `0.14.0`; old `MMKVRawStorage` / `MMKVKVStore` exports are gone; `react-native-mmkv` peer dep is removed; `rn-leveldb` (≥3.11) is the new peer dep. Existing MMKV-on-device state will not be migrated — the storage is a local cache for a peer's working set, and peers rebuild from the cluster on first reconnect.

# Behavioral parity vs. NS (SQLite) and Web (IndexedDB)

All 14 `IRawStorage` methods + `getApproximateBytesUsed` are implemented, signatures verbatim against `packages/db-p2p/src/storage/i-raw-storage.ts`. Behavioral parity:

| Concern | NS (SQLite) | Web (IDB) | RN (LevelDB, this ticket) |
|---|---|---|---|
| Atomic `promotePendingTransaction` | `BEGIN; INSERT; DELETE; COMMIT` | single `readwrite` IDB txn | single `WriteBatch` |
| `listRevisions` ordering | `ORDER BY rev ASC/DESC` | range cursor `next`/`prev` | range iterator `reverse:true` |
| `listPendingTransactions` per-block | `WHERE block_id = ?` | `[blockId] … [blockId, []]` | `blockEnvelopeRange(TAG_PENDING, blockId)` |
| `saveMaterializedBlock(undefined)` | `DELETE` | `db.delete` | `db.delete` |
| Drained list before yield | yes | yes | yes |
| `getApproximateBytesUsed` | `PRAGMA page_count × page_size` | `navigator.storage.estimate()` | sum of `keyBuf().byteLength + valueBuf().byteLength` (advisory, O(n)) |
| Throws on missing pending in promote | `Pending action … not found for block …` | same | same |

# Test coverage

27 passing mocha + chai specs under `classic-level`:

- **LevelDBRawStorage** (17) — metadata round-trip + missing; revision round-trip + missing; `listRevisions` ascending / descending / with gaps / cross-block isolation; pending round-trip + listing + cross-block isolation; `deletePendingTransaction`; committed-transaction round-trip; materialized round-trip + undefined-delete; `promotePendingTransaction` happy path + missing-pending error + **atomicity test new to this package** (simulate a `WriteBatch.write()` failure mid-promote and assert neither the pending nor the transaction row is half-written); `getApproximateBytesUsed` non-throwing + 0-on-empty contract.
- **LevelDBKVStore** (6) — set/get round-trip, missing key, delete, prefix listing, prefix isolation between two KV instances on the same database, empty-result list.
- **loadOrCreateRNPeerKey** (4) — same key on second call, distinct `keyName`s yield distinct identities, survives `close()` + reopen on a file-backed database, identity-tag bytes don't collide with KV-store-tag bytes.

Run with: `yarn workspace @optimystic/db-p2p-storage-rn test` (or `test:verbose`).

# Validation performed during implement

- `yarn workspace @optimystic/db-p2p-storage-rn clean && yarn workspace @optimystic/db-p2p-storage-rn build` — green (TypeScript strict + `noUncheckedIndexedAccess`).
- `yarn workspace @optimystic/db-p2p-storage-rn test:verbose` — 27 / 27 passing.
- `yarn workspace @optimystic/db-p2p-storage-web test` — 24 / 24 passing (no regression).
- `yarn workspace @optimystic/db-p2p-storage-ns test` — 25 / 25 passing (no regression).
- `yarn build` (entire monorepo) — green.
- `yarn test` (entire monorepo) — green through db-core (302); one **pre-existing** flake in db-p2p's `IPeerReputation contract (review)` test (`peer-reputation-review.spec.ts:124`, a time-based equality assertion that compares `2` against a slightly-less-than-2 float). Unrelated to this ticket — that test was added by `749f60f ticket(review): peer-reputation-system`. Review-stage should confirm by re-running the suite.

# Documentation updates

- `README.md` — package list now says "React Native storage backend using LevelDB"; the React Native section's storage paragraph mentions LevelDB via `rn-leveldb` and the shared-native-module story with Quereus.
- `docs/architecture.md` — block diagram says "db-p2p-storage-rn (LevelDB)"; the package table says "React Native persistence via LevelDB (`rn-leveldb`)".
- `docs/optimystic.md` — "Mobile (React Native)" deployment-target bullet rewritten with the LevelDB-backed persistence story, `loadOrCreateRNPeerKey`, the `rn-leveldb` peer dep, and the shared-native-module note.

# Root package.json

`clean`, `build`, `test`, `test:verbose`, and `pub` aggregates already include `db-p2p-storage-rn` from prior work — no changes needed there.

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

# Review focus

- **Atomicity of `promotePendingTransaction`** — does the new `WriteBatch`-based path correctly throw `Pending action … not found for block …` on missing pending, and does the simulated-batch-failure test prove no half-written state?
- **`rn-leveldb` adapter (`rn-opener.ts`)** — the manual reverse iteration is the trickiest piece (LevelDB's native iterator has no `reverse` flag; we have to seek + prev). Review against the Quereus plugin's `collectEntries` in `../quereus/packages/quereus-plugin-react-native-leveldb/src/store.ts` — same algorithm, just translated to one-at-a-time iterator semantics.
- **Key layout** — the `tag || len(blockId, 4 BE) || blockId UTF-8 || suffix` envelope (with 8-byte BE rev for revisions) gives correct byte-order sort under LevelDB's `BytewiseComparator`. The 0xFF upper bound for `kvPrefixRange` works because UTF-8 never emits a 0xFF lead byte.
- **Test seam (`LevelDBLike`)** — is the interface narrow enough? Does `classic-level` cover the same behavior space that `rn-leveldb` will exhibit in production?
- **`getApproximateBytesUsed` cost** — O(n) iteration over all keys. Acceptable per the plan ticket; review whether the `StorageMonitor` caller treats it as advisory (it does).

# Known follow-ups (out of scope)

- **Shared abstract sorted-KV skeleton** between `db-p2p-storage-rn` and `db-p2p-storage-ns` — both packages need their platform-specific test seams and openers, but the `IRawStorage` impl shape is now similar enough that a shared core might be worth extracting. Backlog if needed.
- **MMKV → LevelDB on-device data migration** — explicitly out of scope; peers rebuild from the cluster.
- **Encryption-at-rest** — `rn-leveldb` doesn't offer it; a platform-level decision if needed.
