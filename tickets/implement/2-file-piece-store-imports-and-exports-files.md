description: Give the Node file-backed blob piece store the new ability to store a blob straight from a file and write one straight back out, so the feature has a working implementation in this repository and its conformance tests run against a real store.
prereq: 1-blobs-put-and-read-by-file-path
architecture: docs/blobs.md#the-local-store
files: packages/db-p2p-storage-fs/src/file-piece-store.ts (`FilePieceStore`, `put`, `pieceLocation`, the `incoming/` temp directory, `dirty`), packages/db-p2p-storage-fs/test/file-piece-store.spec.ts, packages/db-p2p/src/blob/piece-store.ts (`IPieceStoreFiles`, `ImportedPiece`), packages/db-p2p/src/testing/piece-store-conformance.ts (`PieceStoreHarness.files`), docs/blobs.md
----

# FilePieceStore imports and exports files

`1-blobs-put-and-read-by-file-path` adds the optional `IPieceStoreFiles` capability (`importFile`, `exportFile`) and its conformance cases. This ticket implements it on `FilePieceStore`, the Node file store, which is the reference implementation the docs point hosts at.

On Node the bytes travel as `Buffer`s and are hashed with `node:crypto`; that is Node's native path, and nothing here goes through base64 or the blob service's `BlobDigest`.

## `importFile(path, pieceSize)`

- Stream the file (`fs.createReadStream` with `highWaterMark: pieceSize`, or a `FileHandle.read` loop into a `pieceSize` buffer) and cut exact `pieceSize` leaves, the last shorter; an empty file yields one zero-length leaf.
- For each leaf: `createHash('sha256')`, name it with db-core's `rawPieceIdOfDigest`, and store it through the same steps `put` uses (temp file in `incoming/`, sync, rename into its fan directory, mark the directory `dirty`, write nothing when the id is already present). Factor the write half of `put` so both share it rather than calling `put` with a copied buffer.
- Return `{ id, size }[]` in file order. A read error rejects; leaves already stored stay (the service's sweep removes orphans, as for an interrupted stream put).

## `exportFile(ids, path)`

- Open a temp file beside `path` (same directory, a unique name such as `.<basename>.<random>.tmp`), and for each id stream its piece file into it (`pipeline(createReadStream(pieceFile), write)`, or copy with `FileHandle.write` of read chunks). A missing piece rejects.
- Sync the temp file, rename it over `path`, sync the directory (`fsyncDir`, which is a no-op on win32 as elsewhere in this package). On any failure, delete the temp file and reject, so `path` is either untouched or holds the whole result.

## Conformance and tests

In `file-piece-store.spec.ts`, give the `runPieceStoreConformance` harness its `files` helpers over the case's temp directory (`write` writes a new file and returns its path, `freshPath` returns an unused name in that directory, `read` returns the bytes or `undefined`). That runs the capability cases from ticket 1 against this store; no further test is needed unless implementing surfaces a case the suite misses.

## Edge cases & interactions

- **Rename onto an existing file on Windows** (export replacing a file): `fs.rename` replaces on Windows unless the target is open; reuse the retry helper this file already uses for refused renames if export hits it. Verified by the conformance case "export over an existing file replaces it".
- **Import of a file being written concurrently**: the store reads what it reads; the result describes the bytes read. Not tested; one sentence in the doc comment.
- **Two concurrent imports of one file**: the content-addressed `put` steps already make the second write nothing. By inspection.
- **Durability**: imported pieces are durable after `flush`, exactly as `put`'s, because they mark the same directories dirty. By inspection.

## Docs

docs/blobs.md's *Putting and reading by file path* section names `FilePieceStore` as offering the capability, and §The local store's paragraph on `FilePieceStore` gets one sentence saying so. `yarn lint:docs`.

## TODO

- Factor `put`'s write steps; implement `importFile` and `exportFile` on `FilePieceStore`; declare `implements IPieceStore, IPieceStoreFiles`.
- Supply `files` helpers in the spec's harness.
- Docs as above.
- Build db-p2p-storage-fs; run `file-piece-store.spec.ts`; `yarn lint:docs`.
