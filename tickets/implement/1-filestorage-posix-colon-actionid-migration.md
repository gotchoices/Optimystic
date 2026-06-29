description: Older Linux/Mac nodes saved data files named with a colon; after the recent Windows-compatibility rename they can no longer find that data on disk. Add a read fallback so the existing files stay readable after upgrade.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: medium
----

## Problem (confirmed by inspection)

`FileRawStorage` (`packages/db-p2p-storage-fs/src/file-storage.ts`) now
percent-encodes the colon in consensus action ids when building filenames
(`encodeActionIdForFilename`, lines 11–17; applied in `getPendingActionPath`,
`getActionPath`, `getMaterializedPath`, lines 177–187). The encode fix is correct
and shipped (`optimystic-filestorage-colon-actionid-windows`, now in
`complete/`).

Before that fix the **write** path stored the raw action id verbatim with no
platform guard. On POSIX the colon is a legal filename character, so any node that
ran the consensus path has durable on-disk files named with raw colons:

```
actions/tx:<hash>.json      ← committed transaction log
blocks/stamp:<hash>.json    ← materialized blocks
pend/tx:<hash>.json         ← in-flight / crash recovery (lower risk)
```

After upgrading, the read helpers compute the **encoded** path
(`actions/tx%3A<hash>.json`) and never find these files:

- `getTransaction` (line 80) → `getActionPath` (line 181) → `readIfExists`
  → `ENOENT` → `undefined`. **Silent read regression against committed data.**
- `getMaterializedBlock` (line 100) → `getMaterializedPath` (line 185) → same.
- `getPendingTransaction` (line 46) → `getPendingActionPath` (line 177) → same.
  Note `listPendingTransactions` (lines 65–78) *does* still surface a raw-colon
  pend file (its `decodeFilenameToActionId` is a no-op when there is no `%3A`, so
  the id decodes to `tx:<hash>` and passes the regex), but the follow-up
  `getPendingTransaction` then computes the encoded path and misses — so the
  fallback is needed on the read side regardless.

### Repro shape (turn into the test below)
Write a file directly to disk at the **raw** path
(`<dir>/<blockId>/actions/tx:<hash>.json`) bypassing the API, then call
`storage.getTransaction(blockId, 'tx:<hash>')`. Pre-fallback it returns
`undefined`; post-fallback it returns the stored transform. Same for
`blocks/` + `getMaterializedBlock`. (On win32 a raw-colon name cannot be created
on disk, so this branch only ever matters on POSIX — see guard below.)

## Decision: read fallback (lazy), POSIX-only

Of the three options in the source ticket (read fallback / one-time migration
sweep / documented breaking change), implement the **read fallback**:

- Cheapest and lowest risk. `FileRawStorage`'s constructor is synchronous and has
  no async `open()`; a migration sweep would need a new lifecycle hook and must be
  made idempotent + crash-safe (rename mid-scan). A read fallback needs none of
  that and writes nothing on startup.
- Lazy: the extra stat/read only happens on an encoded-path **miss** *and* only
  when the action id actually contains a colon (encoded name ≠ raw name), so the
  legacy-UUID path and the fresh-store hit path pay nothing.
- Satisfies acceptance: existing raw-colon `actions/`/`blocks/` files become
  readable again; fresh-store round-trip is unchanged.

Tradeoff (document in code comment): leaves mixed naming on disk — raw-colon files
are read in place, never renamed. That is acceptable pre-1.0; a future sweep can
normalize if desired. Do **not** add opportunistic migrate-on-read (write during a
read path) in this ticket — keep reads side-effect-free.

### Win32 guard — important
A raw-colon path like `actions/tx:<hash>.json` is not a benign ENOENT on Windows:
the colon is parsed as an NTFS alternate-data-stream separator, so a read there
can throw a non-ENOENT error (e.g. `EINVAL`/`ENOENT` variants) rather than cleanly
missing. Two safeguards:

1. Only attempt the raw fallback when `process.platform !== 'win32'` (raw-colon
   files cannot have been written on win32 anyway, so skipping loses nothing).
2. Make the fallback read swallow **all** errors → `undefined` (not just
   `ENOENT`), so a fallback attempt can never surface a new throw to callers.

Keep the existing `readIfExists` (line 189) behavior unchanged for the primary
encoded read (it still rethrows non-ENOENT, which is correct for the canonical
path).

## Suggested shape

Add a private helper that does the encoded-then-raw read for the three
action-id-keyed getters, e.g.:

```ts
// Returns the encoded-path value; on POSIX, falls back to the legacy raw-colon
// path written by pre-encode nodes (best-effort, never throws).
private async readActionScopedFile<T>(encodedPath: string, rawPath: string): Promise<T | undefined> {
  const hit = await this.readIfExists<T>(encodedPath);
  if (hit !== undefined) return hit;
  if (process.platform === 'win32' || rawPath === encodedPath) return undefined;
  return fs.readFile(rawPath, 'utf-8')
    .then(c => JSON.parse(c) as T)
    .catch(() => undefined);
}
```

To build `rawPath`, factor the path helpers so the raw (un-encoded) filename is
also reachable, e.g. give `getActionPath` / `getMaterializedPath` /
`getPendingActionPath` an internal `{ encoded?: boolean }` variant, or add
sibling `*RawPath` helpers. Then:

- `getTransaction` → `readActionScopedFile(getActionPath(encoded), getActionPath(raw))`
- `getMaterializedBlock` → same against `getMaterializedPath`
- `getPendingTransaction` → same against `getPendingActionPath`

Leave write paths (`saveTransaction`, `saveMaterializedBlock`,
`savePendingTransaction`, `promotePendingTransaction`) untouched — new writes
always use the encoded name; we only need to *read* legacy files.

`promotePendingTransaction` (line 149) renames the **encoded** pend path to the
encoded actions path. A legacy raw-colon pend file would not be promoted by it,
but pend is crash-recovery-only and stale after a clean restart (per source
ticket), so leave promote as-is and note it; do not expand scope to migrate pend
renames.

## Tests

Extend `packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts`
(the existing harness already builds against the `FileRawStorage` dist; the
`db-p2p-storage-fs` package has no test runner of its own). Add a describe block
that, **gated on `process.platform !== 'win32'`** (`before(function(){ if
(process.platform === 'win32') this.skip() })`):

- Writes a transform to disk at the legacy raw path
  `<dir>/<BLOCK_ID>/actions/tx:<hash>.json` (use `fs.mkdir`/`fs.writeFile`
  directly with the colon, mirroring the encode-free pre-fix layout), then asserts
  `storage.getTransaction(BLOCK_ID, TX_ACTION_ID)` deep-equals it.
- Same for `blocks/stamp:<hash>.json` via `getMaterializedBlock` + `STAMP_ACTION_ID`.
- (Optional) raw `pend/tx:<hash>.json` via `getPendingTransaction`.
- A negative/no-regression case: a genuinely-absent id still returns `undefined`
  (fallback must not invent data), and the existing fresh-store round-trip tests
  still pass unchanged.

Reuse the existing `TX_ACTION_ID` / `STAMP_ACTION_ID` / `BLOCK_ID` constants and
`makeTransform` helper in that file. The new tests must FAIL before the fallback
lands and PASS after.

## TODO

- [ ] Factor `getActionPath` / `getMaterializedPath` / `getPendingActionPath` so
      both the encoded and raw filename forms are reachable.
- [ ] Add `readActionScopedFile<T>` helper (encoded-first, POSIX-only raw
      fallback, swallows all fallback errors).
- [ ] Route `getTransaction`, `getMaterializedBlock`, `getPendingTransaction`
      through it. Leave all write/promote paths unchanged.
- [ ] Add a short code comment documenting the mixed-naming tradeoff and the
      win32 guard rationale.
- [ ] Extend `file-raw-storage-actionid.spec.ts` with POSIX-gated raw-colon
      read tests (actions + blocks, optional pend) plus the absent-id negative
      case.
- [ ] From `packages/quereus-plugin-optimystic`: `yarn typecheck`, run the spec,
      and `yarn build` in `packages/db-p2p-storage-fs` (full `tsc`). Stream output
      with `2>&1 | tee`.
- [ ] Handoff: note in the review ticket that pend-promotion of legacy raw files
      and on-disk normalization (a sweep) were deliberately left out of scope.
