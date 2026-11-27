description: A node can now store a photo straight from a file and write a received blob straight out to a file, letting the piece store do the byte shuffling in its own native code instead of passing every byte through JavaScript. It is off unless a host asks for it. Review the new code and its documentation.
architecture: docs/blobs.md#the-local-store
files: packages/db-core/src/blob/blob-ref.ts, packages/db-core/src/blob/errors.ts, packages/db-core/src/blob/service.ts, packages/db-p2p/src/blob/piece-store.ts, packages/db-p2p/src/blob/local-blob-service.ts, packages/db-p2p/src/blob/node-blob-service.ts, packages/db-p2p/src/blob/single-machine-blob-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/piece-store-conformance.ts, packages/db-p2p/test/blob-paths.spec.ts, docs/blobs.md, docs/debugging.md, packages/db-p2p/readme.md
----

The specification this serves now has its own section: docs/blobs.md §Putting and reading by file path. The `architecture:` anchor above is the one the implement ticket carried (§The local store, whose "The store never hashes" rule gained its one exception); the new section is where the design actually lives, and tickets 2 and 3 should anchor there.

# Review: put and read blobs by file path

## What was built

An optional capability a piece store may offer — cut a file into pieces and store them, join stored pieces into a file — plus the node setting that governs it and the blob-service forms that use it. Implemented as the ticket specified, with the deviations listed under *Where this departs from the ticket* below.

**db-core**

- `rawPieceIdOfDigest(digest)` in `blob-ref.ts`: the one spelling a store that hashed its own leaves must name them with (CIDv1, raw codec, SHA-256, canonical base32). Throws RangeError for a digest that is not 32 bytes.
- `BlobPathAccess` and `BlobService.paths?` in `service.ts`: an optional property, present exactly when path access exists, carrying `mode`, `putFile` and `readToFile`.
- `BlobImportError` and `BlobImportReason` in `errors.ts`.

**db-p2p**

- `ImportedPiece`, `IPieceStoreFiles` (`importFile`, `exportFile`) and `offersFiles` in `blob/piece-store.ts`; the `IPieceStore` "never hashes" paragraph now names the exception.
- `BlobPathMode = 'off' | 'verify' | 'trust'` and `LocalBlobServiceInit.paths` (default `'off'`).
- `LocalBlobService.paths`, built by `pathAccess`, which also logs the one `blob:paths` line.
- `LocalBlobService.putFile`: the import inside one shared sweep-gate hold with every reported id added to `inProgress` before the hold ends (the accepted-tradeoff `NOTE:` is at `importLeaves`), then the cut/id/size check, then the `verify` hash pass, then `BlobTreeAssembler` over `sinkFor`.
- `LocalBlobService.readToFile`: a use held for the call, `planBlobRange` over the whole range to list the data pieces in order (checking the list pieces on the way), then `exportFile`.
- `NodeBlobService.paths` (export fetches first, with one use held across both) and `SingleMachineBlobService.paths` (straight through).
- `NodeOptions.blobs.paths` wired into the service, with the option's doc comment naming all three values and what `trust` gives up.
- `runPieceStoreConformance` gained a `file import and export` block, gated on `offersFiles(store)` and needing the new `PieceStoreHarness.files` helpers.

## Use cases to exercise when reviewing

**The setting decides what exists.** With `blobs.paths` absent or `'off'`, `node.blobs.paths` must be `undefined` and nothing else may differ from the previous build — no extra store call, no extra hash, no behaviour change in `put`, `read`, `stat` or the sweep. With a store that offers no file access, `node.blobs.paths` must be `undefined` under `'verify'` and `'trust'` too. Both are pinned by *offers path access only where the setting and the store both allow it*.

**A path put is the same blob as a stream put.** `paths.putFile(file)` must answer the reference and size `put` of that file's bytes answers, at zero bytes, at exactly one leaf, and at a size with more leaves than one list piece holds. If these ever disagree, a host that moves between the two forms gets two references for one file and the content-addressing claim breaks. Pinned for both modes at 0, 262144 and 175 × 262144 + 1 bytes.

**`verify` really checks, and `trust` really does not.** With a store that names one leaf by a hash that is not its bytes: `verify` must reject with `BlobImportError` reason `digest-mismatch` and the falsely named piece must be gone from the store (a local read would otherwise serve it as verified, to a reader and to a peer); `trust` must accept, and its reference is then not the one those bytes have. Both pinned.

**A store that cuts differently is refused, whatever the mode.** A short leaf anywhere but last means the tree would not match a stream put's. Pinned under both modes.

**The sweep and an import.** Worth reading rather than running: `importLeaves` holds the gate shared for the whole import because the store writes the leaves before the service hears their ids. `PieceSweeper.decideAndDelete` reads `inProgress.ids()` inside its exclusive hold, which is what makes the single hold sufficient — check that reasoning, since the alternative (a hold per piece) would silently lose an import's pieces to a concurrent sweep. The cost is that a sweep waits for a running import.

**What a failed path put leaves.** A rejected `importFile` schedules a sweep even though the service learned no ids (the store's contract allows a rejection to leave leaves stored). A rejected check or verify leaves the reported pieces in `mine`, so the existing failed-put sweep covers them.

**A zero-byte blob.** `planBlobRange` yields no pieces for one, so `readToFile` calls `exportFile([], path)` and the store must write an empty file. Pinned in both the conformance block and the spec.

**The documentation is part of the deliverable** (the decision that authorised this work made thorough documentation a condition). Read docs/blobs.md §Putting and reading by file path end to end as a host would: the capability contract, each setting's guarantee, what `trust` gives up including the local-read exception, the sweep tradeoff, which stores offer it, and the instructions for implementing one. Then packages/db-p2p/readme.md §Storing and reading blobs by file path as the host-facing version, and the `blob:store` row of docs/debugging.md for the three new lines.

## Tests

One new spec, `packages/db-p2p/test/blob-paths.spec.ts`, and one new gated block in the conformance suite. Each case and what it verifies:

- *offers path access only where the setting and the store both allow it* — `paths` is undefined for `'off'` and for a store without the capability, and reports the mode otherwise. The one branch a host's `if (paths !== undefined)` rests on.
- *puts N bytes from a file under MODE as a stream put would, and reads them back* (6 cases: `verify`/`trust` × 0, 262144, 175 × 262144 + 1 bytes) — the reference and size equal a stream put's, `stat` says `here` with the right size, and `readToFile` writes the bytes back identically. The three sizes are the raw-root, the single-leaf and the multiple-list-piece shapes.
- *verify refuses an import named by a hash that is not its bytes, and removes that piece* — the `BlobImportError` reason and the deletion.
- *trust accepts that same import, and its reference is not the one the bytes have* — the cost that mode buys, stated as an assertion.
- *refuses an import cut at another size under MODE* (2 cases) — the cut check, which is what keeps a path put's reference equal to a stream put's.
- Conformance `file import and export` (10 cases): the cut, ids and sizes at 0, 1000, 262144, 262145 and 3 × 262144 + 5 bytes against `conformancePieceId` of each slice, with every piece read back; one file imported twice storing each piece once; an export joining the pieces in order; an export of no pieces writing an empty file; an export replacing an existing file; and an export naming a missing piece rejecting while leaving a fresh path empty and an existing file untouched.
- A `runPieceStoreConformance('FilePathPieceStore', …)` run in the same spec over the spec's own `node:fs`/`node:crypto` store, so the conformance block is itself exercised. Without it the new conformance code would ship unrun until ticket 2 — see the gap below.

No test was added for the sweep-gate interaction, for out-of-space, for an export of a blob not whole here, or for the browser case; the ticket judged each by inspection or by type, and nothing in them has a branch a test could pin that the existing put and read specs do not already cover.

## Commands run

- `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`
- `yarn workspace @optimystic/quereus-plugin-optimystic run typecheck` (not required by the project rules — that package was not changed — but db-core's interface did change under it; clean)
- `npx eslint` over every changed source and test file
- `yarn lint:docs` — 49 documents, 919 anchored citations, all resolve
- `yarn lint:deps` — clean
- db-p2p, by file: `blob-paths.spec.ts`, `memory-piece-store.spec.ts`, `local-blob-service.spec.ts`, `single-machine-blob-service.spec.ts`, `blob-network-read.spec.ts`, `node-blob-service-probe.spec.ts`, `logger.spec.ts` — 107 passing, 20 pending (the conformance file cases skipped for the two stores with no file capability)
- db-core, by file: `blob-builder.spec.ts`, `blob-ref.spec.ts` — 10 passing

No pre-existing failures surfaced. Per the project's testing rules, no package's full suite was run; review runs those.

## Where this departs from the ticket

Each of these is a deliberate call, not an oversight; take them as the first things to argue with.

- **`blob:paths` is logged by `LocalBlobService`'s constructor, not by the node's wiring.** The ticket said "the node logs that once at start". Logging where the decision is made means `SingleMachineBlobService` — the SQL plugin's service, which ticket 3 builds on — gets the same line, and `libp2p-node-base.ts` needs no second copy of the rule. The cost is one debug-gated line per service constructed, including in every test that builds one.
- **`putFile` and `put` now share a `putPieces` frame.** The ticket described `putFile` as mirroring `put` step for step; two copies of that frame would drift, and the order a put's writes land in is what a crash mid-put is judged against. This refactor touches the existing `put` path, so it wants a look: the frame is byte-identical to what `put` did, with the build step passed in.
- **`BlobImportError` carries five reasons**, not just `digest-mismatch`: `no-pieces`, `not-a-raw-piece`, `size-mismatch`, `piece-missing`, `digest-mismatch`. The ticket asked for "a `reason`" and named one value; the checks it specified need the others to say which one failed.
- **`exportFile`'s contract gained a point the ticket did not state**: an empty `ids` list writes an empty file. A zero-byte blob has no data pieces for `planBlobRange` to yield, so `readToFile` of one calls `exportFile([], path)`. It is in the interface's doc comment and pinned by conformance; ticket 2's `FilePieceStore` must honour it.
- **`SingleMachineBlobServiceInit.paths` was added.** The ticket only said that service passes the local one's `paths` through, but the local service it builds would then always be `'off'` and the pass-through dead. Ticket 3 needs this field.
- **`readToFile` also touches `lastReadAt` and corrects the record on `BlobUnavailableError`**, which the ticket did not ask for. It is a read, and both are what `readChunks` does; without them a path read would not count for the cache budget's eviction order and would leave a `whole: true` record standing after finding a piece missing.
- **`importLeaves` schedules a sweep when `importFile` rejects**, and `NodeBlobService.paths.readToFile` holds one use across the fetch and the export. Neither is in the ticket. The first covers leaves a rejected import stored but never reported, which no set of ids the put holds can reach; the second closes the gap between the fetch's own use ending and the export's beginning, which is the window `NodeBlobService.fetch` already holds a use to avoid.
- **`rawPieceIdOfDigest` throws RangeError for a digest that is not 32 bytes.** The ticket spelled the body with no guard; without one a short digest would be branded as a `PieceId` that `parsePieceId` would refuse.
- **`conformancePieceId` now spells its id through `rawPieceIdOfDigest`** rather than building the CID itself, so the suite and every store that names its own pieces cannot come to disagree about the spelling.

## Known gaps

- **No shipped piece store offers the capability yet**, so the conformance block runs against nothing in `yarn test` except the test store in `blob-paths.spec.ts`. That run also repeats the 11 base `IPieceStore` cases over what is effectively `MemoryPieceStore` plus two methods — a small duplicate of the `MemoryPieceStore` run, kept because the alternative was shipping unrun conformance code for ticket 2 to inherit. A reviewer may reasonably want it dropped once `FilePieceStore` has the capability (ticket 2).
- **`yarn check:rn` was not run** (the project's testing rules exclude it from a ticket). `blob/piece-store.ts` is reachable from the React Native entry and gained its first runtime export, `offersFiles`, which does nothing but two `typeof` checks — but the Metro/Hermes bundle check has not confirmed it.
- **Neither `importFile` nor `exportFile` takes an `AbortSignal`**, so a caller's abort is honoured only between the steps of a put or a read, never during the store's own work. For a 45 MB import that is a real wait. Deliberate — the contract is the ticket's — but say so if it should be widened before ticket 2 implements against it.
- **The big spec case writes a 45,875,201-byte temporary file twice** (once per mode) and reads it back. It runs in about 0.8 s per case here, but it is the only test in the package that touches tens of megabytes of disk; worth a thought about CI.
- **`trust` is exercised only by the test store.** Nothing measures what either mode actually costs on a device; the numbers in the documentation are the ones the Sereus Chat team reported in GitHub #69, attributed as theirs.
- **The sweep-waits-for-an-import tradeoff is unmeasured.** The `NOTE:` says "seconds for a large file" from the import time, not from an observed stalled sweep.

## Follow-ups already filed

`2-file-piece-store-imports-and-exports-files` gives `FilePieceStore` the capability; `3-sql-blob-service-puts-and-reads-by-path` exposes it through the SQL plugin's blob service. Neither is blocked by anything here.
