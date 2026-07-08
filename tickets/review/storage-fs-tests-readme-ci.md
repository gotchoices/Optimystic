----
description: Review the filesystem storage package additions: test:verbose script, broadened test coverage, and README.
files: packages/db-p2p-storage-fs/package.json, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/README.md
----

## What landed

Three changes to `packages/db-p2p-storage-fs`:

**1. `package.json` script alignment.**
- `test` now uses `--reporter min` (was `--reporter spec`).
- `test:verbose` added with `--reporter spec`.
Matches the pattern of sibling storage packages (`ns`, `rn`, `web`); root
`yarn test:verbose` foreach no longer silently skips this package.

**2. Broadened test coverage** (`test/file-storage.spec.ts`).
New describe block `FileRawStorage round-trips` adds:
- `saveRevision`/`getRevision` round-trip
- `saveTransaction`/`getTransaction` round-trip
- `saveMaterializedBlock`/`getMaterializedBlock` round-trip
- `savePendingTransaction` → `promotePendingTransaction`: verifies the file moves
  from `pend/` to `actions/` and is no longer listed as pending
- Colon-in-action-id encoding: saves `tx:abcd1234`, reads it back, asserts the
  filename on disk contains `%3A` and no raw colon

New tests in `FileKVStore atomic writes`:
- `list(prefix)` returns all keys under a prefix recursively, excludes other prefixes
- `list(prefix)` returns empty for non-existent prefix
- `delete` removes a key; subsequent `get` returns `undefined`
- `delete` on a non-existent key does not throw

**3. `README.md`** (new file).
Covers: what the package is, install, usage, on-disk layout, atomic-write
guarantee, identity divergence from siblings, test instructions, known
limitations (no cross-process lock; ephemeral peer identity).

## Validation

All 20 tests pass (`yarn test` and `yarn test:verbose` from package dir).
Build (`tsc`) clean.

## Known gaps (documented, not fixed)

- **No cross-process lock** — `file-storage.ts:22` TODO to use `proper-lockfile`.
  Noted in README "Known limitations" and in the constructor comment.
  // NOTE: no cross-process lock; if this ever needs multi-process access, integrate proper-lockfile at the constructor TODO site.
- **Ephemeral peer identity** — no `loadOrCreateFSPeerKey` equivalent.
  Noted in README. If durable identity is needed, file a `feat-fs-peer-identity`
  backlog ticket.

## Review findings

Tripwires parked at code sites (grep `NOTE:`):
- `file-storage.ts:22` — cross-process lock TODO (pre-existing; README now surfaces it)

No new tripwires introduced by this ticket's changes.
