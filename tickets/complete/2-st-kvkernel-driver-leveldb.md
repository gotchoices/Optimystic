description: The React Native LevelDB block store was rewritten to run on the shared storage core, keeping its byte-key layout and atomic promote; reviewed for behavioral parity with the other backends with no LevelDB regressions.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/index.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-rn/src/keys.ts, packages/db-p2p-storage-rn/src/leveldb-like.ts, packages/db-p2p-storage-rn/src/rn-opener.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts
----

# Complete: LevelDB driver reimplemented as `LevelDBStoreDriver implements RawStoreDriver`

`LevelDBRawStorage` was rewritten from a hand-rolled `IRawStorage` into a thin `extends KvRawStorage`
shell whose constructor does `super(new LevelDBStoreDriver(db))`. The kernel owns all JSON/UTF-8
serialization; `LevelDBStoreDriver` reads/writes raw `Uint8Array` bytes over the existing
tag-prefixed single ordered byte keyspace (`keys.ts`). Byte-key scheme, atomic-promote `WriteBatch`,
and public surface (`new LevelDBRawStorage(db)`) unchanged. Mirrors the fs/web sibling drivers.

## Review findings

Adversarial pass over the implement diff (`1e44b8b`), read before the handoff summary. Every driver
method, the kernel contract, the codec, the key layout, the rn-leveldb adapter, and the conformance
suite were read in full.

**Checked and clean — no action needed:**

- **Cross-backend parity (the authoritative check).** `runRawStorageConformance('LevelDB', …)` — the
  same suite memory/fs/web/ns run — passed in full: **44 passing, 0 failing**. Verbose run confirms
  the `LevelDB` conformance block ran **not skipped** (round-trips, `listRevisions` asc/desc + sparse
  gaps + single-bound + block-scoping + empty range, promote atomicity + exact missing-pend error,
  clone-on-store/read via the byte boundary, drain-before-yield for both scans, `BlockStorage`
  pend→commit `[[E]]` + saveReplica→saveDeletion tombstone). `listBlockIds` gate did NOT `this.skip()`.
- **On-disk byte-for-byte equivalence — no migration risk (verified the claim).** Diffed old
  `leveldb-storage.ts` (`HEAD~1`) against `raw-store-codec.ts`: old value writes were
  `textEncoder.encode(JSON.stringify(v))` and revision writes `textEncoder.encode(actionId)`; the
  codec's `encodeJson`/`encodeActionId` are byte-identical. An existing on-device LevelDB db decodes
  correctly against the new kernel with no migration. This backend carries none of the IndexedDB
  backend's kernel-migration risk (LevelDB values were already JSON/UTF-8 bytes, never live objects).
- **null-vs-undefined miss handling — no regression.** The old driver used `if (!bytes) return
  undefined` (tolerant of null); the kernel now uses strict `bytes === undefined`. Confirmed the only
  two `LevelDBLike.get` implementations both return `undefined` (never `null`) on a miss:
  `classic-level` (tests) and `RNLevelDBAdapter.get` (`rn-opener.ts:105`, `result === null ?
  undefined : …`). Strict check is safe.
- **Empty-value handling — parity.** A stored zero-length value round-trips as a truthy empty
  `Uint8Array` under both old (`if (!bytes)`) and new code; values are JSON or actionId, never empty
  in practice. No behavior change.
- **`declare listBlockIds/getApproximateBytesUsed` on the subclass — correct, not a footgun.** These
  are wired as instance properties by the base `KvRawStorage` constructor. A plain `public` field
  redeclaration on the subclass would re-initialize to `undefined` AFTER `super()` runs and silently
  break feature-detection; `declare` (type-only, emits nothing) avoids that. Identical to the fs/web
  siblings (`file-storage.ts:412`, `indexeddb-storage.ts:182`).
- **Big-endian rev ordering + inclusive-upper `lt = revisionKey(hi+1)`.** Proven by the descending
  `listRevisions` conformance case; 8-byte BE keeps byte order == numeric order under reverse.
- **`promote` atomicity.** Ported verbatim (single `WriteBatch`); conformance + a LevelDB-only
  decorated-batch failure case both pass (pending survives, tx never created on `write()` throw).
- **`close()` omission (implementer's one deviation from the ticket's literal method mapping).**
  Confirmed correct: the `LevelDBLike` handle is shared across `LevelDBRawStorage`, `LevelDBKVStore`,
  and `loadOrCreateRNPeerKey` (one db per RN peer), the kernel never wires the optional `close()`, and
  the pre-refactor class had no `close` either — so no regression and no dead footgun. Matches the
  IndexedDB sibling. A `NOTE:` records it at the site.
- **Newly-public `LevelDBStoreDriver` export.** Intentional and symmetric with the exported fs/web
  drivers. Accepted as public surface.
- **README + out-of-scope files.** README describes only the unchanged public surface (`new
  LevelDBRawStorage(db) // → IRawStorage`) — no stale serialization table (unlike the web README).
  `keys.ts`, `leveldb-like.ts`, `leveldb-kv-store.ts`, `identity.ts`, `rn-opener.ts` correctly
  untouched. Lint clean on the three changed files.

**Minor — fixed in this pass:**

- Added a `NOTE:` at the `approximateBytesUsed` site (`leveldb-storage.ts`) tagging the full-scan
  cost, cross-referencing the kernel's write-path counter seam. See tripwires below.

**Major (new tickets):** none.

**Tripwires (conditional; recorded, not ticketed):**

- **`approximateBytesUsed` is a full db scan — O(total bytes) per call.** Behavior-identical to the
  pre-refactor `getApproximateBytesUsed`, so not a defect. Fine as an advisory `StorageMonitor` input
  at current sizes; only matters if a monitor ever polls it on a large db. Parked as a `NOTE:` at the
  exact site in `leveldb-storage.ts`, pointing at the kernel's existing incremental-counter seam NOTE
  in `kv-raw-storage.ts` (`saveMetadata`). No ticket.

## Honest gaps carried forward (not defects)

- **Never run against real `rn-leveldb`.** All validation uses the `classic-level` adapter under
  Node. `rn-leveldb`'s native iterator/batch/`getBuf` semantics (empty-value handling, iterator
  bounds via `RNLevelDBIteratorAdapter`, batch atomicity) are *assumed* equivalent through the shared
  `LevelDBLike` interface, not exercised on-device. A real-device / `rn-leveldb` run is the true check
  and is out of band for an agent — same gap the fs/web/ns driver reviews flag for their native paths.
  Not ticketable here (no repo-side defect); a device smoke test belongs to whoever owns RN CI.

## Validation performed (this session, win32)

- `yarn workspace @optimystic/db-p2p build` (dependency) — clean.
- `yarn workspace @optimystic/db-p2p-storage-rn build` (tsc typecheck), before and after the NOTE
  edit — clean.
- `yarn workspace @optimystic/db-p2p-storage-rn test:verbose` — **44 passing, 0 failing**;
  `LevelDB` conformance block ran in full (not skipped).
- `npx eslint` over `leveldb-storage.ts`, `index.ts`, `leveldb-storage.spec.ts` — clean.

## End
