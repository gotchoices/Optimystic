description: The Node file-backed piece store can now store a blob straight from a file on disk and write one straight back out, so the file-path feature has a real implementation and its shared tests run against it.
architecture: docs/blobs.md#the-local-store
files: packages/db-p2p-storage-fs/src/file-piece-store.ts, packages/db-p2p-storage-fs/test/file-piece-store.spec.ts, packages/db-p2p/test/blob-paths.spec.ts (one stale comment), docs/blobs.md, docs/debugging.md
----

# FilePieceStore imports and exports files

`FilePieceStore` now declares `implements IPieceStore, IPieceStoreFiles` and carries the two calls the optional capability names (`packages/db-p2p/src/blob/piece-store.ts`). The file cases of `runPieceStoreConformance`, which ticket `1-blobs-put-and-read-by-file-path` added, now run against this store and pass.

## What was built

**The write half of `put` is now shared.** `put` still validates the id into a `PieceLocation` *before* `open()` (the existing case "refuses an id that is not a lowercase base32 CID" asserts a bad id creates no directories), then hands off to a new private `storePiece(location, id, bytes)` holding what `put` used to do inline: write nothing when the piece is there, otherwise temp → sync → rename into the fan directory, then mark the directory dirty. `storeLeaf(bytes)` is the import's one-leaf wrapper: SHA-256 with `node:crypto`, id with db-core's `rawPieceIdOfDigest`, then `storePiece`. No piece-writing behaviour changed; `put`'s syscall sequence is the same.

**`importFile(path, pieceSize)`** opens a read handle, and loops: fill one `pieceSize` buffer, store that leaf, stop when the fill came up short. `readFully` (module-private) keeps reading until the buffer is full or the file ends, because a single `read` may answer fewer bytes than asked for without being at the end and a leaf cut short there would be a different blob from the one a stream put of the same bytes gives. An empty file yields one zero-length leaf; a file whose length is a multiple of the piece size ends on a fill of 0 with leaves already stored. Returns `{ id, size }[]` in file order. A `pieceSize` that is not a whole number above zero is a `RangeError` — at 0 the loop would cut empty leaves for ever.

**`exportFile(ids, path)`** turns every id into a piece path first (so a refused id leaves no temp), then opens `.<basename>.<16 hex>.tmp` beside the resolved target with `wx`, copies each piece into it through one 256 KiB buffer (`copyPieceInto` → `readFully` + a local `writeAll` that finishes a short write), syncs, closes, renames over the target, and syncs the holding directory with `fsyncDir` (a no-op on win32, as everywhere in this package). Any failure — a missing piece's ENOENT included — closes the handle, removes the temp and rejects, so the target is untouched.

**Buffers are `Uint8Array`, not `Buffer`.** The ticket said `Buffer`; eslint's `no-restricted-globals` bans that global in `packages/*/src/**` (absent under React Native's engine) and `fs` reads and writes any typed array, so plain `Uint8Array`s are used throughout and the docs sentence was written accordingly. `createHash(...).digest()`'s return value is never named.

## Validation to re-run

```
yarn workspace @optimystic/db-p2p-storage-fs build
cd packages/db-p2p-storage-fs && node --import ./register.mjs node_modules/mocha/bin/mocha.js test/file-piece-store.spec.ts --reporter spec
cd packages/db-p2p-storage-fs && node --import ./register.mjs node_modules/mocha/bin/mocha.js test/file-store-identity.spec.ts --reporter min
npx eslint packages/db-p2p-storage-fs/src/file-piece-store.ts packages/db-p2p-storage-fs/test/file-piece-store.spec.ts
yarn lint:docs
```

All of that is clean: build silent, `file-piece-store.spec.ts` 25 passing (the 10 new file cases among them), `file-store-identity.spec.ts` 19 passing, eslint silent, `lint:docs` 49 documents all resolving. Per `tickets/rules/testing.md` the package's full suite was NOT run — that is review's.

**Use cases the conformance cases now cover for this store**: importing 0, 1000, 262144, 262145 and 786437 bytes and getting exactly the leaves a stream put would store (ids and sizes, and each leaf's bytes read back); importing one file twice storing each piece once; exporting pieces joined in order; exporting no pieces as an empty file (not an absent one); exporting over an existing file; and an export naming a missing piece rejecting with neither a fresh path created nor an existing file touched.

## What the reviewer should look at

- **The import loop's three exits** (`packages/db-p2p-storage-fs/src/file-piece-store.ts`, `importFile`): `filled === 0 && leaves.length > 0`, `filled < pieceSize`, and the `RangeError` guard. The exact-multiple and empty-file cases are the ones the conformance lengths pin; satisfy yourself the reasoning matches them rather than only that the suite is green.
- **One test was added by hand**, in `FilePieceStore on disk`: "exports a piece larger than the chunk an export copies at a time" — a 1 MiB piece (`MAX_BLOB_PIECE_BYTES`) put and exported, because every conformance export joins 256 KiB pieces and so never runs `copyPieceInto`'s loop more than once per piece. That multi-chunk path is the only branch in the new code the shared suite leaves uncovered. Nothing else was added: the capability's behaviour is the shared suite's to pin, and the harness `files` helpers are what let it.
- **No end-to-end case puts a real file through `LocalBlobService` over `FilePieceStore`.** `packages/db-p2p/test/blob-paths.spec.ts` pins the service against its own in-process `FilePathPieceStore` double, and the conformance suite pins this store's contract; the two meeting is wiring, so no test was added for it, but it is a judgement call and it is the gap worth arguing with.
- **`writeAll` is duplicated** (six lines) from `file-write-log.ts`, which does not export it; `packages/db-p2p-storage-fs/src/index.ts` re-exports that module wholesale, so sharing it would widen the package's public API. Comment at the site says so.

## Tripwires parked (not tickets)

- `exportFile`, at the rename: on win32 `fs.rename` replaces an existing target but is refused (EPERM) while another handle holds that target open; the export rejects with the target untouched, which is the contract, and nothing is retried — a piece's refused rename can be settled by looking (another put of the same id may have won), while an export's target is the caller's file. The `NOTE:` says to retry for a bounded time if a host meets it. Not reproduced: the conformance case "exporting over an existing file replaces it" passes on Windows because nothing holds the target open.
- `importFile` doc comment: the read of a leaf and the write of the one before it do not overlap, so an import runs a read and a write in turn; if a large file's import ever shows up slow, overlap them with a second buffer.
- `importFile` doc comment: a file another writer changes under the import is read as it reads, and the leaves describe the bytes this call saw. No lock, because not every platform this capability targets has one.

## Docs

`docs/blobs.md`: §The local store's `FilePieceStore` paragraph gains a sentence naming the capability; §Putting and reading by file path's *Which stores offer it* no longer says "None in this repository yet"; and the status paragraph's "taken up by no store in this repository yet" now names this store. `docs/debugging.md`'s `db-p2p-storage-fs` row documents the new `pieces:file` messages (`import:done`, `export:done`, `import:close-failed`, `export:piece-close-failed`, `export:close-failed`, `export:unlink-failed`).

One comment outside the two packages' source was corrected: `packages/db-p2p/test/blob-paths.spec.ts` said its double was the only store offering file access "until `FilePieceStore` gains it", which is now false. Comment only, no behaviour.
