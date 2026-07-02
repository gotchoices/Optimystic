description: Delete operations in FileRawStorage now also remove legacy raw-colon files on POSIX, so a deleted item can no longer reappear by falling back to a stale pre-encode filename.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: easy
----

## Summary

`FileRawStorage` percent-encodes the colon in consensus action ids
(`tx:<hash>` → `tx%3A<hash>`) so filenames are legal on Windows. On POSIX,
pre-encode nodes had written those files with the raw colon
(`actions/tx:<hash>.json`), and a read fallback in `readActionScopedFile`
retries a miss on the encoded path against that raw-colon path.

The bug: the two delete paths only unlinked the *encoded* file. If a value
existed under the raw-colon name, the delete silently missed it and a later
read resurrected it via the fallback.

The fix adds a private `unlinkRawColon(encodedPath, rawPath)` helper called
after the encoded unlink in both delete sites:

- `deletePendingTransaction`
- `saveMaterializedBlock` tombstone branch (`block === undefined`)

The helper short-circuits on win32 (raw-colon files can't exist there) and when
the encoded and raw paths are identical (action id has no colon), and silently
tolerates `ENOENT`, logging any other error without re-throwing — matching the
existing encoded-unlink error handling.

## Review findings

**Scope checked:** the implement diff (`ddd4b2c`) with fresh eyes, the full
`file-storage.ts`, the spec file, all four `fs.unlink`/`fs.rename` sites in the
storage class, DRY/error-handling/type-safety/resource-cleanup aspects, and a
runtime end-to-end validation of the real production code path.

**Correctness — confirmed.** Both delete sites (`file-storage.ts:66`,
`file-storage.ts:125`) are covered; there are exactly two `fs.unlink` sites and
one `fs.rename` (`promotePendingTransaction`, which moves rather than deletes and
correctly needs no raw-colon cleanup). The helper's two guards and ENOENT
tolerance are correct and mirror existing conventions.

**Runtime validation beyond the implementer's tests.** The new tests are
POSIX-gated and skip on Windows — and, more importantly, the production
`unlinkRawColon` itself short-circuits on win32, so *no* Windows run can exercise
the fix. I therefore ran a throwaway script that forced `process.platform =
'linux'` and drove the compiled source directly. All scenarios passed:
raw-colon-only delete (pend + tombstone), **both encoded and raw-colon present**,
delete on absent files (no throw), and UUID (no-colon) ids. The script was
removed after use.

**Minor finding — fixed inline (test coverage).** The implementer's two tests
only covered the *raw-colon-only* case. The realistic upgrade state is *both* an
encoded file (new node) and a lingering raw-colon file (old node) — also a
resurrection path, since deleting the encoded file alone lets the read fallback
resurrect the raw-colon value. Added a durable POSIX-gated regression test
`deletePendingTransaction removes BOTH encoded and legacy raw-colon pend files`.
Spec now loads cleanly (8 pending on Windows, was 7).

**Tripwire (recorded, not ticketed).** No cleanup exists for the `actions/`
(committed transaction) directory because `FileRawStorage` exposes no public
delete API for committed transactions. If such an API is ever added it must apply
the same `unlinkRawColon` pattern. This is genuinely conditional (fine until that
API exists) — parked here in findings and already implied by the existing
raw-colon comment block in `readActionScopedFile`; no code site to tag until the
API lands, so no `NOTE:` comment was added.

**Docs.** No docs reference these delete paths or the encoding scheme; the
behavior is documented in-code via the comment blocks on `unlinkRawColon` and
`readActionScopedFile`, which now reflect reality. Nothing to update.

**Lint.** The repo `lint` script is a no-op echo (`"Lint not configured for all
packages"`) — nothing to run.

**Pre-existing failure flagged (not mine).** `npx tsc` fails repo-wide with
`TS5101` on the deprecated `downlevelIteration` option in `tsconfig.json` (exit
2). `tsconfig.json` is untouched by this diff and there are zero type errors
against `file-storage.ts`; it is a TypeScript-version deprecation affecting the
whole monorepo. Recorded in `tickets/.pre-existing-error.md` for the triage pass.
The package test runner uses type-stripping (not full `tsc`), so the suite is
unaffected.

## Test results

- `packages/quereus-plugin-optimystic`: `npm test` → **255 passing, 11 pending**
  (POSIX-only tests skipped on this Windows run), zero failures.
- Targeted forced-POSIX runtime validation of the real delete code path: 5/5
  checks passed (see above).

## Known gaps carried forward

- `getTransaction` / `promotePendingTransaction` have no delete counterpart, so
  no raw-colon cleanup is needed there.
- POSIX-only tests cannot turn green on the Windows CI/dev box; they must be run
  on Linux/macOS to observe them passing. The forced-POSIX runtime check above
  substitutes for that on Windows.
