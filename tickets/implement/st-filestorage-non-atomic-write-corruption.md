description: The on-disk storage backend overwrites files in place with no crash safety, so one crash mid-write can leave a file half-written and permanently unreadable; make writes atomic and make reads tolerate a damaged file instead of wedging on it forever.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/package.json, packages/db-p2p/register.mjs (harness reference), packages/db-p2p/src/storage/block-storage.ts (recover() reads metadata first)
difficulty: medium
----

# Make filesystem-adapter writes atomic + reads corruption-tolerant

## Problem (confirmed by code trace)

The Node filesystem raw-storage adapter overwrites files in place with a plain
`fs.writeFile`, which truncates then writes with no `fsync` and no temp-file+rename:

- `FileRawStorage.ensureAndWriteFile` — `file-storage.ts:251-254`
- `FileKVStore.set` — `file-kv-store.ts:18-22`

`meta.json` is rewritten on every commit (`saveMetadata` → `ensureAndWriteFile`,
via `block-storage.ts` `setLatest`). If the process crashes or the machine loses
power mid-write, the target file is left truncated / half-written.

The corruption is then **permanent, not transient**, because reads rethrow parse
failures:

- `readIfExists` (`file-storage.ts:242-249`) maps only `ENOENT` → `undefined` and
  **rethrows everything else**, including the `SyntaxError` thrown by `JSON.parse`
  on a truncated file.
- `getMetadata` (`file-storage.ts:24-26`) goes straight through `readIfExists`, so
  a torn `meta.json` throws on every read forever.
- `recover()` (`block-storage.ts:94-98`) reads metadata **first** and has no
  catch, so the block cannot even be recovered — one ill-timed crash destroys
  committed data instead of merely delaying it.
- Same rethrow path affects `getRevision`, `getTransaction`, and
  `getMaterializedBlock` (all funnel through `readIfExists` /
  `readActionScopedFile`, `file-storage.ts:233-249`).

## Expected behavior

1. **Atomic writes.** Write to a temp sibling (`<path>.<unique>.tmp`) then
   `fs.rename` into place. `rename` over an existing file is atomic on POSIX and
   on NTFS, so a reader only ever sees a complete old or complete new file — never
   a torn one.
2. **Durability.** `fsync` the file data before the rename, and `fsync` the
   containing directory after the rename on platforms that require it (POSIX), so a
   completed rename survives power loss. Directory `fsync` is not supported on
   win32 — attempt it and swallow the resulting error there (do not let it fail the
   write).
3. **Corruption-tolerant reads.** In `readIfExists`, distinguish a JSON parse
   failure (corrupt-but-recoverable → return `undefined`, log a warning) from a
   real I/O error (still throw). Returning `undefined` lets `recover()` and normal
   reads treat a damaged file as "missing" and make progress rather than wedging
   indefinitely. `readActionScopedFile`'s raw-colon fallback already swallows all
   errors, so it needs no change beyond inheriting the new `readIfExists`.

After the fix: a crash injected at any point during a `meta.json` / revision /
transform / block write leaves the block **readable and recoverable** — either the
prior committed state or the new one, never a permanently-throwing truncated file.

## Design notes / gotchas

- **Unique temp name, not a fixed `.tmp`.** Two concurrent writers to the same
  logical path (this adapter does not currently lock — see the `proper-lockfile`
  TODO at `file-storage.ts:21`) would clobber a shared `<path>.tmp`. Derive the
  temp suffix from a monotonically-incrementing per-instance counter plus `pid`
  (avoid `Math.random()`/`Date.now()` only in tess *workflow* scripts — normal
  source may use them, but a counter+pid is deterministic and collision-safe here).
  Clean up the temp file on write failure (best-effort `unlink` in a `catch`).
- **fsync mechanics.** `fs.writeFile(path, data)` does not expose the fd. Use
  `fs.open(tmpPath, 'w')` → `handle.writeFile(content)` → `handle.sync()` →
  `handle.close()`, then `fs.rename(tmpPath, finalPath)`, then best-effort
  directory fsync (`const dir = await fs.open(path.dirname(finalPath), 'r'); await
  dir.sync().catch(()=>{}); await dir.close();`) guarded so win32 / unsupported
  platforms don't fail. Keep `mkdir(dirname, { recursive: true })` before the open.
- **Apply to both writers.** `FileRawStorage.ensureAndWriteFile` and
  `FileKVStore.set` share the identical flaw. Consider a small shared
  `atomicWriteFile(filePath, content)` helper (new file, e.g.
  `src/atomic-write.ts`, exported internally) so both packages-local classes use
  one implementation. `FileKVStore` is in the same package, so a shared local
  module works.
- **Parse-error detection.** `JSON.parse` throws `SyntaxError`. Prefer catching by
  checking `err instanceof SyntaxError` (or `err?.code === undefined && err
  instanceof SyntaxError`) rather than string-matching the message. An `ENOENT`
  still returns `undefined`; anything with an `errno`/`code` that isn't `ENOENT`
  still throws (real I/O failure must not be silently masked).
- **Orphaned temp files.** A crash between open and rename leaves a `*.tmp`
  sibling. These are never read (reads target canonical paths only) and are inert;
  optional best-effort cleanup can be deferred. `listPendingTransactions`
  (`file-storage.ts:69-82`) and `FileKVStore.list` filter on `.endsWith('.json')`,
  so `.tmp` files are already skipped by directory scans — verify this still holds
  for your chosen suffix (end the temp name with `.tmp`, not `.json`).

## Test harness caveat (coordinate with eh-7)

This package has **no test setup today** — no `test/` dir, no `mocha` devDep, no
`register.mjs`, no `test` script (`package.json` scripts are only `clean`/`build`).
The sibling `db-p2p` package runs specs via
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"`
with a two-line `register.mjs` (`register('ts-node/esm', import.meta.url)`) and
`mocha` + `ts-node` devDeps. `@types/mocha` is already present here.

The broader "fs adapter untested / no README / out-of-CI" gap is owned by the
Engineering-health ticket **`eh-7`** — do **not** take on full CI wiring or README
here. But this fix must ship with a reproducing test, so bootstrap the *minimal*
harness needed to run one spec (mirror `db-p2p`'s `register.mjs` + `test` script +
add `mocha`/`ts-node` devDeps). Flag the small overlap with `eh-7` in the review
handoff so it isn't done twice.

## Reproduction (turn into the spec)

- **Torn write is unreadable-forever → recoverable after fix.** Write a truncated /
  invalid-JSON `meta.json` directly to a block's metadata path, then assert
  `getMetadata` returns `undefined` (not throws) and that a `StorageRepo`/
  `block-storage` `recover()` over that block does not throw. (Pre-fix this throws
  a `SyntaxError` indefinitely.)
- **Completed write never observable torn.** Assert the atomic writer never leaves
  the canonical target path holding non-parseable JSON — e.g. spy/stub so a crash
  is injected between the temp write and the rename, then assert the canonical path
  either does not exist or parses cleanly to the *old* value (never partial).
- **KV store parity.** Same atomicity assertion for `FileKVStore.set`.

## TODO

- [ ] Add `src/atomic-write.ts` with `atomicWriteFile(filePath, content)`:
      `mkdir` parent → open unique `*.tmp` → write → `fsync` fd → close → `rename`
      → best-effort directory `fsync` (guarded for win32) → cleanup temp on failure.
- [ ] Replace `FileRawStorage.ensureAndWriteFile` body (`file-storage.ts:251-254`)
      to delegate to `atomicWriteFile`.
- [ ] Replace `FileKVStore.set` body (`file-kv-store.ts:18-22`) to delegate to
      `atomicWriteFile`.
- [ ] In `readIfExists` (`file-storage.ts:242-249`): return `undefined` + warn-log
      on `SyntaxError` (corrupt-recoverable); keep `ENOENT` → `undefined`; rethrow
      other errors.
- [ ] Bootstrap minimal test harness in this package (copy `register.mjs`, add
      `test` script + `mocha`/`ts-node` devDeps; `@types/mocha` already present).
      Keep it minimal — full CI/README is `eh-7`.
- [ ] Add `test/file-storage.spec.ts` covering the three reproduction cases above.
- [ ] Run `yarn build` (tsc) and the new test in this package; stream output with
      `tee`. Ensure both pass.
- [ ] Review handoff: note the atomic-write helper is shared by both classes, that
      pre-existing on-disk corrupt files now read as "missing" (recover treats them
      as absent — acceptable per ticket), and the minor test-harness overlap with
      `eh-7`.
