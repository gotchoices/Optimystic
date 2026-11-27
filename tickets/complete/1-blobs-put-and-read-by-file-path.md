description: A node can now store a photo straight from a file and write a received blob straight out to a file, letting the piece store do the byte shuffling in its own native code instead of passing every byte through JavaScript. It is off unless a host asks for it.
architecture: docs/blobs.md#putting-and-reading-by-file-path
files: packages/db-core/src/blob/blob-ref.ts, packages/db-core/src/blob/errors.ts, packages/db-core/src/blob/service.ts, packages/db-p2p/src/blob/piece-store.ts, packages/db-p2p/src/blob/local-blob-service.ts, packages/db-p2p/src/blob/node-blob-service.ts, packages/db-p2p/src/blob/single-machine-blob-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/piece-store-conformance.ts, packages/db-p2p/test/blob-paths.spec.ts, docs/blobs.md, docs/debugging.md, packages/db-p2p/readme.md
----

Putting and reading a blob by file path is built, specified in docs/blobs.md §Putting and reading by file path, and reviewed. Implemented by `ticket(implement): blobs-put-and-read-by-file-path`; the review's own fixes sit on top of it.

# What landed

An optional capability a piece store may offer — cut a file into raw leaves and store them, join stored pieces into a file — plus the node setting that governs it and the blob-service forms that use it.

**db-core.** `rawPieceIdOfDigest(digest)` in `blob/blob-ref.ts`, the one spelling a store that hashed its own leaves names them with (CIDv1, raw codec, SHA-256, canonical base32; RangeError for a digest that is not 32 bytes). `BlobPathAccess` and the optional `BlobService.paths` in `blob/service.ts`, present exactly when path access exists, carrying `mode`, `putFile` and `readToFile`. `BlobImportError` with five reasons (`no-pieces`, `not-a-raw-piece`, `size-mismatch`, `piece-missing`, `digest-mismatch`) in `blob/errors.ts`.

**db-p2p.** `ImportedPiece`, `IPieceStoreFiles` (`importFile`, `exportFile`) and `offersFiles` in `blob/piece-store.ts`, with the `IPieceStore` "never hashes" paragraph naming the one exception. `BlobPathMode = 'off' | 'verify' | 'trust'` and `LocalBlobServiceInit.paths` (default `'off'`). `LocalBlobService.paths`, built by `pathAccess`, which logs the one `blob:paths` line. `LocalBlobService.putFile`: the import inside one shared sweep-gate hold with every reported id in `inProgress` before the hold ends, then the cut/id/size check, then the `verify` hash pass, then `BlobTreeAssembler` over `sinkFor` — sharing a `putPieces` frame with `put` so the two cannot differ about the order a put's writes land in. `LocalBlobService.readToFile`: a use held for the call, `planBlobRange` over the whole range to list the data pieces in order, then `exportFile`. `NodeBlobService.paths` (fetch first, one use across both steps) and `SingleMachineBlobService.paths` (straight through, with its own `paths` init field). `NodeOptions.blobs.paths` wired into the service. A gated `file import and export` block in `runPieceStoreConformance`, with three file helpers on `PieceStoreHarness.files`.

**Documentation.** docs/blobs.md gained §Putting and reading by file path (the capability contract, each setting's guarantee, exactly what `trust` gives up including the local-read exception, the sweep tradeoff, which stores offer it, and instructions for implementing one), with §The local store, the status paragraph and the summary list updated to point at it. packages/db-p2p/readme.md gained the host-facing §Storing and reading blobs by file path, and docs/debugging.md's `blob:store` row gained the three new lines.

No shipped piece store offers the capability yet; `2-file-piece-store-imports-and-exports-files` gives `FilePieceStore` the capability and `3-sql-blob-service-puts-and-reads-by-path` exposes it through the SQL plugin's blob service. Both should anchor on §Putting and reading by file path.

# Review findings

Read the implement diff before the handoff summary, then the surrounding code: the put and read paths it refactored, the sweeper and the sweep gate it relies on, the builder whose tree it must reproduce, the piece-store contract it extends, and every document it touched.

## Checked and sound

- **A path put is the same blob as a stream put.** `treeOverLeaves` feeds `BlobTreeAssembler` exactly what `buildBlob` feeds it (`cidOfPiece(id)`, `fileBytes` and `treeBytes` both the leaf length), so the two agree at the raw-root, single-leaf and multiple-list-piece shapes. The zero-byte case traced end to end: one empty leaf from the store, assembler returns it as the root, `planBlobRange` yields no pieces because its clamped range is empty, and `exportFile([], path)` writes an empty file.
- **The single shared sweep-gate hold really is sufficient** — the question the handoff asked a reviewer to check. `PieceSweeper` reads `inProgress.ids()` inside `gate.exclusive` (`piece-sweeper.ts:146`, `:167`–`:173`), and `importLeaves` holds the gate *shared* until every reported id is in `inProgress`; an exclusive hold cannot run inside a shared one, so no sweep can see the store's new pieces before their ids are protected. The accepted-tradeoff `NOTE:` at the site states the cost and the revisit condition correctly.
- **`verify` cannot pass on a falsely named leaf.** The reported length is pinned against the cut first, then against the stored bytes, so `checkPiece` is left only the digest to fault on, as its comment claims.
- **The failed-put paths leave nothing unaccounted for.** A rejected `importFile` schedules a sweep even though no ids were learned (the store's contract allows a rejection to leave leaves stored); a rejected check or verify leaves the reported ids in `mine`, which the existing failed-put sweep covers; `inProgress` is refcounted and released once per put, and `importLeaves` adds a repeated leaf id once, matching `sinkFor`.
- **An import cannot overwrite a correctly stored piece**, since `IPieceStore.put` writes nothing for a present id — which is what keeps the eager delete of a falsely named piece from being able to destroy vouched-for bytes, and the reasoning in that `NOTE:` holds.
- **The deviations from the implement ticket are all improvements**, including the three the handoff flagged as the first things to argue with: logging `blob:paths` where the decision is made (so `SingleMachineBlobService` gets it too), the shared `putPieces` frame (byte-identical to what `put` did), and `readToFile` touching `lastReadAt` and correcting the record on `BlobUnavailableError` (both are what `readChunks` does, and without them a path read would not count for cache eviction).
- **Documentation reflects the code.** Every claim in the new section was checked against the implementation: the order of a path put's checks, `putFile` refusing on a full node before the import starts, `readToFile` rejecting before the store is asked to write, the list pieces being checked on the way out while the data pieces are not, and the three settings' guarantees.
- **`yarn check:rn` now run**, closing the gap the handoff flagged: `blob/piece-store.ts` ships to React Native and gained its first runtime export, and `blob/local-blob-service.ts` gained eight new db-core imports under the same entry. The Metro bundle and the Hermes compile both pass.

## Fixed in this pass

- **A path put could not be cancelled before it began.** `putFile` checked `options.signal` only *after* the import, and `importFile` takes no signal, so a caller that had already aborted waited out a whole file — tens of seconds for a photo on a phone, which is the use case. An abort check now runs before the import, with the reason at the site (`local-blob-service.ts`).
- **The conformance suite's "exports the pieces joined in order" did not check order.** Its content generator repeats with period 256, which divides the 256 KiB piece size, so every *full* leaf of a multi-leaf file had identical bytes and therefore one id: a 4-leaf file was 2 distinct pieces, and a store that joined or reported its full leaves in any order passed. This is the contract ticket 2's `FilePieceStore` and Sereus's React Native store will be judged by, so it mattered more than a test usually does. The file cases now build their buffers through a `fileBytes` helper that carries the leaf's number in one byte per leaf — the same 4-leaf file is now 4 distinct pieces (verified directly), and the import, twice-import and export-order cases all bite.
- **One new case: an import whose leaf is named with the list-piece codec is refused.** `parsePieceId` accepts a dag-pb id too, so the `cidOfPiece(id).code !== RAW_CODEC` check in `assertRawPieceId` is load-bearing and had nothing behind it — deleting it broke no test while letting a leaf be named with an id the tree reads as a list piece. `not-a-raw-piece` is now pinned. (`no-pieces` and `piece-missing` are left unpinned on purpose: without them the failure still surfaces, as `BlobTreeAssembler.finish`'s own throw and as the `verify` pass's next check, so a test would pin the error's wording rather than a behaviour.)
- **The 45 MB case no longer runs twice.** It was the only test in the package touching tens of megabytes of disk, and it ran under both modes though what it pins — the tree over more leaves than one list piece holds — has nothing to do with what a mode checks. It runs under `verify` alone; `trust` keeps the other two sizes. The sentence in docs/blobs.md describing what the spec pins was corrected to match.
- **Smaller hygiene.** The file-size `NOTE:` in `local-blob-service.ts` stated 1548 lines where `wc -l` said 1553 (now 1559 and correct). A double space in the `blob:store` row of docs/debugging.md.

## Recorded as tripwires, not tickets

- **Neither `importFile` nor `exportFile` takes an `AbortSignal`**, so an abort is honoured only between the service's steps, never during the store's own work. A `NOTE:` on `IPieceStoreFiles` now says so, why it was left out (a native implementation has nothing to hand one to on most platforms, and widening the contract after two stores implement it is the expensive order) and what the change would be. Conditional, so not a ticket — but ticket 2 and the React Native store implement against this interface and should meet the note there.
- **`readToFile` holds every piece id at once**, because `exportFile` takes the whole list: about 60 bytes per 256 KiB of blob, so a quarter of a megabyte per gigabyte. A `NOTE:` at `wholeBlobPieces` says what would have to change (`exportFile` taking an iterable) if a host ever exports blobs large enough for that to matter.

## Considered and not acted on

- **`local-blob-service.ts` is 1559 lines** (`wc -l`), up from 1150. The existing `NOTE:` names the split to make and its condition — the record-shaping block growing — and that block did not grow; the growth is the path-access code in the class, which needs so much of the class's internals (`sinkFor`, `putPieces`, `beginUse`, `readSource`, `correctRecord`, the gate, `inProgress`) that extracting it would trade a long file for a wide collaborator interface. No ticket, no new note: the one that is there already says the right thing.
- **The `trust`-mode numbers in the documentation are the Sereus Chat team's, attributed as theirs** (GitHub #69), and nothing here measures what either mode costs on a device. That is the honest state and the documentation says whose numbers they are; measuring belongs with a store that actually offers the capability.
- **The conformance suite's `sameBytes` is duplicated in `blob-paths.spec.ts`.** Seven lines, in test code, and the conformance copy is module-private by design. Not worth the churn.

## Not found

No correctness defect in the happy path, the error paths, the sweep interaction or the regression surface: the refactor of `put` into `putPieces` is behaviour-preserving, and every existing blob suite passes unchanged. No ticket was filed — nothing found cleared the filing bar: the two concerns worth remembering are conditional and are now notes at their sites, and everything else was cheap enough to fix here.

# Validation

All green, with the project's testing rules' once-per-ticket full suites:

- `yarn lint` (clean), `yarn lint:docs` (49 documents, 919 anchored citations, all resolve), `yarn lint:deps` (clean)
- `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`
- `yarn check:rn` — Metro bundle 19.7 s, Hermes compile 11.4 s, passed
- `yarn test`: db-core 2139 passing; db-p2p 3971 passing / 104 pending; quereus-plugin-optimystic 1465 passing / 16 pending plus its smoke run. The conformance suite is a shared testing export and this review changed it, so all four storage packages that run it were re-run too: db-p2p-storage-fs 145/11, -ns 89/10, -rn 85/10, -web 85/10 (the pending ones are the file cases skipped for stores without the capability).
- `yarn workspace @optimystic/db-p2p test:integration` — 60 passing / 2 pending, since `node-blob-service.ts` changed.

No pre-existing failures surfaced.
