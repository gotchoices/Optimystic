description: Older Linux/Mac nodes saved data files named with a colon; this adds a read fallback so those files stay readable after the Windows-compatibility rename. Review the fallback and its tests.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: medium
----

## What shipped

A **lazy, POSIX-only read fallback** in `FileRawStorage`
(`packages/db-p2p-storage-fs/src/file-storage.ts`) so that action-id-keyed files
written by pre-encode nodes with a **raw colon** in the filename
(`actions/tx:<hash>.json`, `blocks/stamp:<hash>.json`, `pend/tx:<hash>.json`)
remain readable after the Windows-compat encode fix started computing the
**encoded** path (`actions/tx%3A<hash>.json`).

### Changes

- **Path helpers factored** (`getPendingActionPath`, `getActionPath`,
  `getMaterializedPath`) — each now takes an `encoded = true` 3rd arg.
  `encoded = false` yields the raw-colon filename (`${actionId}.json`). Default
  `true` preserves all existing callers verbatim (writes + canonical reads).
- **New private helper `readActionScopedFile<T>(encodedPath, rawPath)`**
  (just above `readIfExists`): reads the encoded path first via `readIfExists`
  (unchanged: rethrows non-ENOENT on the canonical path). On a miss it returns
  `undefined` if `process.platform === 'win32'` **or** `rawPath === encodedPath`
  (no colon → encoded === raw, nothing to fall back to); otherwise it does a
  best-effort `fs.readFile(rawPath)` + `JSON.parse`, **swallowing all errors →
  `undefined`** so the fallback can never surface a new throw to callers.
- **Three getters routed through it**: `getTransaction`, `getMaterializedBlock`,
  `getPendingTransaction`. All other read paths and **all** write/promote paths
  (`saveTransaction`, `saveMaterializedBlock`, `savePendingTransaction`,
  `promotePendingTransaction`) are untouched — new writes always use the encoded
  name; we only *read* legacy files.
- A code comment documents the mixed-naming tradeoff (legacy files are read in
  place, never renamed) and the win32-guard rationale (a raw-colon path on NTFS
  is an alternate-data-stream separator, so a read can throw a non-ENOENT error
  rather than cleanly missing; raw-colon files cannot exist on win32 anyway, so
  skipping there loses nothing).

### Tests

`packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts` —
new describe block **`FileRawStorage legacy raw-colon read fallback (POSIX-only)`**,
gated `before(function(){ if (process.platform === 'win32') this.skip() })`:

- `getTransaction` reads a legacy `actions/tx:<hash>.json` (written directly to
  disk with `fs.writeFile`, bypassing the API).
- `getMaterializedBlock` reads a legacy `blocks/stamp:<hash>.json`.
- `getPendingTransaction` reads a legacy `pend/tx:<hash>.json`.
- Negative: a genuinely-absent id returns `undefined` for all three getters
  (fallback must not invent data).
- Encoded-wins: when both an encoded (API-written) and a stale raw-colon file
  exist, the encoded value is returned.

Reuses the existing `TX_ACTION_ID` / `STAMP_ACTION_ID` / `BLOCK_ID` constants and
`makeTransform` helper.

## Validation performed (and what was NOT run here)

Run from `packages/db-p2p-storage-fs` and `packages/quereus-plugin-optimystic`:

- `yarn build` in `db-p2p-storage-fs` (full `tsc`) → **clean**, dist contains the
  new helper.
- `yarn typecheck` in `quereus-plugin-optimystic` → **exit 0**.
- `file-raw-storage-actionid.spec.ts` → **4 existing pass, 5 new pending**.
- Regression guard: `local-transactor-storage.spec.ts` + `session-mode-commit.spec.ts`
  → **11 passing**.

### ⚠️ Honesty flag — the 5 new tests did NOT execute on this dev box (win32)

This machine is **win32**, so the entire POSIX-gated block was **skipped** (shown
as "pending" above). The red-before / green-after property the ticket asks for
(tests fail without the fallback, pass with it) was therefore **not demonstrated
in a normal test run here**. **A POSIX CI runner must actually execute these to
confirm.** Reviewer: please run this spec on Linux/macOS (or confirm CI does) and
verify the 5 cases run and pass — and ideally that they fail if the fallback is
reverted.

To gain *some* confidence on win32, a throwaway probe script (not committed)
forced the POSIX branch via `Object.defineProperty(process, 'platform', {value:
'linux'})` and exercised `getTransaction` against a raw-colon path: it returned
the stored transform (`MATCH = true`) and `undefined` for an absent id. Caveat:
on win32 NTFS the "raw-colon file" is actually written as an alternate-data-stream
(`readdir` showed just `tx`), so the probe validated the helper's **branching /
read / JSON-parse / absent→undefined logic**, *not* the real POSIX on-disk layout
(a discrete file literally named `tx:<hash>.json`). That on-disk-layout assertion
is exactly what the skipped tests cover and must be confirmed on POSIX.

## Deliberately out of scope (per source ticket — do not treat as gaps to fix)

- **Pend promotion of legacy raw files.** `promotePendingTransaction` renames the
  *encoded* pend path → encoded actions path; a legacy raw-colon pend file would
  not be promoted by it. Left as-is: pend is crash-recovery-only and stale after
  a clean restart, so the read fallback on `getPendingTransaction` is sufficient.
- **On-disk normalization (a migration sweep).** No startup sweep / rename; raw
  files are read in place, leaving mixed naming on disk. Acceptable pre-1.0; a
  future sweep can normalize. Reads were kept strictly side-effect-free (no
  migrate-on-read).

## Suggested review focus

- Confirm the win32 guard + all-errors-swallowed fallback genuinely cannot
  surface a new throw or a non-ENOENT regression on the canonical (encoded) path
  (`readIfExists` still rethrows non-ENOENT — intended).
- Confirm `rawPath === encodedPath` short-circuit correctly spares the
  legacy-UUID / colon-free hot path from any extra stat/read.
- Run the POSIX-gated spec on a non-win32 host and verify red-before/green-after.
- Sanity-check that no other reader of action-id-keyed files exists that should
  also get the fallback (the three getters are believed to be the complete set).
