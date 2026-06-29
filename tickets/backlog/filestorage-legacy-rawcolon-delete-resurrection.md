description: On a node upgraded from an older Linux/Mac build, deleting a stored item could later reappear because only the new-style file is removed while an older duplicate is left behind. This is a future safeguard, not an active bug.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: easy
----

## Background

The `filestorage-posix-colon-actionid-migration` work added a **read fallback**
in `FileRawStorage`: `getTransaction` / `getMaterializedBlock` /
`getPendingTransaction` now read the canonical percent-encoded path
(`actions/tx%3A<hash>.json`) first, and on a miss fall back (POSIX-only) to the
legacy raw-colon path written by pre-encode nodes (`actions/tx:<hash>.json`).

The **delete/unlink paths were deliberately left untouched** and operate only on
the encoded filename:

- `deletePendingTransaction` → `fs.unlink(getPendingActionPath(...))` (encoded only)
- `saveMaterializedBlock(blockId, actionId, undefined)` → `fs.unlink(getMaterializedPath(...))` (encoded only)
- `promotePendingTransaction` → `fs.rename(encoded pend → encoded actions)` (encoded only; legacy raw pend already noted as out-of-scope in the source ticket)

## The asymmetry (latent correctness gap)

On a store migrated from a pre-encode POSIX node, a value may exist on disk under
the **raw-colon** filename. A delete removes only the **encoded** file. If no
encoded file is present (the common migrated case), the delete is a silent no-op
on the raw file, and a subsequent `get*` call **falls back to the surviving
raw-colon file and resurrects the supposedly-deleted value**.

This is **not an active bug today**: a repo-wide search found **no production
caller** of `deletePendingTransaction` (only the `IBlockStorage` wrapper forwards
it) and **no production call** of `saveMaterializedBlock` with `undefined` (the
only live caller in `mesh-harness.ts` always passes a real block; delete-with-
undefined appears solely in storage unit tests). So the resurrection path cannot
currently be triggered in normal operation. It becomes a real bug the moment a
production code path starts deleting pending transactions or tombstoning
materialized blocks against a migrated raw-colon store.

## Desired behavior

Make delete symmetric with the read fallback so a delete cannot be undone by a
stale legacy file. When `process.platform !== 'win32'` and the raw path differs
from the encoded path, the unlink should *also* best-effort remove the raw-colon
file (ignoring `ENOENT`), in:

- `deletePendingTransaction`
- `saveMaterializedBlock` (the `block` absent / tombstone branch)

Keep it side-effect-minimal and consistent with the existing "legacy files are
read in place, never renamed" stance — this is about *removal on explicit
delete*, not a migration sweep. Add POSIX-gated tests mirroring the existing
`FileRawStorage legacy raw-colon read fallback (POSIX-only)` block: write a raw-
colon file, delete via the API, assert the subsequent `get*` returns `undefined`
(no resurrection).

## Why backlog (not fix/now)

No current trigger (no production delete callers), pre-1.0, and it touches the
write/delete paths the migration ticket intentionally kept clear. File here so
the decision is tracked and lands before any delete path goes live against
migrated stores.
