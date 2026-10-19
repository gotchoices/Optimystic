description: On Node hosts that use file storage, the store's list of the blocks it holds leaves out every block whose name contains a slash, which includes every table's header block, so a peer joining a group is never sent those blocks up front and has to fetch each one on demand. List them the way every other storage backend already does.
architecture: packages/db-p2p-storage-fs/README.md#on-disk-layout
files: packages/db-p2p-storage-fs/src/file-batch-backend.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/README.md, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/src/repo/kv-under-replication-ledger.ts, packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/src/index.ts
difficulty: easy
----
GitHub issue: gotchoices/Optimystic#41.

## The defect

`FileBatchBackend.listBlockIds` (`packages/db-p2p-storage-fs/src/file-batch-backend.ts`) yields only the **direct** children of `basePath` that hold a `meta.json`. But `blockPath` is `path.join(basePath, blockId)` with the id used raw, so a block id containing `/` is stored in nested directories: `default/app/Ledger` lives at `basePath/default/app/Ledger/meta.json`. `default/` holds no `meta.json`, so nothing below it is listed.

Every named block has a `/`: collection headers (`default/app/<Table>`, `default/app/<Table>/index/<Index>`), `optimystic/schema`, and Sereus's `default/strand/*` and `default/cadrecontrol/*` tables. The memory, SQLite, LevelDB and IndexedDB backends key metadata by the id itself and list them all, so the file backend lists a different set of blocks. The `listBlockIds` contract in `packages/db-p2p/src/storage/i-raw-storage.ts` says one id per block with any durable metadata.

Measured downstream (two Node parties over a 176 ms relay round trip, Sereus 1.17.0): Sereus's peer-join backfill, which enumerates by `listBlockIds`, offered 80 of 120 blocks. The joiner's first-sync probe took 14.0 s on published code and 1.7 s with a listing that descends.

Repro (from the issue): save metadata through `FileRawStorage` for `'default/app/Ledger'`, `'default/app/Ledger/index/LedgerLatest'` and `'optimystic/schema'`; `listBlockIds()` yields none of them, while `getMetadata('default/app/Ledger')` reads it back fine.

## The fix

Replace the one-level scan with a recursive walk of `basePath`:

- At each directory, if it holds `meta.json`, yield its path relative to `basePath`, segments joined with `/` (never `path.sep`, so a Windows host yields the same id it was given).
- Descend into every child directory, with two exclusions:
  - **Inside a block directory** (one holding `meta.json`), skip that block's own store directories: `revs`, `pend`, `actions`, `proofs`, `blocks`. A block's directory can contain another block's: the index header `.../Ledger/index/LedgerLatest` sits inside the table header `.../Ledger/`, so the walk must keep going below a block, but not into the block's own per-revision files. Derive the five names from the existing path helpers (`ACTION_SCOPED_DIRS` plus `revs` and `proofs`) as one constant, so the layout and the walk cannot drift.
  - **At the root only**, skip the directories `FileKVStore` writes when it shares the base path: the node's KV namespaces `under-replicated`, `coordinator`, `participant`, `executed`. Without this a KV key whose last segment is `meta` would be listed as a block. That is reachable: the under-replication ledger key for a block whose id ends in `/meta` is `under-replicated/<…>/meta`, stored as `meta.json`. Skipping these also keeps a startup scan from reading `executed/`, which can hold many files. A block id starting with one of these words already collides with the KV store on write (see the `NOTE:` in `FileKVStore.keyToPath` and the README), so skipping them loses nothing.
- Keep the existing error discipline: ENOENT from `readdir`/`access` means "not there"; any other error is logged and thrown. Stay lazy: yield as the walk goes, rather than collecting everything first.

**Where the KV namespace names come from.** They are db-p2p's, not the file package's. Export one constant from db-p2p, e.g. `NODE_KV_NAMESPACES` (`readonly string[]` of the first segments), next to the prefixes it is built from. `UNDER_REPLICATED_KEY_PREFIX` already exists in `kv-under-replication-ledger.ts`. Give `persistent-transaction-state-store.ts` named prefix constants for its three literals and use them there. Then import the list in `file-batch-backend.ts`. Update the comment in `FileKVStore.keyToPath` and the README paragraph ("The two stores can share the same `basePath`…"), both of which currently say the listing sees only top-level `meta.json` directories.

Rejected alternative: encode `/` in block directory names (one flat level). It would make the existing one-level scan correct, but it changes the on-disk layout. Every existing store would need a migration, and `packages/upgrade-check` fixtures written by released versions would have to keep reading. The walk reads existing stores as they are.

## Edge cases & interactions

- A block nested inside a block (`a/b` and `a/b/c` both have metadata): both are listed. Covered by the conformance case below.
- An intermediate directory that is not a block (`default/`, `default/app/`): not listed, but descended. Covered by the same case.
- A block directory without `meta.json` (pending only, through the raw driver): still not listed. It is still descended, and that is harmless. The existing test "excludes a block that has only a pending transform" keeps covering it.
- A KV store sharing the base path, with a key whose last segment is `meta` (e.g. `under-replicated/default/app/meta`): not listed. Add this to the existing `listBlockIds` describe in `test/file-storage.spec.ts`, since it is file-specific.
- `write-ahead.log` and `store.lock` at the root are files, so they are skipped as before. The existing stray-file test covers this.
- A block whose id's last segment is one of the five store-directory names (`x/revs`) collides with block `x`'s own directory on write. That is a pre-existing layout limit, not introduced here. Leave a `NOTE:` at the reserved-names constant and don't try to solve it.
- Windows: ids are rebuilt with `/`, so `default/app/Ledger` round-trips. The conformance case verifies this on whatever platform runs it.
- Unflushed writes: `listBlockIds` already sees the driver's overlay via `WriteGroupDriver` (the "flushed or not" test). Confirm by reading the code that the overlay path handles `/` ids, and add nothing if it does.
- Cost: one `readdir` per directory on the walk and one `access` per directory. That is fine at current store sizes. Keep the existing paging `NOTE:` and adjust its wording.

## Tests

- **Conformance** (`packages/db-p2p/src/testing/raw-storage-conformance.ts`): one case, "listBlockIds yields block ids containing `/`, including a block nested inside another". Save metadata for `default/app/Ledger`, `default/app/Ledger/index/LedgerLatest` and `optimystic/schema`, and expect exactly those three. This holds every backend to the contract. It is the reproduction and fails on the file backend today.
- **File-specific** (`packages/db-p2p-storage-fs/test/file-storage.spec.ts`, `describe('FileRawStorage.listBlockIds')`): one case, a `FileKVStore` over the same base path writing `under-replicated/default/app/meta`, and that key's directory is not listed.

## TODO

- Export `NODE_KV_NAMESPACES` (and the persistent-state prefix constants) from db-p2p, and use the constants in `persistent-transaction-state-store.ts`.
- Rewrite `FileBatchBackend.listBlockIds` as the recursive walk above, with the reserved store-dir constant and its `NOTE:`, and update its block comment.
- Update the `NOTE:` in `FileKVStore.keyToPath` and the README's shared-`basePath` paragraph and on-disk layout (show a nested `<seg>/<seg>/` block id).
- Add the conformance case and the file-specific KV case; run `yarn test` in `packages/db-p2p-storage-fs` and in `packages/db-p2p` (build db-p2p first; the freshness guard will insist).
- Add a CHANGELOG entry if the repo keeps an unreleased section.
