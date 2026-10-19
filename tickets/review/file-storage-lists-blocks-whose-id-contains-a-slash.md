description: On Node hosts that use file storage, the store's list of the blocks it holds left out every block whose name contains a slash (every table's header block included), so a peer joining a group was never sent those blocks up front. The listing now walks nested directories the way every other storage backend already lists them.
architecture: packages/db-p2p-storage-fs/README.md#on-disk-layout
files: packages/db-p2p-storage-fs/src/file-batch-backend.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/README.md, packages/db-p2p/src/storage/node-kv-namespaces.ts, packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts
----
GitHub issue: gotchoices/Optimystic#41.

## What changed

- `FileBatchBackend.listBlockIds` is now a recursive walk (`walkBlockDirectories`, with helpers `childDirectoryNames` and `hasMetadataFile`). Every directory holding `meta.json` is yielded as its path relative to `basePath`, segments joined with `/`. It descends into every child directory except:
  - inside a block directory: that block's own store directories (`BLOCK_STORE_DIRS` = `ACTION_SCOPED_DIRS` values + `revs` + `proofs`). The path helpers now use the same `METADATA_FILE` / `REVISIONS_DIR` / `PROOFS_DIR` constants, so the layout and the walk cannot drift apart. A `NOTE:` at the constant records the pre-existing `x/revs` collision limit.
  - at the root only: the node's KV namespaces (`ROOT_KV_NAMESPACES`, built from db-p2p's new `NODE_KV_NAMESPACES`).
  - ENOENT means "not there"; any other error is logged and thrown. Results are yielded lazily as the walk goes.
- db-p2p: new `src/storage/node-kv-namespaces.ts` exports `NODE_KV_NAMESPACES` (`under-replicated`, `coordinator`, `participant`, `executed`), built from `UNDER_REPLICATED_KEY_PREFIX` and from new `COORDINATOR_STATE_KEY_PREFIX` / `PARTICIPANT_STATE_KEY_PREFIX` / `EXECUTED_KEY_PREFIX`, which `PersistentTransactionStateStore` now uses in place of its string literals. It is exported from both `index.ts` and `rn.ts`, because the entry-parity spec requires that.
- Updated the `NOTE:` in `FileKVStore.keyToPath` and the README's shared-`basePath` paragraph and on-disk layout.
- I read `WriteGroupDriver.mergedBlockIds`: the unflushed-write overlay is keyed by the raw block id, so ids containing `/` work there with no change.

## Tests added

- Conformance (`raw-storage-conformance.ts`): "listBlockIds yields block ids containing `/`, including a block nested inside another". Saves metadata for `default/app/Ledger`, `default/app/Ledger/index/LedgerLatest` and `optimystic/schema`, and expects exactly those three. This is the reproduction and holds every backend to the contract. I did not re-run it against the old code; the old one-level scan cannot yield any of those ids.
- fs-specific (`file-storage.spec.ts`, `FileRawStorage.listBlockIds`): a `FileKVStore` on the same base path writes `under-replicated/default/app/meta`, and only the real block is listed.

## Validation

- `packages/db-p2p-storage-fs` `yarn test`: 108 passing, 1 pending (a POSIX-only skip).
- `packages/db-p2p` `yarn test`: 3483 passing. The one failure (entry parity: the new module was missing from `rn.ts`) was mine; I fixed it and re-ran that spec green.
- `yarn lint` and `yarn lint:docs` are clean.
- I did not run the full `yarn check` or the integration suites.

## For the reviewer

- Cost: each directory on the walk costs one `readdir` and one `access`, so a startup scan now also visits intermediate directories. Fine at current store sizes; the paging `NOTE:` is kept.
- A new node KV namespace has to be added to `NODE_KV_NAMESPACES`, or a key ending in `/meta` under it would be listed as a block. Nothing enforces this beyond the comments at `FileKVStore.keyToPath` and on the constant.
- No on-disk layout change, so the `packages/upgrade-check` fixtures are unaffected.
