description: The React Native LevelDB block store was rewritten to run on the shared storage core, keeping its byte-key layout and atomic promote; needs an adversarial review for behavioral parity with the other backends and no LevelDB regressions.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/index.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-rn/src/keys.ts, packages/db-p2p-storage-rn/src/leveldb-like.ts, packages/db-p2p-storage-rn/test/classic-level-driver.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts
difficulty: medium
----

# Review: LevelDB driver reimplemented as `LevelDBStoreDriver implements RawStoreDriver`

`LevelDBRawStorage` (React Native / LevelDB block store) was rewritten to plug into the shared
`KvRawStorage` kernel instead of implementing `IRawStorage` by hand. The kernel owns all JSON/UTF-8
serialization; the LevelDB code became a `LevelDBStoreDriver` that reads/writes raw `Uint8Array`
bytes over the existing single ordered byte-keyspace (tag-prefixed keys in `keys.ts`). The byte-key
scheme, the atomic-promote `WriteBatch`, and the public surface (`new LevelDBRawStorage(db)`) are
unchanged.

## What changed

- **`src/leveldb-storage.ts`** — full rewrite. `LevelDBRawStorage` is now a thin
  `extends KvRawStorage` shell whose constructor does `super(new LevelDBStoreDriver(db))` (mirrors
  the fs `FileRawStorage` / web `IndexedDBRawStorage` pattern). All LevelDB mechanics moved into the
  new `LevelDBStoreDriver` (exported):
  - metadata / revisions / pending / transactions / materialized get/put/delete map straight onto
    `db.get/put/delete` over the existing `keys.ts` byte keys — values now opaque `Uint8Array`,
    **no `TextEncoder`/`TextDecoder` and no `JSON.parse/stringify` in the driver** (the kernel does
    all of it).
  - `rangeRevisions(blockId, lo, hi, reverse)` keeps the existing `gte = revisionKey(lo)`,
    `lt = revisionKey(hi+1)` inclusive-upper trick and the `drain(...)`-before-yield scan; yields
    `[revisionFromKey(key), value]`. Revs are 8-byte big-endian so byte order == numeric order and
    descending (`reverse:true`) still yields high→low (conformance suite asserts it).
  - `listPendingActionIds` keeps the `blockEnvelopeRange(TAG_PENDING, blockId)` drained keys-only
    scan → `actionIdFromKey(key, blockId)`.
  - `promote` keeps the **verbatim** single `WriteBatch`
    (`batch().put(transactionKey, value).delete(pendingKey).write()`) after reading the pending
    value and throwing the exact `Pending action … not found …` when absent. **This is the atomic
    move, ported unchanged.**
  - `listBlockIds` (drained `metadataRange()` keys-only scan → `blockIdFromMetadataKey`) and
    `approximateBytesUsed` (full-iterator byte sum) are the optional passthroughs; re-declared
    non-optional on the subclass via `declare` (the driver always provides them, so the kernel
    constructor always wires them).
- **`src/index.ts`** — added `LevelDBStoreDriver` to the existing `LevelDBRawStorage` export line
  (symmetric with the exported fs `FileStoreDriver` / web `IndexedDBStoreDriver`).
- **`test/leveldb-storage.spec.ts`** — replaced the hand-rolled assertions with
  `runRawStorageConformance('LevelDB', …)` wired to `openTestDb()` (`classic-level-driver.ts`),
  plus four LevelDB-only cases the shared suite omits (below).
- **Unchanged, as the ticket required:** `keys.ts`, `leveldb-like.ts` (incl. `drain`),
  `leveldb-kv-store.ts` (`LevelDBKVStore`), `identity.ts`, `rn-opener.ts`,
  `test/classic-level-driver.ts`. `TAG_KV` / `TAG_IDENTITY` were NOT folded into the kernel.

## Deviation from the ticket's literal method mapping — `close()` omitted

The ticket's method mapping lists `close → db.close()`. I deliberately did **not** implement
`close()` on `LevelDBStoreDriver`, matching the IndexedDB sibling (whose review praised the same
omission). Rationale: the `LevelDBLike` handle is **shared** across `LevelDBRawStorage`,
`LevelDBKVStore`, and `loadOrCreateRNPeerKey` — one db per RN peer (see the README usage block and
`rn-opener.ts` doc: "the database used by `LevelDBRawStorage`, `LevelDBKVStore`, and
`loadOrCreateRNPeerKey`"). The driver must not own that lifecycle: closing it from the driver would
break the other two subsystems. The kernel never wires the optional `close()` anyway (it wires only
`listBlockIds` + `approximateBytesUsed`), so a driver `close()` would be unreachable dead code today
and a footgun if a future kernel ever wired it. A `NOTE:` comment records this at the site.
**Reviewer: confirm this deviation is acceptable** (I judged it the correct call over the literal
mapping; the old `LevelDBRawStorage` also had no `close`, so no regression).

## Validation performed (this session, win32 dev box)

- **db-p2p `dist` already current** — the rn tests import `@optimystic/db-p2p` and
  `@optimystic/db-p2p/testing`, which resolve to `dist/` (git-ignored). dist was present and current
  (raw-store-driver / kv-raw-storage / raw-storage-conformance all built), so no rebuild was needed
  this run. **CI must still build db-p2p before this package** (topological `-At` handles it).
- **rn build / typecheck** (`yarn build`, i.e. `tsc`): clean.
- **rn `yarn test`**: **44 passing, 0 failing** (conformance suite + 4 LevelDB-only cases +
  pre-existing `LevelDBKVStore` / identity specs). Verbose run confirms the `LevelDB` conformance
  block ran **in full** — `listBlockIds yields exactly the blocks with metadata`, `listBlockIds
  yields nothing`, and both `BlockStorage` parity slices passed, **not skipped** (the driver
  implements `listBlockIds`, so the optional-gate did not `this.skip()`).
- **eslint** over `leveldb-storage.ts`, `index.ts`, `leveldb-storage.spec.ts`: clean.

Note: the ticket's `yarn test:db-p2p-storage-rn` script does not exist at the repo root; the
equivalent is `yarn workspace @optimystic/db-p2p-storage-rn test` (or `yarn test` in the package).

## Use cases for the reviewer to exercise / validate

- **Cross-backend parity is the authoritative check.** `runRawStorageConformance('LevelDB', …)` is
  the same suite memory/fs/web run — round-trips, `listRevisions` asc/desc + sparse gaps +
  single-bound + block-scoping + empty range, promote atomicity + exact missing-pend error,
  clone-on-store/read (structural via the byte boundary), drain-before-yield for both scans, and the
  `BlockStorage` pend→commit open-ended-range `[[E]]` + saveReplica→saveDeletion tombstone slice.
- **Big-endian rev ordering (LevelDB-specific).** The conformance descending-`listRevisions` case
  proves the 8-byte big-endian `revisionKey` encoding keeps byte order == numeric order and the
  `lt = revisionKey(hi+1)` inclusive-upper bound is correct under reverse iteration.
- **Tag-range byte-key boundary (LevelDB-only).** `LevelDB driver specifics` >
  "listBlockIds enumerates only TAG_METADATA keys" seeds rows in every *other* store (pending/rev/
  tx/materialized, tags 0x02..0x05) with NO metadata, and asserts the `metadataRange()` upper bound
  (0x02) excludes them — none surfaces as a block id. This exercises more tags than the shared
  suite's pend-only `listBlockIds` case.
- **`WriteBatch` atomicity on a failed promote (LevelDB-only).** `LevelDB driver specifics` >
  "leaves the database consistent when WriteBatch.write() fails" decorates `handle.db.batch` so the
  next `write()` throws, then asserts the pending row survives and the transaction row was never
  created — the failure mode the driver's promote is responsible for surfacing.
- **`getApproximateBytesUsed` (LevelDB-only).** The shared suite omits the optional passthrough;
  two cases pin `> 0` after a write and exactly `0` for an empty db (full-scan byte sum).

## Honest gaps — treat tests as a floor, not a finish line

- **Never run against real `rn-leveldb`.** All validation uses the `classic-level` adapter
  (`test/classic-level-driver.ts`) under Node; production is `rn-leveldb` on a device. Both satisfy
  `LevelDBLike`, so the driver is oblivious — but `rn-leveldb`'s native iterator/batch/`getBuf`
  semantics (empty-value handling, iterator bounds, batch atomicity) are *assumed* equivalent, not
  exercised. A real-device / rn-leveldb run is the true check and is out of band for an agent.
- **On-disk format is UNCHANGED for LevelDB — no migration concern (verify this claim).** Unlike
  the IndexedDB backend (which previously stored live objects via structured clone and now silently
  fails to decode old rows), the *old* LevelDB driver **already** stored JSON/UTF-8 *bytes* (LevelDB
  values must be bytes): `JSON.stringify` → `TextEncoder` for the value types, `TextEncoder` for the
  bare `ActionId`. The kernel's codec (`raw-store-codec.ts`) encodes **identically** — `encodeJson`
  = `TextEncoder.encode(JSON.stringify(v))`, `encodeActionId` = `TextEncoder.encode(actionId)`. So
  an existing on-device LevelDB database decodes correctly against the new kernel with no migration.
  Reviewer: sanity-check the byte-for-byte equivalence (old `leveldb-storage.ts` at HEAD~ vs
  `raw-store-codec.ts`) — if it holds, this backend carries none of the uniform kernel-migration risk
  the other three drivers' reviews flag.
- **`LevelDBStoreDriver` is newly public** via the added `index.ts` export. Intentional and
  symmetric with the exported fs/web drivers, but confirm it is meant to be part of the package's
  public surface.
- **`close()` omitted** — see the "Deviation" section above; the one place I chose engineering
  judgment over the ticket's literal mapping. Confirm.
- **`approximateBytesUsed` full-scan** iterates the entire db to sum key+value byte lengths —
  unchanged from the original `getApproximateBytesUsed`, fine as an advisory `StorageMonitor` input;
  it is O(total bytes) per call. Behavior-identical to the pre-refactor code, so a tripwire, not a
  defect (no `NOTE:` added — the site already reads as a full scan and the concern is unchanged).

## Out of scope (unchanged, intentionally)

`leveldb-kv-store.ts` (still string-valued over `TAG_KV`), `identity.ts` (`TAG_IDENTITY`),
`keys.ts`, `leveldb-like.ts`, `rn-opener.ts`, `logger.ts`, and the `classic-level` test adapter —
none touched. `README.md` needed no change: it does not describe value serialization (no stale
object-store table like the web README had), and `new LevelDBRawStorage(db) // → IRawStorage` is
still accurate. The sibling driver ticket `2-st-kvkernel-driver-sqlite` (if present) is independent.

## End
