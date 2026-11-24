description: On a machine that keeps its data in ordinary files, the name of a stored item is used directly as a folder name, and nothing anywhere checks that name — so a name chosen by another machine on the network can make this one write files outside its own storage area.
architecture: packages/db-p2p/docs/storage.md
files: packages/db-p2p-storage-fs/src/file-batch-backend.ts, packages/db-p2p-storage-fs/src/file-write-log.ts, packages/db-core/src/blocks/structs.ts, packages/db-p2p/src/storage/storage-repo.ts
repro: static
severity: corruption
likelihood: unusual
tradeoffs: The filesystem backend is one of five and is not what a browser or phone runs, the escape needs a peer that deliberately sends a malformed name, and the cheap narrow guards are already in place at the destructive site — so a maintainer may reasonably rank a full validation pass behind feature work.
----

# A block id is used as a file path without validation

## What is wrong

A block id is the name of one stored item. In the filesystem backend it is used **raw as a relative path**: the block `default/app/Ledger` lives in the directory `<store>/default/app/Ledger/`. Nested names like that are deliberate and must keep working.

Nothing validates a block id, at any layer:

- `BlockId` is declared as a bare `string` (`packages/db-core/src/blocks/structs.ts`), with a comment claiming base64url that the `/`-separated names above already contradict.
- `StorageRepo` builds a `BlockStorage` for whatever ids its caller names, and its callers include requests arriving from other machines. A read only reads, but a `pend` from a peer writes a file under a peer-chosen name.

So a peer that sends a block id of `../../somewhere` makes this node write a JSON file at `<store>/../../somewhere/pend/<id>.json` — outside its own storage area, anywhere the process has permission to write. The same applies to the write-ahead log, which records that relative path and replays it on the next open, so the escaped write is re-applied after every restart.

## What should happen instead

A block id that does not name a location strictly inside the store should be refused, at one place, before anything is written — not silently used. Specifically, these must all be rejected: a name containing a `..` segment, an absolute path, and the empty name. A `/`-separated nested name that stays inside the store must still be accepted, unchanged.

Whether the right place is a validator at the storage boundary (one check, every backend protected, every path builder free to trust its input) or an encoding of each name segment in the filesystem layout (which also retires the separate nesting limit noted at `BLOCK_STORE_DIRS`) is the design question this ticket exists to settle. The point is that exactly one place should be responsible, rather than each path builder being individually trusted.

## What is already guarded

The review of `a-block-s-bytes-can-be-deleted` closed the destructive case, because `deleteBlock` removes a block's directory **recursively**: an id resolving to the store root or above it would have taken the whole store — write-ahead log and lock included — or a directory the store does not own at all. `FileBatchBackend.blockPath` now refuses any id that does not resolve strictly inside the store, which covers `deleteBlock`, the metadata / revision / proof paths, and the pending listing, and `deleteBlock` resolves the path before it writes anything.

What that guard does **not** cover, and what this ticket is for:

- `relativePath` and `relativeActionScopedPath` build their own relative strings straight from the raw id, so the **write** paths — including the peer-reachable `pend` above — still escape.
- The write-ahead log's replay joins recorded relative paths to the store root with no check of its own.
- No other backend and no layer above has any validation, so the next raw-id consumer starts from nothing.

A consequence of the partial guard, worth knowing while this ticket is open: for an id outside the store a write currently succeeds and the matching read throws. That asymmetry is fail-closed and better than silently serving a file outside the store, but it is not a resting place.
