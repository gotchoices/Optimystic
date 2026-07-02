description: Review delete-path fix that prevents legacy raw-colon files from resurrecting after deletion in FileRawStorage on POSIX.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: easy
----

## What was implemented

`FileRawStorage` on POSIX had a read fallback (`readActionScopedFile`) that retried a miss on the canonical percent-encoded path (`actions/tx%3A<hash>.json`) by falling back to the legacy raw-colon path (`actions/tx:<hash>.json`). The delete paths only unlinked the encoded file, so if the value existed only under the raw-colon name the delete silently missed it and a subsequent read resurrected the value.

### Changes

**`packages/db-p2p-storage-fs/src/file-storage.ts`**

- Added private `unlinkRawColon(encodedPath, rawPath)` helper:
  - Returns immediately on `win32` (raw-colon files can never exist there) or when the paths are identical (no colon in the action id).
  - Calls `fs.unlink(rawPath)`, silently ignoring `ENOENT`, logging (but not re-throwing) any other error.
- `deletePendingTransaction`: after the existing encoded `fs.unlink`, calls `this.unlinkRawColon(pendingPath, this.getPendingActionPath(blockId, actionId, false))`.
- `saveMaterializedBlock` tombstone branch (`block === undefined`): after the existing encoded `fs.unlink`, calls `this.unlinkRawColon(this.getMaterializedPath(...), this.getMaterializedPath(blockId, actionId, false))`.

**`packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts`**

Added two tests inside the POSIX-gated `FileRawStorage legacy raw-colon read fallback (POSIX-only)` suite (skipped on win32):

- `deletePendingTransaction removes legacy raw-colon pend file` — writes a raw-colon pend file, deletes via API, asserts `getPendingTransaction` returns `undefined`.
- `saveMaterializedBlock tombstone removes legacy raw-colon blocks file` — writes a raw-colon blocks file, tombstones via API, asserts `getMaterializedBlock` returns `undefined`.

## Test results

255 passing, 11 pending (the 11 pending are POSIX-only tests skipped on Windows — this run was on Windows, so that's correct). Zero failures.

## Use cases for validation

1. **POSIX only — no regression on Windows**: run suite on a Linux/macOS machine; the two new tests should turn from pending to passing.
2. **Resurrection bug fixed**: a raw-colon pend file must not reappear after `deletePendingTransaction`.
3. **Tombstone resurrection bug fixed**: a raw-colon blocks file must not reappear after a `saveMaterializedBlock(id, undefined)` tombstone call.
4. **Win32 guard is harmless**: on Windows the extra unlink is skipped entirely — verified by guard `process.platform === 'win32'`.
5. **ENOENT tolerance**: if the raw-colon file was already absent, no error is thrown or logged.

## Known gaps / tripwires

- The `getTransaction` read path (and `promotePendingTransaction`) have no delete counterpart, so no raw-colon cleanup was needed or added there.
- No cleanup is added for the `actions/` (committed transaction) directory because `FileRawStorage` has no public delete API for committed transactions; if one is added in the future it should follow the same `unlinkRawColon` pattern.
- A tripwire `NOTE:` comment was not added here because the raw-colon fallback comment block in `readActionScopedFile` (line ~218) already documents the mixed-naming tradeoff and mentions a future migration sweep.

## Review findings

- No surprises. The two new tests cover both delete paths that were missing raw-colon cleanup.
- Pre-existing TS LSP diagnostics (`Cannot find name 'process'`, `Cannot find namespace 'NodeJS'`, etc.) are a tsconfig/types issue unrelated to this ticket; they existed before this change and appear on lines that were not touched.
