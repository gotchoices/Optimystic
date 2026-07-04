description: Review the fix that makes the reference-peer offline path share the node's real StorageRepo instead of creating an orphaned second instance.
files: packages/reference-peer/src/cli.ts, packages/reference-peer/test/offline-storage.spec.ts
difficulty: easy
----

## What was done

### Bug fix — `cli.ts` lines 394-396

`startNetwork()` called `createStorage()` a second time and wrapped it in a fresh `StorageRepo`, which held an independent in-memory `Map`. Any diary entry written by the offline `LocalTransactor` landed in that orphaned store; the running node never saw it.

Fix: replaced the second `createStorage()` + `new StorageRepo(...)` with `(node as any).storageRepo` (with a null guard). The node already exposes this via `libp2p-node-base.ts:1023`. Now both the offline `LocalTransactor` and the node share the same single store.

### Import cleanup

`StorageRepo` and `BlockStorage` were only used at the removed lines. Both were dropped from the import on `cli.ts:4`.  `MemoryRawStorage` stays (still used in `createStorage`).

### `listDiaries` honesty fix

The old console text said "Created diaries:" and "No diaries created yet", implying persisted state. Updated to "Diaries opened this session (not a complete list of persisted diaries):" and "No diaries opened this session" — makes it clear the list reflects only in-process session state.

### Regression test — `test/offline-storage.spec.ts`

Two new mocha tests:

1. **Identity check** — verifies `node.storageRepo` is set after `createLibp2pNode`, and that a freshly constructed `StorageRepo` is a different instance (documents what the old bug created).
2. **Write-then-read** — creates a minimal `LocalTransactor` backed by `node.storageRepo`, writes a diary entry, reads back through the same repo, asserts the entry is visible. Before the fix this test would fail (empty read from orphaned store).

All 6 tests pass (`yarn workspace @optimystic/reference-peer test`).

## Use cases for testing / validation

- Start the peer with `--offline` flag; add a diary entry via `add-entry`; read it back via `read-diary` in the same session — should succeed.
- Start the peer with `--offline` flag; use `list-diaries` — console should say "Diaries opened this session", not "Created diaries".
- Run `yarn workspace @optimystic/reference-peer test` — all 6 tests must pass.

## Known gaps / tripwires

- `listDiaries` still lists only diaries touched in-process. There is no block-storage-level index of collection names, so enumerating persisted diaries would require a separate registry. Out of scope per ticket; no ticket filed (would be `feat-` in backlog if ever needed).
- The `break` after `process.exit(0)` at cli.ts:662 produces a pre-existing "Unreachable code" TypeScript warning unrelated to this ticket's diff.

## Review findings

- Tripwire at cli.ts `listDiaries`: "no block-storage index means persisted-diary enumeration is impossible without a registry; if that's ever needed it's a separate `feat-` ticket" — parked as a code comment on the function.
