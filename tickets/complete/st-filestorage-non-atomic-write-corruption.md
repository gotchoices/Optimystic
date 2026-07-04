description: The on-disk storage backend now writes files atomically (temp file + rename + fsync) instead of overwriting in place, and reads treat a crash-damaged file as "missing" instead of throwing forever — so one crash mid-write can no longer permanently wedge a block.
prereq:
files: packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/register.mjs, packages/db-p2p-storage-fs/.mocharc.json, packages/db-p2p-storage-fs/package.json, packages/db-p2p/src/storage/block-storage.ts (recover(), unchanged)
difficulty: medium
----

# Complete: atomic filesystem writes + corruption-tolerant reads

## What shipped

The Node filesystem storage adapter used to overwrite files in place with a plain
`fs.writeFile` (truncate-then-write, no fsync). A crash mid-write left a torn file,
and reads **rethrew the `JSON.parse` `SyntaxError` forever**, so one ill-timed crash
turned committed data into a permanently-throwing block. Fixed on both fronts:

- **New `src/atomic-write.ts` — `atomicWriteFile(filePath, content)`:** `mkdir` parent
  → open unique `<name>.<pid>.<counter>.tmp` sibling → `writeFile` → `handle.sync()`
  → `close` → `fs.rename` into place → best-effort parent-dir fsync (swallowed on
  win32). On failure: close handle, `unlink` temp, rethrow. A reader sees only the
  complete old or complete new file.
- **`FileRawStorage.ensureAndWriteFile`** and **`FileKVStore.set`** both delegate to
  `atomicWriteFile` (one impl).
- **`FileRawStorage.readIfExists`** maps `SyntaxError` (corrupt-but-present → torn
  write) to `undefined` with a log, keeps `ENOENT → undefined`, and still **rethrows
  real I/O errors** (non-ENOENT `code`). Flows to all `get*` reads and `recover()`.
- **Minimal test harness bootstrapped** (`register.mjs`, `.mocharc.json`, `test`
  script, `mocha`/`ts-node` devDeps). Broader harness work (README, CI, wider
  coverage) is owned by **`eh-7`** — build on this, do not redo it.

`block-storage.ts` unchanged; its `recover()` benefits because `getMetadata` no
longer throws on a torn `meta.json`.

## Review findings

Adversarial pass over the implement diff (commit `20d1970`). Read all touched source,
the tests, `block-storage.ts` recover(), `FileKVStore`, and the db-p2p storage doc.

**Checked — no defects found:**
- **Atomic-write state machine** — open/sync/close/rename/unlink ordering is correct;
  error path closes the handle (idempotent double-close is harmless) and unlinks the
  temp; `fsyncDir` swallows all errors so a best-effort dir-fsync never fails the
  write. Temp is a same-dir sibling → no `EXDEV`. `pid`+counter names are collision-safe.
- **Temp files never surface as data** — suffix is `.tmp`, not `.json`; verified both
  directory scanners that could see them (`FileRawStorage.listPendingTransactions`
  and `FileKVStore.list`/`listRecursive`) filter on `.json` and skip temps. Reads
  target canonical paths only.
- **Corruption vs I/O discrimination** — `err instanceof SyntaxError` (JSON.parse's
  error, carries no `code`) vs `code`-bearing I/O errors is sound; empty/zero-byte
  files (`JSON.parse('')` → SyntaxError) correctly read as missing. Test proves a real
  `EISDIR` still propagates.
- **KV parity** — `FileKVStore` stores opaque strings (no JSON.parse), so it gets
  write-side atomicity but not read-side corruption detection — correct and inherent;
  a checksum would be the only way to detect torn opaque strings, out of scope.

**Minor — fixed in this pass:**
- **Test gap: rename-over-existing happy path was uncovered.** The atomicity tests
  only exercised first-write (no existing target) and *failed* rename; the successful
  *replace* of an existing file — the exact operation whose platform atomicity the fix
  relies on — had no test. Added `a successful second write replaces the prior value`
  to `FileRawStorage` describe (asserts value B replaces value A, no temp left). 8
  passing (was 7).
- **Windows rename-over-open-file hazard** — recorded as a tripwire (see below), not a
  code change.

**Noted — no action (design decisions, consistent with ticket intent):**
- **Corrupt-read is logged via `debug`, not a visible warn.** The handoff called it a
  "warn-log"; it is actually `debug('optimystic:db-p2p-storage-fs:storage:file', …)`,
  silent unless `DEBUG=` is set. Left as-is: (a) the whole package uses `debug`
  uniformly — a lone `console.warn` would break that; (b) a corrupt block reading as
  "missing" is the intended signal that triggers peer restoration in the p2p layer, so
  silent-to-console is acceptable at this layer.
- **`readActionScopedFile` raw-colon fallback `.catch(() => undefined)`** swallows ALL
  errors (incl. EACCES/EIO) on the legacy pre-encode POSIX path. Pre-existing
  (predates this ticket); only runs on non-win32 when the encoded read already missed,
  for legacy raw-colon files. Its swallow-to-missing behavior is now *consistent* with
  the ticket's corruption-tolerance philosophy. No change.
- **`packages/db-p2p/docs/storage.md`** already claimed "Atomic Operations… no partial
  writes leave corrupted state" and "Locking: Prevents concurrent access corruption."
  The atomicity claim is now *more* accurate than before this ticket; the "Locking"
  claim is **pre-existing drift** (the fs adapter still has no lock — `proper-lockfile`
  TODO at `file-storage.ts:22`). Not introduced here; not fixed here (the doc is
  generic/aspirational and describes the abstract storage system, not this adapter).
  `db-p2p-storage-fs` has no README to update — that is `eh-7`'s scope.

**Major (new ticket):** none.

## Tripwires (conditional — no ticket)

- **Windows rename-over-open-file EPERM.** On win32, `fs.rename` over an existing
  target can throw `EPERM`/`EACCES`/`EBUSY` if a concurrent reader holds the target
  open without `FILE_SHARE_DELETE`. Node reads (`readIfExists`/`get`) open→read→close
  in a tiny window, so it is rare, and modern libuv retries some cases; the adapter is
  also single-writer / last-writer-wins with no cross-process lock, so it is not
  reachable under current usage. If it ever surfaces as spurious write failures under
  concurrent read+write on Windows, add a bounded retry loop at the rename (as
  `write-file-atomic` does). Parked as a `NOTE:` at the rename site in
  `src/atomic-write.ts`.
- **Orphaned `*.tmp` after a crash between open and rename** (recorded by the
  implementer). Inert — never read, skipped by `.json` scans. No cleanup sweep. If a
  crash-looping writer accumulates many, add a startup `*.tmp` sweep. `NOTE:` at the
  temp-name site in `src/atomic-write.ts`.

## Validation

- `yarn build` (tsc) — clean, exit 0 (tsconfig includes `test/`, so the spec is
  type-checked).
- `yarn test` — **8 passing** (`packages/db-p2p-storage-fs`): torn `meta.json` →
  `getMetadata` undefined; `recover()` over corrupt meta → `{reconciled:false}`, no
  throw; genuine `EISDIR` still propagates; `saveMetadata` round-trip, no temp;
  **successful replace of an existing file (new)**; injected rename-failure keeps the
  complete old value + cleans the temp; `FileKVStore.set` round-trip + rename-failure
  parity.

## Overlap with `eh-7`

This ticket bootstrapped the **minimal** test harness so the fix could ship with a
reproducing spec. The broader "fs adapter untested / no README / not in CI" work is
owned by **`eh-7`** — build on this harness; do not redo it.
