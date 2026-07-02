description: Make delete operations in FileRawStorage also remove legacy raw-colon files on POSIX, so a deleted item cannot reappear by falling back to a stale pre-encode filename.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: easy
----

## Background

`FileRawStorage` in `packages/db-p2p-storage-fs/src/file-storage.ts` supports a
read fallback on POSIX: if the canonical percent-encoded file
(`actions/tx%3A<hash>.json`) is missing, it retries with the legacy raw-colon
name (`actions/tx:<hash>.json`) that pre-encode nodes wrote.  This is
implemented in `readActionScopedFile` (line 220).

The delete paths were intentionally left as encoded-only:

- `deletePendingTransaction` (line 60) — `fs.unlink(getPendingActionPath(...))`
  (encoded only)
- `saveMaterializedBlock` tombstone branch (line 120) — `fs.unlink(getMaterializedPath(...))`
  (encoded only)

On a POSIX store upgraded from a pre-encode node the value may exist **only**
under the raw-colon name.  Deleting it removes the encoded file (ENOENT,
silently swallowed) while the raw-colon file survives; a subsequent `get*` call
falls back to that file and resurrects the deleted value.

## Fix

After the encoded unlink in each delete path, add a best-effort unlink of the
raw-colon path, guarded by:

1. `process.platform !== 'win32'` — raw-colon files can never exist on Windows
   (`:` is the NTFS ADS separator; writes there throw), so the extra unlink is
   pointless and potentially dangerous.
2. `rawPath !== encodedPath` — the paths are identical when the action id
   contains no colon (UUID format); no second syscall needed.

ENOENT on the raw-colon unlink is silently ignored (file was already absent);
any other error is logged but not re-thrown, matching the existing encoded-unlink
error handling.

A private helper `unlinkRawColon` keeps the pattern DRY across both call sites.

## Tests

Add a POSIX-gated block to
`packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts`
inside (or adjacent to) the existing
`FileRawStorage legacy raw-colon read fallback (POSIX-only)` suite.  Reuse the
existing `writeRawColonFile` helper.

Two new tests:

- **deletePendingTransaction removes legacy raw-colon pend file**
  1. `writeRawColonFile('pend', TX_ACTION_ID, transform)` — places a raw-colon
     pending file on disk, bypassing the API.
  2. `storage.deletePendingTransaction(BLOCK_ID, TX_ACTION_ID)` — must silently
     succeed (no encoded file exists → ENOENT on encoded unlink swallowed; then
     raw-colon unlink removes the file).
  3. Assert `storage.getPendingTransaction(BLOCK_ID, TX_ACTION_ID)` returns
     `undefined` (no resurrection).

- **saveMaterializedBlock tombstone removes legacy raw-colon blocks file**
  1. `writeRawColonFile('blocks', STAMP_ACTION_ID, block)` — raw-colon block on
     disk.
  2. `storage.saveMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID, undefined)` —
     tombstone call.
  3. Assert `storage.getMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID)` returns
     `undefined`.

## TODO

- Add `private async unlinkRawColon(encodedPath: string, rawPath: string): Promise<void>` to `FileRawStorage`:
  - Guard: `process.platform === 'win32' || rawPath === encodedPath` → return immediately
  - `await fs.unlink(rawPath).catch(err => { if (err?.code !== 'ENOENT') log(...) })`
- In `deletePendingTransaction`: after the existing `fs.unlink(pendingPath)` call, call `this.unlinkRawColon(pendingPath, this.getPendingActionPath(blockId, actionId, false))`
- In `saveMaterializedBlock` tombstone branch (`else`): after the existing `fs.unlink(this.getMaterializedPath(...))` call, call `this.unlinkRawColon(this.getMaterializedPath(blockId, actionId), this.getMaterializedPath(blockId, actionId, false))`
- Add the two POSIX-gated tests described above to the spec file
- Run `yarn test` (or the package-level test command) and confirm all tests pass, including the new ones on POSIX (they will be skipped on Windows)
