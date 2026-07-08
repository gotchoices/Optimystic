description: Rewrite the LevelDB/React-Native block store so it plugs into the new shared storage core instead of duplicating all the serialization and iteration logic itself.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/keys.ts, packages/db-p2p-storage-rn/src/leveldb-like.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-rn/test/classic-level-driver.ts
difficulty: medium
----

# LevelDB driver: reimplement `LevelDBRawStorage` as a `RawStoreDriver`

Depends on `st-kvkernel-core` (defines `RawStoreDriver`, `KvRawStorage`, and
`runRawStorageConformance`, all exported from `@optimystic/db-p2p` and
`@optimystic/db-p2p/testing`). LevelDB is the closest fit — it is already a single ordered
byte-keyspace — so this driver is mostly a re-slicing of the existing code, not new logic.

## Design

Replace `LevelDBRawStorage implements IRawStorage` with a `LevelDBStoreDriver implements
RawStoreDriver` over the existing `LevelDBLike` handle (`leveldb-like.ts`) and the existing
byte-key scheme (`keys.ts` — **stays in this package**; the kernel deals in logical keys, the
driver owns the tag-prefixed byte encoding). Keep the user-facing constructor/entry point
(`openOptimysticRNDb` and whatever currently constructs `LevelDBRawStorage`) returning an
`IRawStorage`, now built as `new KvRawStorage(new LevelDBStoreDriver(db))`.

Method mapping (values are now raw `Uint8Array` — the JSON step moves to the kernel, so the
driver stores/returns bytes directly, no `TextEncoder`/`TextDecoder` for values):

- `getMetadata`/`putMetadata` → `db.get/put(metadataKey(blockId), bytes)`.
- `getRevision`/`putRevision` → `db.get/put(revisionKey(blockId, rev), bytes)` (value is the
  ActionId's encoded bytes, produced by the kernel — the driver does not know it's an ActionId).
- `rangeRevisions(blockId, lo, hi, reverse)` → the existing `gte=revisionKey(lo)`,
  `lt=revisionKey(hi+1)`, `reverse` scan, **drained** via the existing `drain(...)` helper, yielding
  `[revisionFromKey(key), value]`.
- `getPending`/`putPending`/`deletePending` → `pendingKey(...)`.
- `listPendingActionIds` → the existing `blockEnvelopeRange(TAG_PENDING, blockId)` drained scan,
  yielding `actionIdFromKey(key, blockId)`.
- `getTransaction`/`putTransaction` → `transactionKey(...)`.
- `getMaterialized`/`putMaterialized`/`deleteMaterialized` → `materializedKey(...)`
  (the put-or-delete branch now lives in the kernel; the driver has separate put and delete).
- `promote(blockId, actionId)` → the existing single `WriteBatch`
  (`batch().put(transactionKey, value).delete(pendingKey).write()`) after reading the pending
  value and throwing `Pending action … not found …` when absent. **This is the atomic move** —
  keep it exactly.
- `listBlockIds` → existing `metadataRange()` drained keys-only scan → `blockIdFromMetadataKey`.
- `approximateBytesUsed` → the existing full-iterator byte sum.
- `close` → `db.close()`.

`keys.ts`, `leveldb-like.ts` (incl. `drain`), the identity helper, and `LevelDBKVStore` are
**unchanged** — only `leveldb-storage.ts` is rewritten. Do not fold `TAG_KV`/`TAG_IDENTITY` into
the kernel; they belong to this package's separate KV/identity surface.

## Edge cases & interactions

- **Drain-before-yield preserved.** `rangeRevisions`/`listPendingActionIds`/`listBlockIds` must
  keep draining via `drain(...)` — a native LevelDB iterator must not stay open across the
  consumer's awaits. The kernel's contract requires this; do not switch to lazy `for await`.
- **Big-endian rev ordering.** Revs are encoded 8-byte big-endian (`revisionKey`) so byte order
  == numeric order; the `lt = revisionKey(hi+1)` inclusive-upper trick is unchanged. Verify
  descending scans still yield high→low.
- **Value bytes are opaque.** The driver must not JSON-parse values (the kernel does). A value
  round-trips as the exact bytes the kernel wrote — no decode/re-encode in the driver.
- **classic-level vs rn-leveldb parity.** Tests run against `classic-level`
  (`test/classic-level-driver.ts`); production uses `rn-leveldb`. Both satisfy `LevelDBLike`, so
  the driver is oblivious — no change to that seam.

## TODO

- Rewrite `leveldb-storage.ts` as `LevelDBStoreDriver implements RawStoreDriver`; export an
  `IRawStorage` factory (`new KvRawStorage(new LevelDBStoreDriver(db))`) under the current
  public name so `index.ts` consumers are unaffected.
- Replace `test/leveldb-storage.spec.ts`'s hand-rolled assertions with a call to
  `runRawStorageConformance('LevelDB', …)` wired to `openTestDb()` (`classic-level-driver.ts`);
  keep any LevelDB-only tests (e.g. key-encoding edge cases) that the shared suite does not cover.
- `yarn test:db-p2p-storage-rn 2>&1 | tee /tmp/kv-rn.log`; typecheck the package.
