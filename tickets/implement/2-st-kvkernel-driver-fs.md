description: Rewrite the filesystem block store to plug into the new shared storage core, keeping its inspectable directory layout, atomic file writes, and atomic rename-based promote.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-fs/test
difficulty: hard
----

# fs driver: reimplement `FileRawStorage` as a `RawStoreDriver`

Depends on `st-kvkernel-core`. This is the hardest of the four drivers, because the filesystem is
**not** a natural ordered byte-KV — and that is exactly why the kernel was designed around a
**typed multi-store driver with `promote` as a first-class primitive** rather than a flat byte-KV
with a generic atomic batch (see `st-kvkernel-core` for the reasoning). Under that design, fs is a
**first-class driver, not an excluded special case**: its five stores map to five subdirectories,
and its atomic needs are met natively.

**Keep the on-disk layout unchanged** (`basePath/<blockId>/{meta.json,revs/,pend/,actions/,blocks/}`).
The directory tree is a deliberate, human-inspectable/debuggable feature — do not flatten it into
encoded-filename KV keys. This is a code refactor, not a format change.

## Design

Replace `FileRawStorage implements IRawStorage` with `FileStoreDriver implements RawStoreDriver`.
The kernel now owns JSON serialization, so files hold the kernel's bytes; the driver reads/writes
`Uint8Array` and no longer does `JSON.stringify/parse` on values. Everything else fs-specific
stays in the driver:

- `getMetadata`/`putMetadata` → read/write `meta.json` via the existing atomic write
  (`atomicWriteFile`, temp-file+rename) and the corrupt-JSON-as-missing read guard. **Value is now
  bytes** — `putMetadata` writes the bytes; `getMetadata` returns them (still ENOENT→`undefined`,
  still torn-file→`undefined` with a log).
- `getRevision`/`putRevision` → `revs/<rev>.json`.
- `rangeRevisions(blockId, lo, hi, reverse)` → the fs backend has no cursor; today `listRevisions`
  loops rev-by-rev calling `getRevision`. Keep that: iterate `lo..hi` (ascending or descending per
  `reverse`), `getRevision` each, yield `[rev, bytes]` for present revs. (A `readdir(revs/)`+sort
  is an option but the bounded loop matches current behavior and avoids listing an unbounded dir;
  keep the loop.)
- pending / transactions / materialized → `pend/`, `actions/`, `blocks/`, with the existing
  colon-encoding of action-id filenames (`%3A`), the legacy raw-colon read fallback + best-effort
  raw-colon unlink, and the win32 guards. **Preserve all of it** — it is load-bearing
  (`filestorage-legacy-rawcolon-delete-resurrection`, `optimystic-filestorage-colon-actionid-windows`,
  both in `complete/`). materialized put/delete stay separate (kernel owns the branch).
- `listPendingActionIds` → the existing `readdir(pend/)` with the ENOENT-vs-other discrimination
  and the id-shape filter (accept legacy-UUID and `tx:`/`stamp:` ids, log-and-skip others).
- `promote(blockId, actionId)` → the existing `rename(pend/<id>.json → actions/<id>.json)` after
  `mkdir -p actions/`, mapping ENOENT to `Pending action … not found …`. **This single rename is
  the atomic move** — it is why fs can honor the kernel's promote contract without a WAL. Do not
  replace it with a read-write-delete sequence.
- `listBlockIds` → the existing `readdir(basePath)` + per-dir `meta.json` existence gate
  (a directory alone is not "owned"; ENOENT→not-owned, other errors surface).
- `approximateBytesUsed` → the existing recursive `directoryByteSize`.

Keep the constructor `new FileRawStorage(basePath)` public name, now returning
`new KvRawStorage(new FileStoreDriver(basePath))`.

## Edge cases & interactions

- **Atomic write contract must not regress.** All value writes go through `atomicWriteFile`
  (temp-file + `rename`), per `st-filestorage-non-atomic-write-corruption` (in `complete/`). The
  kernel does NOT provide a generic atomic multi-key batch, so fs is never asked for one — the only
  atomic cross-file op is promote (a single rename). Confirm no code path writes a value with a
  plain non-atomic `writeFile`.
- **Bytes, not strings, on disk.** Files now contain the kernel's `Uint8Array` bytes. Write/read
  as binary (or a lossless encoding) so non-ASCII JSON bytes round-trip exactly; keep the
  corrupt-content→`undefined` read guard (a torn write must read as missing, letting `recover()`
  make progress). The conformance round-trip/clone cases catch a lossy text coercion.
- **Colon encoding + legacy fallback + win32.** Preserve `encodeActionIdForFilename`, the raw-colon
  read fallback in `readActionScopedFile`, the best-effort raw-colon unlink after encoded delete,
  and the win32 skips (NTFS treats `:` as an ADS separator). These are correctness fixes, not
  cleanup.
- **`listPendingTransactions` error discrimination.** Only ENOENT maps to "no pendings"; any other
  `readdir` error must surface (swallowing it would silently skip pend conflict detection). Keep
  the throw-on-other-error path.
- **`listBlockIds` meta-gate.** A block that was only pended (has `pend/` but no `meta.json`) is
  NOT owned; gate on `meta.json` existence (fs.access), and surface non-ENOENT errors. Preserve.
- **promote crash window.** rename is atomic; a crash leaves either the pending or the committed
  file, never both/neither — matching the kernel's promote contract and `recover()`'s assumptions.

## TODO

- Rewrite `file-storage.ts` as `FileStoreDriver implements RawStoreDriver` (values as bytes; all
  fs-specific behavior retained); keep `FileRawStorage` as the public factory over `KvRawStorage`.
- Adjust `atomic-write.ts` only if needed to write `Uint8Array` losslessly.
- Add a conformance run: `runRawStorageConformance('FileSystem', …)` wired to a temp-dir factory
  (create + `rm -rf` cleanup); keep fs-only tests (colon encoding, legacy raw-colon,
  corrupt-JSON-as-missing, listBlockIds meta-gate) the shared suite does not cover.
- `yarn test:db-p2p-storage-fs 2>&1 | tee /tmp/kv-fs.log`; typecheck the package.
