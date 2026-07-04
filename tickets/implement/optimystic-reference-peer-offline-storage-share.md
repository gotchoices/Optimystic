description: The reference-peer's offline command opens a second, separate copy of storage, so data it writes is invisible to the running node; make the offline path use the node's real storage instead.
files: packages/reference-peer/src/cli.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/memory-storage.ts
difficulty: easy
----

## Problem

In `reference-peer/src/cli.ts`, `startNetwork()` builds the libp2p node with a
storage factory (`storage: createStorage`, cli.ts:374). The node instantiates
its own `StorageRepo` from that factory and exposes it as `node.storageRepo`.

Immediately after, at cli.ts:394-396, the code calls `createStorage()` **a
second time** and wraps the fresh storage in a **new** `StorageRepo`:

```ts
// Set up storage layer for local transactor (uses same storage as node)
const rawStorage = createStorage();
const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));
```

The comment claims "uses same storage as node" — it does not. For
`MemoryRawStorage` the two instances hold **independent** `Map`s
(`packages/db-p2p/src/storage/memory-storage.ts:5-10` — all state is
per-instance), so anything the offline `LocalTransactor` writes lands in a Map
the running node never reads, and vice versa. For file storage the two
instances point at the same directory but keep independent in-process
`BlockStorage` caches, so they can still go incoherent within one process.

`LocalTransactor` (cli.ts:14-36) is only used in `--offline` mode (cli.ts:413).
So in offline mode, every diary write goes to the orphaned second store.

## Fix

The node already exposes its real `StorageRepo`. `libp2p-node-base.ts:1030`:

```ts
(node as any).coordinatedRepo = coordinatedRepo;
(node as any).storageRepo = storageRepo;      // <-- the node's actual StorageRepo
(node as any).blockChangeNotifier = storageRepo;
```

Replace the second `createStorage()` + `new StorageRepo(...)` with the node's
own storage repo, so the offline `LocalTransactor` shares the single store:

```ts
// LocalTransactor shares the node's own StorageRepo so offline writes are
// visible to the running node (and to any later distributed reads).
const storageRepo = (node as any).storageRepo as StorageRepo;
if (!storageRepo) {
  throw new Error('storageRepo not available on node');
}
```

Keep the `StorageRepo`/`BlockStorage` imports only if still referenced
elsewhere in the file; if not, drop the now-unused imports (cli.ts:4) so the
build stays clean. `MemoryRawStorage` may still be imported by `createStorage`.

Note: `storageRepo` is only actually consumed on the offline branch
(cli.ts:414, `new LocalTransactor(storageRepo)`). The distributed branch uses
`coordinatedRepo` via `getRepo`. Fetching `node.storageRepo` unconditionally is
fine and harmless — but you may guard it to the offline branch if you prefer to
keep the distributed path untouched.

## listDiaries — scope note

The ticket also flags that `listDiaries` (cli.ts:547-559) reports only the
in-process `session.diaries` map, not what is persisted. There is no
block-storage-level index of collection names to enumerate, so making
`listDiaries` reflect arbitrary persisted diaries is **not** a small change and
is **out of scope** here. Instead, correct the honesty gap: update the
`listDiaries` doc/console text (and remove/adjust any comment implying it lists
persisted state) so it plainly says it lists diaries touched in this session.
If a future need for real enumeration arises, file it separately — do not build
a persisted diary registry in this ticket.

## Regression check

Add a test that exercises the write-offline / read-back path over one shared
store. The reference-peer test harness (`packages/reference-peer/test/`, see its
`README.md` — `TestNode` composes `StorageRepo` → `BlockStorage` →
`MemoryRawStorage`) is the right place. Minimum assertion:

- Start a node with memory storage in offline mode (or construct the offline
  `LocalTransactor` against `node.storageRepo`).
- Append an entry to a diary via the offline transactor.
- Read the diary back through the node's own `storageRepo`/`coordinatedRepo`
  path and assert the entry is visible.
- Before the fix this fails (empty read from the orphaned second store); after,
  it passes.

If wiring a full node in the test is heavy, a narrower unit test suffices:
assert that the `storageRepo` handed to `LocalTransactor` is the **same
instance** as `node.storageRepo` (identity check), which is what the bug
violated.

## TODO

- Replace cli.ts:394-396 second `createStorage()` + `new StorageRepo(...)` with
  `node.storageRepo` (with a guard).
- Remove now-dead imports if `StorageRepo`/`BlockStorage` become unused.
- Fix the `listDiaries` comment/console text to state it lists session diaries,
  not persisted state (no registry build).
- Add the regression test (shared-store write-then-read, or storage-repo
  identity check).
- Run the package build + reference-peer tests; stream output with `tee`.
