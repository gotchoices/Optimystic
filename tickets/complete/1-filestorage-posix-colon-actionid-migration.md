description: Older Linux/Mac nodes saved data files named with a colon; this added a read fallback so those files stay readable after the Windows-compatibility rename. Implementation reviewed and verified on a real Linux filesystem.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: medium
----

## What shipped

A lazy, POSIX-only read fallback in `FileRawStorage`
(`packages/db-p2p-storage-fs/src/file-storage.ts`). Action-id-keyed reads
(`getTransaction`, `getMaterializedBlock`, `getPendingTransaction`) now compute
the canonical percent-encoded path first (`actions/tx%3A<hash>.json`) and, on a
miss, fall back to the legacy raw-colon path written by pre-encode nodes
(`actions/tx:<hash>.json`). The fallback is skipped on win32 (a raw colon is an
NTFS alternate-data-stream separator and cannot have been written there) and is
short-circuited when the id has no colon (`rawPath === encodedPath`). All fallback
errors are swallowed → `undefined`, so the fallback can never surface a new throw;
the canonical path still routes through `readIfExists`, which rethrows non-ENOENT.

Writes, promotion (`promotePendingTransaction`), and deletes are untouched — new
writes always use the encoded name; only reads consult legacy files, in place,
without renaming (mixed naming on disk is the accepted pre-1.0 tradeoff).

Tests: a new POSIX-gated `describe` block in
`packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts`
covers the three legacy reads, an absent-id negative, and encoded-wins-over-stale.

## Review findings

### Verification performed

- **Read the implement diff (77bd2a5) first**, then the handoff. Re-read the full
  `file-storage.ts` and the spec.
- **Typecheck**: `quereus-plugin-optimystic` `yarn typecheck` → exit 0.
- **Build**: `db-p2p-storage-fs` `yarn build` (full `tsc`) → clean.
- **Tests on Windows** (this dev box): `file-raw-storage-actionid.spec.ts` +
  `local-transactor-storage.spec.ts` + `session-mode-commit.spec.ts` →
  **15 passing, 5 pending** (the 5 POSIX-gated cases correctly skip on win32).
- **Tests on real POSIX** (the property the source ticket flagged as *not*
  demonstrated on the win32 box): installed Node 22 in WSL/Ubuntu and ran the
  spec against `os.tmpdir()` on **ext4**, where a file literally named
  `tx:<hash>.json` is legal.
  - **Green-after**: full spec **9 passing** (4 existing + 5 formerly-pending),
    including the three legacy raw-colon reads, the absent-id negative, and
    encoded-wins.
  - **Red-before**: with the fallback branch neutralized, the three legacy-read
    cases **fail** (`expected undefined to deeply equal …`) while the absent and
    encoded-wins cases still pass — exactly the red/green property the ticket
    asked to confirm. dist restored afterward; working tree clean.

### Correctness / completeness checks

- **Complete set of readers**: confirmed the three getters are the *only* readers
  keyed by an action-id *filename*. `listPendingTransactions` already handles
  legacy raw names (`decodeFilenameToActionId` leaves an existing colon as a colon,
  and the recognition regex accepts `tx:`/`stamp:` base64url ids). `getRevision`
  keys on a rev-*number* filename and stores the actionId as JSON *content*, so it
  has no colon-in-filename concern. No reader was missed.
- **win32 guard + all-errors-swallowed**: confirmed the fallback cannot introduce
  a new throw nor a non-ENOENT regression on the canonical path (canonical read is
  unchanged `readIfExists`; only the legacy best-effort read swallows everything,
  intentionally treating a corrupt/locked legacy file as "missing").
- **`rawPath === encodedPath` short-circuit**: correct — colon-free ids (legacy
  UUIDs) skip the extra read entirely, sparing the hot path.

### Findings and disposition

- **MAJOR → filed `backlog/filestorage-legacy-rawcolon-delete-resurrection`.**
  Delete/unlink is asymmetric with the new read fallback: `deletePendingTransaction`
  and `saveMaterializedBlock(undefined)` unlink only the *encoded* filename, so a
  legacy raw-colon file would survive a delete and then be **resurrected** by the
  read fallback. This is **latent, not active**: a repo-wide search found no
  production caller of `deletePendingTransaction` and no production
  `saveMaterializedBlock(undefined)` call (the only live materialize caller always
  passes a real block). It becomes a real bug only when a delete path goes live
  against a migrated raw-colon store. Filed to backlog (pre-1.0, no current
  trigger, and it touches the write/delete paths this ticket deliberately kept
  clear) rather than expanding this diff.

- **MINOR (noted, not changed) — coverage gaps.** No test exercises the
  swallow-on-corrupt-legacy-JSON branch (`.catch(() => undefined)`) or asserts the
  win32 guard returns `undefined`. The win32 guard is implicitly exercised by the
  4 non-gated tests passing on this win32 box; the corrupt-JSON branch is a one-
  line best-effort catch. Left as-is — marginal value, and the core behavior
  (read, absent, encoded-wins, red/green) is now demonstrated on real POSIX.

- **TRIVIAL (noted, not changed).** Each getter computes its path helper twice
  (encoded + raw). Two `path.join`/`replace` calls per read — negligible; not worth
  obscuring the call sites to memoize.

### Empty categories (explicitly)

- **No security findings**: change is local file I/O over already-trusted on-disk
  paths; no new input, no traversal surface (filenames derive from existing branded
  action ids, unchanged from before).
- **No type-safety findings**: `encoded = true` default preserves every existing
  caller's signature; the `encoded = false` branch uses the branded `ActionId`
  directly as a filename segment, same as the prior code did for the encoded form.
- **No regressions**: the pre-existing 4 encoding tests and the two regression
  specs (`local-transactor-storage`, `session-mode-commit`) all pass unchanged.

## Out of scope (carried forward, unchanged)

- **Pend promotion of legacy raw files** — `promotePendingTransaction` renames the
  encoded pend path only; legacy raw pend files are covered by the
  `getPendingTransaction` read fallback (pend is crash-recovery-only). Left as-is
  per the source ticket.
- **On-disk normalization / migration sweep** — none; raw files read in place,
  mixed naming persists. Acceptable pre-1.0.
