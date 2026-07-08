description: Rewrite the browser IndexedDB block store to plug into the new shared storage core, keeping its existing object stores and atomic promote.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts
difficulty: medium
----

# IndexedDB driver: reimplement `IndexedDBRawStorage` as a `RawStoreDriver`

Depends on `st-kvkernel-core`. **Keep the existing five object stores** (`metadata`, `revisions`,
`pending`, `transactions`, `materialized`) and their compound array keys — this is a code
refactor, **not** a storage-format change. The kernel takes over JSON serialization, so stored
values become `Uint8Array` (IndexedDB stores typed arrays via structured clone) instead of the
current live objects.

## Design

Replace `IndexedDBRawStorage implements IRawStorage` with `IndexedDBStoreDriver implements
RawStoreDriver` over the same `OptimysticWebDBHandle` (`db.ts`). Values move from live objects to
`Uint8Array` — the driver no longer stores/reads parsed `BlockMetadata`/`Transform`/`IBlock`.

Method mapping:

- `getMetadata`/`putMetadata` → `db.get/put('metadata', bytes, blockId)`.
- `getRevision`/`putRevision` → `db.get/put('revisions', bytes, [blockId, rev])`.
- `rangeRevisions(blockId, lo, hi, reverse)` → the existing `IDBKeyRange.bound([blockId, lo],
  [blockId, hi])` cursor (`'next'`/`'prev'` by `reverse`) over the `revisions` store,
  **snapshot-first** into an array, then yield `[rev, bytes]`. Keep the snapshot pattern — a live
  cursor across a consumer await would be invalidated by IndexedDB's idle auto-commit.
- pending / transactions / materialized get/put/delete → existing `[blockId, actionId]`-keyed
  ops.
- `listPendingActionIds` → the existing `IDBKeyRange.bound([blockId], [blockId, []])` key-cursor,
  snapshot-first, yielding the `actionId` element.
- `promote(blockId, actionId)` → the existing single `readwrite` transaction over `['pending',
  'transactions']`: read pending; if absent, `await tx.done.catch(...)` then throw `Pending action
  … not found …`; else put into `transactions` and delete from `pending`; `await tx.done`. **This
  is the atomic move** — keep it exactly.
- `listBlockIds` → existing `getAllKeys('metadata')`.
- `approximateBytesUsed` → existing `navigator.storage.estimate()`.

Keep the user-facing constructor returning an `IRawStorage`, built as
`new KvRawStorage(new IndexedDBStoreDriver(handle))`.

## Edge cases & interactions

- **Snapshot-before-yield preserved.** Both cursor scans MUST drain into an array and `await
  tx.done` before yielding — IndexedDB auto-commits idle transactions, invalidating a cursor held
  across the consumer's awaits. The kernel's drain contract requires this; do not switch to
  lazy yielding mid-transaction.
- **Uint8Array survives structured clone.** IndexedDB stores a `Uint8Array` via structured clone
  and returns a `Uint8Array` — verify the returned value is byte-identical (no `ArrayBuffer`
  vs `Uint8Array` view drift that would break the kernel's decode). The conformance
  round-trip/clone cases catch this.
- **Array-key ordering for pending scan.** The `[blockId] .. [blockId, []]` bound relies on
  IndexedDB array-key ordering (shorter prefix-equal array sorts first; arrays sort above
  primitives) — unchanged; keep the comment.
- **promote failure path.** When pending is absent the transaction must be settled
  (`tx.done.catch`) before throwing, so the failed promote doesn't leak an open transaction — keep
  that ordering.
- **fake-indexeddb parity.** Tests run against `fake-indexeddb`
  (`test/indexeddb-storage.spec.ts` / the web KV specs); production is the browser. Both satisfy
  the handle interface — keep that seam.

## TODO

- Rewrite `indexeddb-storage.ts` as `IndexedDBStoreDriver implements RawStoreDriver`; export an
  `IRawStorage` factory (`new KvRawStorage(new IndexedDBStoreDriver(handle))`) under the current
  public name. Confirm `db.ts` store definitions are unchanged (value type is now a blob).
- Replace `test/indexeddb-storage.spec.ts` assertions with `runRawStorageConformance('IndexedDB',
  …)` wired to a `fake-indexeddb` handle; keep any IndexedDB-only tests the shared suite omits.
- `yarn test:db-p2p-storage-web 2>&1 | tee /tmp/kv-web.log`; typecheck the package.
