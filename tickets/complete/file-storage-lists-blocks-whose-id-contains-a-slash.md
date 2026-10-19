description: On Node hosts that use file storage, the store's list of the blocks it holds left out every block whose name contains a slash (every table's header block included), so a peer joining a group was never sent those blocks up front. The listing now walks nested directories the way every other storage backend already lists them.
architecture: packages/db-p2p-storage-fs/README.md#on-disk-layout
files: packages/db-p2p-storage-fs/src/file-batch-backend.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/README.md, packages/db-p2p/src/storage/node-kv-namespaces.ts, packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts
----
GitHub issue: gotchoices/Optimystic#41.

## What landed

`FileBatchBackend.listBlockIds` (`packages/db-p2p-storage-fs/src/file-batch-backend.ts`) is now a recursive walk (`walkBlockDirectories`). It yields every directory that holds `meta.json`, as its path relative to `basePath` joined with `/`. It does not descend into a block's own store directories (`BLOCK_STORE_DIRS`) or into the node's KV namespaces at the root (`ROOT_KV_NAMESPACES`, built from db-p2p's new `NODE_KV_NAMESPACES` in `packages/db-p2p/src/storage/node-kv-namespaces.ts`). `PersistentTransactionStateStore` now names its key prefixes as exported constants, which that list is built from. The layout path helpers share the `METADATA_FILE` / `REVISIONS_DIR` / `PROOFS_DIR` constants with the walk. The on-disk layout is unchanged.

Tests: a shared conformance case (block ids with `/`, one block nested inside another) that every backend runs, and one fs-only case (a shared `FileKVStore` key ending in `/meta` is not listed).

## Review findings

Read the implement diff (`ticket(implement): file-storage-lists-blocks-whose-id-contains-a-slash`) before the handoff.

- **Correctness of the walk** — checked: ids are rebuilt with `/`, not `path.sep`, so a win32 host returns the id it was given. Root-level files (`write-ahead.log`, `.sealed`, `store.lock`) are skipped because only directories are descended. The write log creates no root directories (checked `file-write-log.ts`). ENOENT means "not there"; any other error is logged and thrown. A pend-only directory with no `meta.json` is descended but not listed, as before. Nothing found.
- **Every backend meets the new contract** — ran the conformance suite against sqlite (`db-p2p-storage-ns`, 66 passing), leveldb (`db-p2p-storage-rn`, 61), indexeddb (`db-p2p-storage-web`, 59) and file (`db-p2p-storage-fs`, 108 passing, 1 POSIX-only pending). The implementer covered the db-p2p in-memory and KV compositions. By reading: the old one-level scan cannot pass the new case, since `default/` holds no `meta.json`.
- **KV namespace list completeness** — checked every `IKVStore` writer in `packages/*/src`: the under-replication ledger (built in `libp2p-node-base.ts`) and `PersistentTransactionStateStore` (built only by embedders). Both are covered by `NODE_KV_NAMESPACES`. A future namespace has to be added there by hand. That is a conditional concern, and it already has its comments at `FileKVStore.keyToPath` and on the constant. No new tripwire.
- **Docs** — fixed inline: the README's shared-`basePath` paragraph and the `FileKVStore.keyToPath` `NOTE:` still said a collision needs a block id *equal to* a KV key's first segment. With nested ids, the collision is a block id whose *first segment* is a KV namespace. Both now say that. Also fixed the `BLOCK_STORE_DIRS` `NOTE:`, which covered only `x/revs`. It now also covers deeper ids such as `x/blocks/y`, which the listing never yields either. That stays a tripwire for now: no current id shape puts a store-directory name directly under another block. `yarn lint:docs` is clean.
- **Tests** — kept both. The conformance case reproduces the bug at the lowest layer and holds every backend to the contract. The fs case covers the branch that skips KV namespaces. Neither restates the implementation or verifies a mock. Nothing added.
- **Performance** — each directory on the walk now costs one `readdir` plus one `access`, where the old scan did one `access` per block. Fine at current sizes. The existing paging `NOTE:` at `listBlockIds` already covers the case where this grows. Nothing new.
- **Type safety / error handling / resource cleanup** — no `any`, no swallowed errors, no handles held open (readdir returns arrays, not directory cursors). Nothing found.
- **Regressions** — `yarn lint` and `yarn lint:docs` are clean, and the fs package typechecks. I rebuilt `db-p2p-storage-fs` and ran `packages/upgrade-check` (101 passing), which confirms no fixture was affected. I did not run the full `yarn check` or the integration suites, because this change touches only the file backend's listing.
- **Major findings / tickets filed** — none.
