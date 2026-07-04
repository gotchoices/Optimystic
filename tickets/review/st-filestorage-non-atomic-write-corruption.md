description: The on-disk storage backend now writes files atomically (temp file + rename + fsync) instead of overwriting in place, and reads treat a crash-damaged file as "missing" instead of throwing forever — so one crash mid-write can no longer permanently wedge a block.
prereq:
files: packages/db-p2p-storage-fs/src/atomic-write.ts (new), packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts (new), packages/db-p2p-storage-fs/register.mjs (new), packages/db-p2p-storage-fs/.mocharc.json (new), packages/db-p2p-storage-fs/package.json, packages/db-p2p/src/storage/block-storage.ts (recover(), unchanged — reads metadata first)
difficulty: medium
----

# Review: atomic filesystem writes + corruption-tolerant reads

## What shipped

The Node filesystem storage adapter used to overwrite files in place with a plain
`fs.writeFile` (truncate-then-write, no fsync). A crash mid-write left a torn file,
and reads **rethrew the `JSON.parse` `SyntaxError` forever**, so one ill-timed crash
turned committed data into a permanently-throwing block (`recover()` reads metadata
first with no catch, so it couldn't even recover). Fixed on both fronts:

- **New `src/atomic-write.ts`** — `atomicWriteFile(filePath, content)`:
  `mkdir` parent → open a unique `<name>.<pid>.<counter>.tmp` sibling → `writeFile`
  → `handle.sync()` (fsync data) → `close` → `fs.rename` into place → best-effort
  parent-directory fsync (guarded; swallowed on win32). On any failure it closes the
  handle and `unlink`s the temp file, then rethrows. A reader only ever sees the
  complete old file or the complete new file — never a torn one.
- **`FileRawStorage.ensureAndWriteFile`** (covers `saveMetadata`, `saveRevision`,
  `savePendingTransaction`, `saveTransaction`, `saveMaterializedBlock`) now delegates
  to `atomicWriteFile`.
- **`FileKVStore.set`** now delegates to `atomicWriteFile` too (same helper, one impl).
- **`FileRawStorage.readIfExists`** now maps a `SyntaxError` (corrupt-but-present →
  torn write) to `undefined` with a warn-log, keeps `ENOENT → undefined`, and still
  **rethrows real I/O errors** (anything with a non-ENOENT `code`, e.g. `EISDIR`,
  `EACCES`, `EIO`). This flows to `getMetadata`, `getRevision`, `getTransaction`,
  `getPendingTransaction`, `getMaterializedBlock`, and `recover()`.
- **Test harness bootstrapped** (minimal): `register.mjs`, `.mocharc.json`, a `test`
  script, and `mocha`/`ts-node` devDeps — mirrors sibling `db-p2p`.

`block-storage.ts` was **not** modified; its `recover()` benefits purely because
`getMetadata` no longer throws on a torn `meta.json`.

## Validation done

- `yarn build` (tsc) — clean, exit 0. tsconfig includes `test/`, so the spec is
  type-checked by the build too.
- `yarn test` — **7 passing** (`packages/db-p2p-storage-fs`). Covers:
  - torn/truncated `meta.json` → `getMetadata` returns `undefined` (not throws);
  - `BlockStorage.recover()` over a corrupt-meta block → `{ reconciled: false }`, no throw;
  - a genuine I/O error (metadata path is a directory → `EISDIR`) still **propagates**
    from a read (guards against the "swallow everything" over-correction);
  - `saveMetadata` round-trips and leaves no `*.tmp` sibling;
  - injected rename failure (crash between temp-write and rename) → canonical path
    still holds the complete **old** value, parses cleanly, temp cleaned up;
  - `FileKVStore.set` parity: round-trip + no-temp; injected rename failure keeps the
    prior value intact.

The atomicity tests inject the "crash" by overriding `fs.promises.rename` to throw
(the adapter and the test share the one `fs.promises` singleton). Verified the
property is writable and the override reaches `atomic-write.ts`.

## Reviewer: known gaps / where to look

Treat the tests as a floor. Specific things worth an adversarial eye:

- **Durability is asserted by construction, not by a real power-loss test.** A unit
  test can't kill the process between fsync and rename. The tests prove the
  *observable atomicity* of the state machine (rename-or-nothing) and that fsync
  calls are in the code path; they do **not** prove bytes survive a real power cut.
  If you want more confidence, that's an OS-level / fault-injection test — out of
  scope for this ticket.
- **Concurrency unchanged.** The adapter still does not lock (the `proper-lockfile`
  TODO at `file-storage.ts:21` remains). Two concurrent writers to the same canonical
  path now each write a *distinct* temp (pid+counter) and both rename — so there is no
  torn file, but it is still **last-writer-wins** on content. This fix does not make
  concurrency worse; it does not solve it either.
- **Pre-existing on-disk corrupt files now read as "missing."** By design: `recover()`
  and normal reads treat a damaged file as absent and make progress rather than
  wedging. For `meta.json` that means a block with only-corrupt metadata reads as
  empty. Acceptable per the ticket, but confirm this matches the intended recovery
  contract for your scenario (a torn `meta.json` with intact revs/actions will read as
  "no block" until something rewrites metadata).
- **`SyntaxError`-based detection.** Corruption is distinguished from I/O error via
  `err instanceof SyntaxError` (JSON.parse's error, which carries no `code`). If a
  future change wraps `JSON.parse` or swaps the parser, that predicate needs revisiting.
- **`readActionScopedFile` raw-colon fallback** was left as-is: its `.catch(() =>
  undefined)` already swallows all errors, so it inherits the new behavior for free.
  Double-check that's still the intent (it silently masks I/O errors on the legacy
  raw-colon path, which predates this ticket).

## Tripwire recorded (not a ticket)

- **Orphaned `*.tmp` files after a crash between open and rename.** These are inert —
  never read (reads target canonical paths) and skipped by `.json` directory scans
  (`listPendingTransactions`, `FileKVStore.list`). No cleanup sweep was added. Parked
  as a `NOTE:` in `src/atomic-write.ts` at the temp-name site. If a store ever
  accumulates many temps (crash-looping writer), a startup sweep of `*.tmp` could be
  added — conditional, not needed now.

## Overlap with `eh-7` (flagged per ticket)

This ticket bootstrapped the **minimal** test harness for `db-p2p-storage-fs`
(`register.mjs`, `.mocharc.json`, `test` script, `mocha`/`ts-node` devDeps) so the
fix could ship with a reproducing spec. The broader "fs adapter untested / no README /
not in CI" work is owned by **`eh-7`** — do not redo the harness there; `eh-7` should
build on it (README, CI wiring, wider coverage). `@types/mocha` was already present.

Note: under the Node 25 in this environment, native type-stripping runs the `.spec.ts`
(you'll see an "ExperimentalWarning: Type Stripping" line); `ts-node/esm` from
`register.mjs` is the fallback for older Node. Tests pass either way. If `eh-7`
standardizes on one, harmonize then.
