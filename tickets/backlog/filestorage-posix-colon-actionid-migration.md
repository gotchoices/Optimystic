description: Older Linux/Mac nodes that already saved data to disk may stop being able to read it after the recent Windows filename fix, because the fix changed how files are named; we need a way to migrate or fall back so that existing data stays readable.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts
difficulty: medium
----

## Background

The fix in `optimystic-filestorage-colon-actionid-windows` made `FileRawStorage`
percent-encode the colon in consensus action ids (`tx:<hash>`, `stamp:<hash>`) so
they are legal Windows filenames. Path helpers now read and write the **encoded**
name (`tx%3A<hash>.json`) for:

- `getActionPath` — `actions/<encoded>.json` (durable committed transaction log)
- `getMaterializedPath` — `blocks/<encoded>.json` (materialized blocks)
- `getPendingActionPath` — `pend/<encoded>.json` (in-flight / crash recovery)

## The problem

Before the fix the **write** path stored the raw action id verbatim, with no
platform guard. On POSIX (where the colon is a legal filename character) any node
that ran the consensus path therefore has on-disk files named with raw colons:

```
actions/tx:<hash>.json
blocks/stamp:<hash>.json
```

After upgrading, `getTransaction` / `getMaterializedBlock` compute the *encoded*
path (`actions/tx%3A<hash>.json`) and will not find these pre-existing files —
they return `undefined`. For the durable `actions/` and `blocks/` directories
this is a silent read regression against already-committed data, not merely a
harmless stale-pending situation.

The pending (`pend/`) directory is lower-risk (crash-recovery only, stale after a
clean restart), but `actions/` and `blocks/` are the durable record.

## Why this is filed rather than fixed inline

Optimystic is pre-1.0 and the consensus-on-`FileRawStorage` path was effectively
non-functional on Windows and lightly exercised elsewhere, so the population of
affected on-disk datasets is likely small or nil today. The encode fix itself is
correct and shipped. This ticket captures the migration/compat work so it is not
lost, to be picked up before any deployment relies on persistent FS consensus
storage across the upgrade boundary.

## Expected behavior / options to weigh

Pick one (design decision for whoever takes this up):

- **Read fallback** — when the encoded path misses, retry the raw (un-encoded)
  path before returning `undefined`. Cheapest; leaves mixed naming on disk.
- **One-time migration sweep** — on open (or via a maintenance entry point), scan
  `actions/`, `blocks/`, `pend/` and rename any raw-colon file to its encoded
  form. Cleaner end state; needs to be idempotent and crash-safe.
- **Document as a breaking change** — declare no cross-version on-disk compat for
  pre-fix POSIX data and require a clean store. Only acceptable if we are sure no
  such data exists in the wild.

## Acceptance

- Existing raw-colon `actions/` and `blocks/` files written by a pre-fix POSIX
  node remain readable (or a documented, deliberate decision is made not to
  support them).
- Round-trip behavior on a fresh store is unchanged.
- Coverage proving a raw-colon-on-disk file is still readable after upgrade
  (whichever option is chosen).
