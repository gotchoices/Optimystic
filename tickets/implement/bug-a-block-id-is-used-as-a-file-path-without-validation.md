description: On a machine that keeps its data in ordinary files, the name of a stored item is used directly as a folder name, and nothing anywhere checks that name — so a name chosen by another machine on the network can make this one write files outside its own storage area. Add one check, in the one place every stored name passes through, and refuse a name that would escape.
architecture: packages/db-p2p/docs/storage.md
files: packages/db-core/src/blocks/structs.ts, packages/db-core/src/blocks/block-id.ts (new), packages/db-core/src/index.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/src/storage/released-block-ledger.ts, packages/db-p2p/docs/storage.md, packages/db-p2p-storage-fs/src/file-write-log.ts, packages/db-p2p-storage-fs/src/file-batch-backend.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/test/file-write-log.spec.ts
difficulty: medium
repro: verified
----

# A block id is used as a file path without validation

## What is wrong

A block id is the name of one stored item. In the filesystem backend it is used **raw as a relative path**: the block `default/app/Ledger` lives in `<store>/default/app/Ledger/`. Nested names like that are deliberate and must keep working.

Nothing validates a block id, at any layer. `BlockId` is a bare `string` (`packages/db-core/src/blocks/structs.ts`), and `StorageRepo` builds a `BlockStorage` for whatever id its caller names — including a request arriving from another machine. So a peer that names a block `../escaped` makes this node write a file outside its own store, anywhere the process has permission to write.

### Reproduced (2026-11-24)

Both arms were run against `FileBatchBackend` on win32 and both land a file outside the store. The temporary spec used to confirm it was deleted; the two cases below are the tests this ticket asks for, with the assertions the right way round.

**Arm 1 — the peer-reachable write.** A `pending` entry committed under block id `../escaped`:

```ts
const backend = new FileBatchBackend(path.join(root, 'store'));
const { durable } = await backend.commit(
  [{ key: { store: 'pending', blockId: '../escaped' as BlockId, actionId: 'tx-abc' as ActionId }, value: bytes }],
  { syncWithinMs: 0 },
);
await durable;
```

→ `<root>/escaped/pend/tx-abc.json` exists, i.e. a sibling of the store, with the committed bytes. The existing `FileBatchBackend.blockPath` guard does not fire: the write path is built by `relativeActionScopedPath`, which never calls it.

**Arm 2 — the write-ahead log replays it.** A log holding one `put` record whose relative path is `../escaped/pend/tx-abc.json` (what a crashed pre-fix run leaves behind), then a first operation on a `FileBatchBackend` over that directory:

→ the open's replay re-creates the file outside the store. `FileWriteLog.applyBatch` does `path.join(this.basePath, entry.path)` (`packages/db-p2p-storage-fs/src/file-write-log.ts:743`) with no check of its own, so the escaped write is re-applied after every restart until the log is checkpointed away.

## The decision this ticket settles

The fix ticket left open whether to validate block ids or to encode each name segment in the filesystem layout. **Validate.** Encoding would change the on-disk layout and with it every released upgrade-check fixture; a validator leaves the layout alone, and — as checked below — rejects nothing the system actually uses.

Ownership splits in two, and only two:

1. **`db-core` owns the rule.** `BlockId` is declared there, and the comment that currently misdescribes it is there.
2. **`KvRawStorage` enforces it.** It is the single kernel every shipping backend extends (`MemoryRawStorage`, `FileRawStorage`, `IndexedDBRawStorage`, `LevelDBRawStorage`, `SqliteRawStorage`), and outside tests nothing in `src` constructs a `RawStoreDriver` or a `BatchBackend` without one — checked by grep. Every `IRawStorage` method that takes a `blockId` forwards it to `this.driver`, so one assert per forward, through one private helper, is the whole enforcement. Every path builder below is then free to trust its input.

The write-ahead log's replay gets a containment check of its own, and that is **not** a second owner of the rule: it validates a *recorded relative path*, not a block id, and it is the one place a block id from a **pre-fix build** survives the upgrade — a store whose log already holds an escaped record replays it on the next open however well the kernel is guarded now. It also contains a corrupt or forged log. Three lines, a different input, a stated reason.

### The rule

A block id is valid when, and only when:

- it is a non-empty string;
- it contains no C0 control character and no `\u007f` (a NUL makes `fs` throw, and the rest have no business in a name);
- it contains no backslash — **on win32 `\` is a path separator**, so a `/`-split check alone misses `a\..\..\b`, which resolves to `C:\b`;
- it does not start with `/`;
- it does not start with a Windows drive prefix (`^[A-Za-z]:`) — `C:/elsewhere` leaves the store, and `C:elsewhere` resolves *inside* it on win32 (`<store>\elsewhere`) while naming a literal directory `C:elsewhere` on POSIX, so the same id means two different places;
- every `/`-separated segment is non-empty and is neither `.` nor `..` — which rejects `..`, `a/../..`, a trailing `/`, and `a//b`, `./a`, `a/./b` (those three resolve inside the store but alias another id's directory, so two ids would share one location).

`a..b` is fine. `default/app/Ledger` is fine, unchanged — that is the case that must keep working.

Checked against every block-id literal in the repository (`'...' as BlockId`, 406 distinct values after dedupe): the rule accepts all of them. The only rejection was the `'../escaped'` the repro itself introduced. Also checked: all five ids in the existing `deleteBlock` rejection loop (`''`, `'..'`, `'../sibling'`, `'held/../..'`, and an absolute `path.resolve(os.tmpdir(), ...)`) are rejected by the rule on both platforms.

### Where the throw must sit, and why not lower

The validation must happen **above the write group**. A throw from inside a `commit` is a storage fault: the group latches failed and the store refuses every later write until it is reopened (rule 5 of the flush contract on `RawStoreDriver.flush`, `StoreFailedError`). `KvRawStorage` runs before the driver records anything, so a refused id rejects that one call and leaves the store usable — which is what the existing `deleteBlock` test already asserts for its own guard, and what a peer naming a bad id must not be able to take from a node.

## Things that will bite

- **An existing test's message changes.** `packages/db-p2p-storage-fs/test/file-storage.spec.ts` (the `rejects ${blockId} and writes nothing` loop, ~line 380) calls `storage.deleteBlock(...)` on a `FileRawStorage`, i.e. through the kernel, and asserts `/does not name a directory inside/`. The new kernel guard fires first, so either relax that assertion or give the new error a message that still matches. Decide deliberately; don't discover it as a red run.
- **`FileBatchBackend.blockPath`'s guard stays**, as a backstop for the recursive `deleteBlock` — the blast radius there (the store root, the log and the lock) justifies belt and braces. What must change is its doc comment: it currently names itself the storage boundary and points at this ticket for the rest of the class. Rewrite it to name `KvRawStorage` as the owner.
- **`released-block-ledger.ts` carries a NOTE** that declines a guard of its own because "`FileBatchBackend.blockPath` already refuses such an id at the storage boundary, so a block with one cannot be stored". The repro above disproves that today — a pend write escapes. The reasoning becomes true once this lands, so keep the decline and update the NOTE to cite the kernel assert instead.
- **`lint:docs`** (`scripts/check-doc-citations.mjs`) checks that paths and symbols cited in docs exist, so new prose in `storage.md` must cite real ones.
- The `NOTE:`s at `BLOCK_STORE_DIRS` and on `deleteBlock` about ids that *alias* another block's store directory (`x/revs`, `x/blocks/y`) are a **different** concern — aliasing inside the store, not escaping it — and the validator does not address them. Leave them as they are.
- `tickets/backlog/speculative/6.5-block-id-derivation.md` would make non-header block ids derived hashes. It is not a prereq and does not conflict: header ids stay human-named, `/`-nested collection ids, so the rule is still needed either way.

## Tripwires to record while you are in here

Two win32 facts that are aliasing, not escape, and so are knowledge rather than work. Record each as a `NOTE:` at the validator:

- `path.resolve` trims a trailing space from a segment on win32, so `a ` and `a` would share one directory there and not on POSIX. Not an escape; if ids ever come from a source that can produce trailing spaces or dots, reject those segments too.
- A `:` in a block id is parsed as an NTFS alternate-data-stream separator on win32. It fails noisily rather than escaping (the fs rejects the path), and no block id in the repository contains one, but a strict charset rule — each segment `[A-Za-z0-9._-]+` — is the tightening that would retire it. All 406 ids in the repository would already pass that stricter rule; it is not adopted here because collection ids are chosen by application code at runtime.

## Tests

Four, each a different behaviour. Do not spread the boundary table across the backends.

- **`db-core`, table-driven:** the rule's boundaries in one test — accepts `default/app/Ledger`, `a`, `a..b`; rejects `''`, `'..'`, `'../escaped'`, `'a/../..'`, `'/abs'`, `'C:/elsewhere'`, `'C:elsewhere'`, `'a\\..\\..\\b'`, `'a//b'`, `'./a'`, `'a/./b'`, a trailing `/`, and a NUL-bearing id. This is the one place the rule's edges are pinned.
- **The shared conformance suite** (`packages/db-p2p/src/testing/raw-storage-conformance.ts`): **one** id (`../escaped`) refused by a write, and the store still usable afterwards. One case there covers all five backends — that is why it goes there and not into each package.
- **`db-p2p-storage-fs`, arm 1:** the repro above, inverted — after a refused pend, nothing exists outside the store directory. The conformance case asserts the rejection; this asserts what is (not) on disk, which only the fs backend can.
- **`db-p2p-storage-fs`, arm 2:** the repro's log-replay case, inverted — a log record naming `../escaped/pend/tx-abc.json` applies nothing outside the store on open, and the store opens and serves normally. Build the log with `encodeWriteLogRecord` prefixed by `WRITE_LOG_HEADER`, as the repro did.

Per `tickets/rules/testing.md`, run only what you touched: the two fs specs, the db-core spec, and one backend's conformance run. The full package suites are review's job.

## TODO

- Add `packages/db-core/src/blocks/block-id.ts`: `isValidBlockId(id: string): boolean`, `assertValidBlockId(id: BlockId): void` throwing a named error type, and the rule stated once in a doc comment. Export both from `packages/db-core/src/index.ts`.
- Replace the stale `// base64url encoded (256-bit random)` comment on `BlockId` in `packages/db-core/src/blocks/structs.ts` with what a block id actually is — a random base64url id **or** a human-named `/`-separated collection path — and point at the validator.
- In `packages/db-p2p/src/storage/kv-raw-storage.ts`, add one private helper that asserts and returns the id, and route every `this.driver.<op>(blockId, ...)` through it — reads included, so an id outside the store cannot be read either. State the inspection grep in the class doc comment, the way Invariant 2 does.
- In `packages/db-p2p-storage-fs/src/file-write-log.ts`, make `applyBatch` refuse a record whose path does not resolve strictly inside `basePath`, with a comment saying it guards a recorded path (pre-fix logs, corruption), not a block id. Decide and document what a refused record does to the replay — skip it and log, or stop the replay there — consistent with how `replaySegment` already treats a log that stops short.
- Rewrite the `blockPath` doc comment in `packages/db-p2p-storage-fs/src/file-batch-backend.ts` to name the kernel as the rule's owner and drop the pointer to this ticket.
- Update the NOTE in `packages/db-p2p/src/storage/released-block-ledger.ts` to cite the kernel assert; keep the declined guard.
- Add the invariant to `packages/db-p2p/docs/storage.md` — a block id reaching a backend names a location inside the store — stating the rule, where it is enforced, and what breaks without it, in the shape the other six use. Update the "These six properties" line that opens `## Invariants`.
- Record the two win32 tripwires as `NOTE:`s at the validator.
- Write the four tests above and fix the `deleteBlock` loop's message assertion in `packages/db-p2p-storage-fs/test/file-storage.spec.ts`.
