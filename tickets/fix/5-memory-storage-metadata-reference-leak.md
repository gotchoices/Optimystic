description: MemoryRawStorage.getMetadata returns the stored metadata object by reference, so callers mutating the returned `meta.latest` (notably BlockStorage.setLatest) mutate the stored state BEFORE saveMetadata is called. Under crash-injection this makes mid-commit crashes invisible in RAM — the tests in mid-ddl-crash.spec.ts that would otherwise show "half-applied" commit state instead show fully-applied state because of the leak. Persistent stores (file/sqlite/leveldb) would not exhibit this; the test coverage is therefore understated on MemoryRawStorage.
dependencies:
  - tickets/review/5-mid-ddl-crash-fault-injection-tests.md (this is the spec that surfaced the leak; Crash-D3 case 3 documents it directly)
files:
  - packages/db-p2p/src/storage/memory-storage.ts (getMetadata/saveMetadata — the leak site; compare with getMaterializedBlock which already clones correctly)
  - packages/db-p2p/src/storage/block-storage.ts (setLatest — mutates `meta.latest = latest` on the returned reference, relying on the now-broken caller-owns-a-copy assumption)
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (Crash-D3 third `it` documents the behavior this ticket resolves)
  - docs/internals.md ("Storage Returns References" pitfall — this fix should bring getMetadata in line with that guidance)
----

## Current behavior

`MemoryRawStorage.getMetadata(blockId)` returns `this.metadata.get(blockId)` — the actual stored object reference. `BlockStorage.setLatest` does:

```ts
const meta = await this.storage.getMetadata(this.blockId);
...
meta.latest = latest;                         // MUTATES THE STORED OBJECT
await this.storage.saveMetadata(this.blockId, meta);
```

If `saveMetadata` is interrupted (OS kill, injected crash), the in-memory metadata map entry has already been mutated, so a subsequent `getMetadata` call returns the "new" state as if the save had succeeded.

The `getMaterializedBlock` method in the same file already clones its return value to prevent this class of bug; `getMetadata` should do the same (and the docs/internals.md "Storage Returns References" pitfall is the canonical writeup).

## Desired behavior

`getMetadata` returns a structured clone of the stored BlockMetadata. Mutations on the returned value do not affect stored state. A crash between `meta.latest = latest` and the subsequent `saveMetadata` call leaves the stored `latest` unchanged — matching any persistent store.

## Why this matters

Crash-injection tests on MemoryRawStorage currently understate the risk of mid-commit crashes: the third test in `Crash-D3: crash before setLatest (documented behavior + gap)` observes `meta.latest?.rev === 1` even though `saveMetadata` threw before it could delegate. On a persistent store this would be `undefined`, and the Crash-D3 follow-up ticket (`5-crash-d3-latest-not-updated-silent-invisible-commit.md`) is what's actually needed to reconcile the on-disk half-state.

## TODO

- Update `MemoryRawStorage.getMetadata` to return `structuredClone(meta)` (and mirror in `saveMetadata` if needed for input-hardening, as `saveMaterializedBlock` does).
- Flip the third Crash-D3 test in `mid-ddl-crash.spec.ts` to assert `meta.latest === undefined` after the crash (match a persistent store).
- Then unskip the DESIRED test in the same `describe` block once the recovery-entry-point fix ticket (`5-crash-d3-latest-not-updated-silent-invisible-commit.md`) also lands.
