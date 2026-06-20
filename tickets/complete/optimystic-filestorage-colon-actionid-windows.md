description: Encode colons in action IDs when used as filenames in FileRawStorage so consensus commit works on Windows, and unskip the on-disk reopen durability test on all platforms.
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: easy
----

## What was done (implementation, carried from review)

`FileRawStorage` now percent-encodes the colon in action ids so `tx:<hash>` /
`stamp:<hash>` are legal Windows filenames:

- Two module helpers `encodeActionIdForFilename` / `decodeFilenameToActionId`.
- `getPendingActionPath`, `getActionPath`, `getMaterializedPath` encode on write.
- `listPendingTransactions` decodes filenames and filters via a regex that
  accepts both legacy UUID and consensus `tx:`/`stamp:` ids.
- The on-disk session-mode reopen durability test was unskipped on win32.

## Review findings

### What was checked
- The actual code diff (landed in `0bcc933`, not the implement commit which only
  moved ticket files) read before the handoff summary.
- Action-id generation (`db-core` `createTransactionStamp` / `createTransactionId`
  → `hashString`) to determine the real character set of the hash.
- Every `listPendingTransactions` consumer (`storage-repo.ts` `get` + `pend`) and
  every sibling storage backend's contract (memory / indexeddb / leveldb /
  sqlite) for consistency.
- encode/decode inverse safety; `getMaterializedPath` caller symmetry.
- Docs/comments in the touched test file vs. the new reality.
- Lint/typecheck + full package test suite.

### Findings and disposition

**MAJOR — regex rejected real consensus ids (fixed inline).** The implemented
filter branch was `(?:tx|stamp):[0-9a-f]+` — lowercase hex only. But
`db-core/hashString` returns **base64url**-encoded SHA-256 (alphabet
`[A-Za-z0-9_-]`, see `packages/db-core/src/utility/hash-string.ts`), so real ids
look like `tx:Ab3_xZ9-...`. The hex-only class silently dropped essentially every
real `tx:`/`stamp:` pending file from `listPendingTransactions`, which
`storage-repo.ts` uses for pending-state reporting (`get`) and conflict detection
(`pend`) on the FileRawStorage consensus path — on **all** platforms, not just
Windows. The integration reopen test missed it because a *clean* commit promotes
pend→actions, leaving the pend dir empty, so the regex was never asked to match a
real id. Fixed the class to base64url (`[A-Za-z0-9_-]+`) and added direct
coverage.

**MAJOR — POSIX data-at-rest read regression (new backlog ticket filed).**
Pre-fix the write path stored raw colons with no platform guard, so existing
POSIX nodes have durable `actions/tx:<hash>.json` and `blocks/stamp:<hash>.json`
files. After the fix the read helpers compute the *encoded* path and miss them
(silent `undefined` against committed data). Filed
`tickets/backlog/filestorage-posix-colon-actionid-migration.md` (read-fallback vs.
migration sweep vs. documented break). Not blocking: pre-1.0, the FS-consensus
path was non-functional on Windows and lightly used elsewhere, so the affected
population is likely nil today.

**MINOR — missing direct unit coverage (fixed inline).** The package
`db-p2p-storage-fs` has no test harness of its own. Added
`packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts`
(which already builds against the FileRawStorage dist) covering: colon-bearing
`tx:` pend save/get/list, pend→actions promotion (the original win32 EINVAL site),
multi-id list + delete with `tx:` and `stamp:`, and a `stamp:` materialized-block
round-trip. These tests fail under the old hex-only regex and pass after the fix.

**MINOR — stale doc comment (fixed inline).** The `session-mode-commit.spec.ts`
file header still described the on-disk reopen test as "skipped on win32"; updated
to reflect the shipped fix and all-platforms execution.

### Empty categories (explicit)
- **encode/decode inverse correctness — no issue.** base64url contains no `%`, so
  `%3A` in a filename can only originate from an encoded colon; decode is
  unambiguous, and there is no double-encode path (encode is applied once, on the
  full id). Verified by round-trip tests.
- **`getMaterializedPath` caller symmetry — no issue.** `saveMaterializedBlock`
  and `getMaterializedBlock` both route through the same encoded helper, so write
  and read agree; covered by a `stamp:` round-trip test.
- **Other storage backends — out of scope, no change needed.** memory / indexeddb
  / leveldb / sqlite key on the raw action id (not a filesystem name) and need no
  encoding; only `FileRawStorage` was affected.

## Verification

From `packages/quereus-plugin-optimystic`:
- `yarn typecheck` — clean (exit 0).
- New spec + session-mode spec: **12 passing**.
- Full suite `yarn test` (incl. 3-node mesh integration): **241 passing, 4 pending,
  exit 0**.
- `db-p2p-storage-fs` `yarn build` (full `tsc`) — clean.

## Follow-ups
- `filestorage-posix-colon-actionid-migration` (backlog) — cross-version on-disk
  compat for pre-fix raw-colon POSIX data.
