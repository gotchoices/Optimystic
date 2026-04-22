description: Fix the MemoryRawStorage metadata reference-leak where `getMetadata` returns the stored object directly and `saveMetadata` stores the caller's reference directly. Callers mutating the returned metadata (notably `BlockStorage.setLatest` which does `meta.latest = latest` before `saveMetadata`) currently mutate stored state, masking mid-commit crashes on the in-memory backend. Persistent stores (file/sqlite/leveldb) do not exhibit this; the fix brings `MemoryRawStorage.getMetadata`/`saveMetadata` in line with `getMaterializedBlock`/`saveMaterializedBlock` and `savePendingTransaction`, which already clone.
dependencies:
  - tickets/implement/5-crash-d3-recovery-entry-point-reconciles-latest.md (its DESIRED test can only observe persistent-store behavior once this leak is closed)
files:
  - packages/db-p2p/src/storage/memory-storage.ts — clone on read in `getMetadata`; clone on write in `saveMetadata`
  - packages/db-p2p/src/storage/block-storage.ts — `setLatest` (line 85–92) is the primary caller that mutates the returned metadata; no change required by this ticket, but verify nothing else depends on the leak
  - packages/db-p2p/test/mid-ddl-crash.spec.ts — Crash-D3 third `it` ("documents MemoryRawStorage reference-leak") must flip to asserting `meta.latest === undefined` after the crash (matching persistent-store behavior)
  - docs/internals.md — "Storage Returns References" pitfall (lines 173–181); the `getMetadata` fix is a new instance of the same rule already documented for `getMaterializedBlock`
----

## Change

`MemoryRawStorage.getMetadata` and `saveMetadata` currently return/store the stored reference directly. Update both to clone with `structuredClone`, matching the treatment of materialized blocks and pending transactions in the same file.

```ts
// memory-storage.ts
async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
    const meta = this.metadata.get(blockId);
    return meta ? structuredClone(meta) : undefined;
}

async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
    this.metadata.set(blockId, structuredClone(metadata));
}
```

The matching @pitfall doc-comment on `getMaterializedBlock`/`saveMaterializedBlock` should be mirrored onto `getMetadata`/`saveMetadata` (pointing at `docs/internals.md` "Storage Returns References").

## Test update

In `packages/db-p2p/test/mid-ddl-crash.spec.ts`, the third `it` under `Crash-D3: crash before setLatest (documented behavior + gap)` currently asserts the leak. Flip it so the post-conditions match a persistent store:

- `meta?.latest` is `undefined` after the crash (not `rev === 1`).
- The subsequent default read on a fresh mesh sees empty state (not `rev === 1`).

Retitle from "documents MemoryRawStorage reference-leak..." to describe the correct post-fix behavior (e.g. "crash before setLatest leaves latest unchanged in raw storage").

The second `it` in the same describe block ("retry-commit succeeds via idempotent no-op (leaked in-memory latest matches request)") **will also change behavior** once the leak is closed. With `latest === undefined` after the crash, retry-commit's idempotency check no longer fires; retry will instead throw "Pending action not found" (pending was removed by `promotePendingTransaction`). That residual behavior is the gap being filled by `5-crash-d3-recovery-entry-point-reconciles-latest.md`. Either:

- Land this ticket together with the recovery-entry-point ticket so the retry-commit test is rewritten to call `recoverBlock` first, or
- Update that `it` here to assert the failure (`retry.success === false` and that the error message reflects the missing pending) and let the recovery-entry-point ticket flip it back once `recoverBlock` exists.

Preferred: do the minimal test change here (flip the third `it`; update the second `it` to assert the post-leak-fix retry failure), and let the recovery-entry-point ticket unskip the DESIRED test and rewrite the retry-commit test to use `recoverBlock`.

## TODO

- Update `MemoryRawStorage.getMetadata` to return `structuredClone(meta)` and `saveMetadata` to clone its input. Add pitfall doc-comments mirroring the materialized-block ones.
- Flip the third Crash-D3 test in `mid-ddl-crash.spec.ts` to assert `meta?.latest === undefined` (and that the default read returns empty state) after the crash.
- Update the second Crash-D3 test (`retry-commit succeeds via idempotent no-op ...`) to assert the now-exposed retry failure; the recovery-entry-point ticket will rewrite it back to success-via-`recoverBlock`.
- Run `packages/db-p2p` test suite and confirm all previously-passing specs still pass. The DESIRED `it.skip` stays skipped until the recovery-entry-point ticket lands.
