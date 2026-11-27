description: On a phone, storing a photo as a blob, or writing a received one back out as a file, passes every byte through JavaScript, which takes seconds on older devices. Let a piece store that can do it natively store a blob straight from a file and write one straight to a file, behind a node setting that is off by default, so the bytes never cross into JavaScript.
architecture: docs/blobs.md#the-local-store
files: packages/db-p2p/src/blob/piece-store.ts (`IPieceStore`), packages/db-core/src/blob/service.ts (`BlobService`), packages/db-core/src/blob/blob-ref.ts (`pieceIdOfCid`, `parsePieceId`, `cidOfPiece`), packages/db-core/src/blob/builder.ts (`BlobTreeAssembler`, `PieceWriter`), packages/db-core/src/blob/reader.ts (`planBlobRange`), packages/db-core/src/blob/errors.ts, packages/db-core/src/blob/limits.ts (`BLOB_PIECE_BYTES`), packages/db-p2p/src/blob/local-blob-service.ts (`LocalBlobService.put`, `sinkFor`, `SweepGate` use, `InProgressPieces` use), packages/db-p2p/src/blob/node-blob-service.ts (`NodeBlobService`), packages/db-p2p/src/blob/single-machine-blob-service.ts, packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.blobs`, where `LocalBlobService` and `NodeBlobService` are built), packages/db-p2p/src/testing/piece-store-conformance.ts (`runPieceStoreConformance`, `PieceStoreHarness`), docs/blobs.md, docs/debugging.md, packages/db-p2p/readme.md
----

Decided n8allan, 2026-11-27: build it, on two conditions — it can be turned off, and it is documented thoroughly. Requested in GitHub #69 (Sereus Chat team).

# Put and read blobs by file path

## Why

`BlobService.put` takes a stream of byte arrays and `read` yields one, so on a phone a file goes file → native file library → base64 → JavaScript bytes → `crypto.subtle` (another copy) → piece store, and the reverse for writing a blob out. Measured by Sereus Chat on a Galaxy S7, 1 MB photo: storing takes 0.18–0.57 s natively against 1.1–1.4 s through JavaScript; writing a received one out takes 2.7–3.4 s through JavaScript (17 ms for 1.68 MB natively on an S21).

This ticket adds an optional capability a piece store may offer (cut a file into pieces and store them; join stored pieces into a file), the setting that governs it, and the blob-service forms that use it. Two follow-ups: `2-file-piece-store-imports-and-exports-files` gives `FilePieceStore` the capability, `3-sql-blob-service-puts-and-reads-by-path` exposes it through the SQL plugin's blob service. The React Native store that carries it on phones is Sereus's (gotchoices/sereus#67).

## The capability on a piece store

In `packages/db-p2p/src/blob/piece-store.ts`, beside `IPieceStore`:

```ts
/** One raw leaf a store imported: its id and its length in bytes. */
export interface ImportedPiece { readonly id: PieceId; readonly size: number }

/**
 * Optional on a piece store: pieces as files the host's native code cuts, hashes and joins, so
 * their bytes never pass through JavaScript (docs/blobs.md §Putting and reading by file path).
 */
export interface IPieceStoreFiles {
	/**
	 * Read the file at `path` (a path or URI the platform's file API accepts), cut it into raw
	 * leaves of exactly `pieceSize` bytes (the last one shorter; one zero-length leaf for an empty
	 * file), name each by the SHA-256 of its bytes as a raw-codec CIDv1 in the canonical spelling
	 * (`rawPieceIdOfDigest`), store each as `put` would, and return them in file order. Resolves once
	 * every leaf is stored (in this process; durability is `flush`'s, as for `put`). A rejection may
	 * leave some leaves stored. The point of the capability is that a host can do all of this in native
	 * code; how it does so is the store's.
	 */
	importFile(path: string, pieceSize: number): Promise<ImportedPiece[]>;
	/**
	 * Write the stored pieces `ids`, concatenated in order, to `path`, replacing any file there.
	 * Atomic for the caller: on success `path` holds exactly the joined bytes; on any failure
	 * (a missing piece included) nothing is left at `path` that was not there before — write to a
	 * temporary name beside it and rename.
	 */
	exportFile(ids: readonly PieceId[], path: string): Promise<void>;
}

/** Whether `store` offers {@link IPieceStoreFiles}. */
export function offersFiles(store: IPieceStore): store is IPieceStore & IPieceStoreFiles
```

`IPieceStore`'s "the store never hashes" paragraph gains: except `importFile`, whose ids the service accepts under the `blobs.paths` setting below.

In db-core `blob-ref.ts`, export `rawPieceIdOfDigest(digest: Uint8Array): PieceId` (raw codec, SHA-256, canonical spelling — `pieceIdOfCid(CID.createV1(RAW_CODEC, Digest.create(SHA2_256_CODE, digest)))`), so every store spells imported ids the one accepted way; `conformancePieceId` and `PieceWriter` may use it.

## The setting

`NodeOptions.blobs.paths?: BlobPathMode`, with `type BlobPathMode = 'off' | 'verify' | 'trust'`, default **`off`**. Passed to `LocalBlobService` as `LocalBlobServiceInit.paths`.

- **`off`** (default): no path forms exist (`paths` below is `undefined`). Nothing about storage, hashing or checking differs from a build without this ticket. Off by default because it is new code on the path that decides which bytes a node vouches for, and a host turning it on is the consent.
- **`verify`**: import natively, then read each imported leaf back (`pieces.get`) and hash it with the service's `BlobDigest`; a leaf whose bytes do not hash to its id fails the put. Keeps the rule that the service checks every piece it stores. Costs one crossing of each leaf's bytes and one hash, but no base64 and no copy from the file library.
- **`trust`**: accept the store's ids without hashing. The store's native hash is the only check on this machine. Acceptable because every machine that fetches a piece checks it against its id (`checkPiece`), so a wrong id makes other machines refuse the piece rather than accept bad bytes. What it gives up: this machine will serve, and read back through `readBlob` (which trusts a local `verified` source), a piece whose id it never checked.

When the store does not offer `IPieceStoreFiles`, `paths` is `undefined` whatever the setting, and the node logs that once at start (`blob:paths` with `mode` and `available`).

## The service forms

On db-core's `BlobService`, an optional property, present exactly when path access is available:

```ts
/** Present only when the node's piece store offers file access and `blobs.paths` is not 'off'. */
readonly paths?: BlobPathAccess;

export interface BlobPathAccess {
	/** 'verify' or 'trust' (docs/blobs.md §Putting and reading by file path). */
	readonly mode: 'verify' | 'trust';
	/** `put`, from a file: same pin, record, durability and result as `put` of the file's bytes. */
	putFile(path: string, options?: BlobPutOptions): Promise<BlobPutResult>;
	/** Write the whole blob to `path`, fetching what is not here first (as `fetch`); atomic as `exportFile`. */
	readToFile(ref: BlobRef, path: string, options?: BlobFetchOptions): Promise<void>;
}
```

An optional property rather than methods that throw: a host checks `node.blobs.paths` once and the type tells it the forms may be absent, which is the case in every browser.

### `LocalBlobService` (`paths.putFile`)

Mirrors `put` step for step (owner check, `requireRoomForOwnWrite('put')`, the `mine` set, pieces flushed before the record, record via `changeRecord` and `recordAfterPut`, records flushed, `log('put:stored …')`, sweep scheduled on failure), differing only in where leaves come from:

- Run `importFile(path, BLOB_PIECE_BYTES)` inside `this.gate.shared(...)` for its whole duration, and add every returned id to `mine` and `this.inProgress` before leaving the gate. A stream put holds the gate per piece; an import cannot, because its pieces appear in the store before the service hears their ids, and a sweep running between the store's write and `inProgress.add` would delete them as orphans. The cost: a sweep waits for a running import (seconds for a large file). Record that as an accepted-tradeoff `NOTE:` at the call.
- Check the result before using it: non-empty; every id parses (`parsePieceId`) and is a raw-codec SHA-256 CID; every size is `BLOB_PIECE_BYTES` except the last, which is between 0 and `BLOB_PIECE_BYTES` (0 only when it is the only leaf). A violation fails the put with a `BlobImportError` (new, in db-core `errors.ts`, with a `reason`), since a reference built from a store that cut differently would not match a stream put of the same bytes.
- Under `verify`, read each leaf and hash it; on mismatch, delete that piece (it is stored under a false id), fail with `BlobImportError` reason `digest-mismatch`, log `blob:import-mismatch` with the id.
- Build the tree with `BlobTreeAssembler` over `this.sinkFor(mine)` (list pieces are hashed and put by the service as today), `add` each leaf as `{ cid: cidOfPiece(id), fileBytes: size, treeBytes: size }`, `finish()`. A one-leaf file's reference is the leaf's id. Size is the sum of the leaf sizes.
- `signal` checked between steps; an abort after the import is a failed put (sweep scheduled).

### `LocalBlobService` (`paths.readToFile`)

Whole blob here, or `BlobUnavailableError` as `fetch` gives it. Hold a use (`beginUse`) for the duration so no sweep takes the pieces. List the data pieces in order with `planBlobRange(ref, this.readSource(...))` over the whole range — this checks every list piece on the way, as a read does — then `exportFile(ids, path)`. Data pieces are not hashed again: they were checked when stored (or accepted under `trust`, which is the setting's stated cost).

### `NodeBlobService` and `SingleMachineBlobService`

`NodeBlobService.paths`: `putFile` delegates to the local service; `readToFile` runs this service's own `fetch(ref, options)` first (so missing pieces come from peers through the fetcher, which checks each), then the local export. `SingleMachineBlobService` passes the local service's `paths` through. Each sets `paths` only when the local one is defined.

### Wiring

`libp2p-node-base.ts` passes `options.blobs?.paths` into `LocalBlobService`; add the field to the `blobs` option type with a doc comment that names the three values and links docs/blobs.md.

## Conformance

`runPieceStoreConformance` gains a `describe` that runs only when `offersFiles(store)`, using file helpers the harness supplies (the suite is cross-platform and cannot assume `node:fs`):

```ts
/** On PieceStoreHarness; required when the store offers IPieceStoreFiles. */
files?: {
	/** Write `bytes` to a new file and return its path. */
	write(bytes: Uint8Array): Promise<string>;
	/** A path where no file exists yet, in a directory the store may write. */
	freshPath(): Promise<string>;
	/** The file's bytes, or undefined when there is none. */
	read(path: string): Promise<Uint8Array | undefined>;
};
```

A store offering the capability with no `files` helpers fails the suite. Cases: import returns the ids and sizes the stream builder's leaves would have for the same bytes (compare against `conformancePieceId` of each slice), at sizes 0, 1000, exactly 262144, 262145, and 3 × 262144 + 5; every imported piece is readable with `get` and matches; importing the same file twice stores each piece once; export reproduces the bytes exactly; export over an existing file replaces it; export naming a missing piece rejects and leaves no file at a fresh path (and leaves an existing file unchanged).

## Edge cases & interactions

- **Same reference as a stream put** — verified by a spec in `packages/db-p2p/test/` putting one file both ways (below).
- **Sweep during import** — covered by holding the gate across the import; verified by inspection and the `NOTE:`.
- **A lying or broken store** — `verify` refuses and deletes the bad piece; `trust` accepts. Both pinned by the spec below with a test store whose `importFile` returns a wrong id for one leaf.
- **A store that cuts at another size** — refused by the size check; pinned by the same spec double returning a short middle leaf.
- **Out of space** — refused before the import starts, as `put` is; by inspection.
- **Export of a blob not whole here** — the local service throws `BlobUnavailableError` without calling `exportFile`; `NodeBlobService` fetches first. By inspection.
- **A partial file at `path`** — the store's contract; pinned by conformance.
- **Paths in a browser** — no store there offers the capability, so `paths` is `undefined`. By type.
- **The SQL layer's pins** — `3-sql-blob-service-puts-and-reads-by-path`.
- **Holds, durability, copying** — a path put ends in the same record and holds as a stream put, so the copy drain, durability events and reclaim treat it identically. By inspection.

## Tests

In `packages/db-p2p/test/` (one new spec, e.g. `blob-paths.spec.ts`), over a test store extending `MemoryPieceStore` whose `importFile` and `exportFile` use `node:fs` and `node:crypto` (standing in for a host's native code, not mocking anything this repository owns), and a `LocalBlobService` over it:

- `off` leaves `paths` undefined; a store without the capability leaves it undefined under `trust`.
- A file put by `paths.putFile` gets the reference `put` of the same bytes gets, at 0 bytes, one piece and more than one list piece's worth (175 × 262144 + 1, as `blob-builder.spec.ts` uses), under both `verify` and `trust`; `readToFile` writes back identical bytes.
- A store returning a wrong id for one leaf: `verify` rejects with `BlobImportError` `digest-mismatch` and the piece is gone; `trust` accepts.
- A store cutting a short middle leaf: rejected under both modes.

The `MemoryPieceStore` and `PowerLossPieceStore` conformance runs are unchanged (neither offers the capability).

## Documentation (required, and thorough)

- **docs/blobs.md**: a new section *Putting and reading by file path*, after *The local store* or within *The node's blob service*: what the capability is and why (the #69 measurements), the `IPieceStoreFiles` contract, `blobs.paths` with each value's guarantee and the default and why, the trust `trust` adds and why it was judged acceptable, including the local-read exception, how `readToFile` fetches first, the sweep-gate tradeoff, which stores offer it (FilePieceStore after ticket 2; React Native via Sereus), and how a host implements the capability (cut at `pieceSize`, name with `rawPieceIdOfDigest`'s spelling, atomic export, run the conformance cases with `files` helpers). Rewrite "The store never hashes" in §The local store to state the exception and point at the section.
- **`IPieceStore` and `IPieceStoreFiles` doc comments**, as above.
- **packages/db-p2p/readme.md**: the host option, how to turn it on and off, and that `node.blobs.paths` may be absent.
- **docs/debugging.md**: `blob:paths` (start-up state) and `blob:import-mismatch`.
- `yarn lint:docs`.

## TODO

- db-core: `rawPieceIdOfDigest`; `BlobPathAccess` and `BlobService.paths?`; `BlobImportError`; export from the blob index.
- db-p2p: `ImportedPiece`, `IPieceStoreFiles`, `offersFiles`; `BlobPathMode` and `LocalBlobServiceInit.paths`; `LocalBlobService` `paths` (putFile, readToFile) as above with the gate `NOTE:`; `NodeBlobService.paths`; `SingleMachineBlobService.paths`; `NodeOptions.blobs.paths` wiring and the `blob:paths` start-up log.
- Conformance: `PieceStoreHarness.files`, the gated `describe`.
- `blob-paths.spec.ts` as above.
- Docs as above.
- Build db-core and db-p2p; run `blob-paths.spec.ts`, `memory-piece-store.spec.ts`, `blob-builder.spec.ts` and `local-blob-service.spec.ts` by file; `yarn lint:docs`; `yarn lint:deps`.
