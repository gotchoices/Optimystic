description: When a block first has a pending change, the storage layer records that it holds every version of that block from the beginning of time — a claim that is almost never true. This false claim switches off the machinery that would otherwise fetch missing versions, so reads of a version the node lacks either fail or quietly return an older one.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts
difficulty: medium
----

# Pend seeds an open-ended `ranges: [[0]]` — a false coverage claim that disables restoration

`savePendingTransaction` seeds the block metadata with `ranges: [[0]]`
(`block-storage.ts:57`), an open-ended range asserting that every revision from 0 onward is
locally present. That claim is a coverage lie, and it has two damaging consequences:

- **Restoration is switched off.** `ensureRevision`'s `inRanges` check is always true, so the
  restore callback never fires. A `getBlock(rev)` for a revision the node does not actually
  hold then throws, or silently serves an older revision, instead of restoring the requested
  one.
- **It is the only thing making commits look "in range."** `internalCommit` never merges
  committed revisions into `meta.ranges`, so the open-ended seed is masking that omission
  rather than ranges being maintained honestly.

Contrast `saveReplica` / `saveDeletion` (`block-storage.ts`), which correctly seed `[]` and
merge closed ranges as revisions land — that is the intended, honest pattern.

Expected behavior: `meta.ranges` is at all times an honest statement of which revisions are
locally reconstructible. Pend seeds `ranges: []` (it adds no revision coverage on its own), and
the commit path (`setLatest` / `internalCommit`) merges `[rev, rev+1]` as each revision is
durably committed. After the fix, `ensureRevision` correctly fires the restore callback for a
revision the node lacks, and `meta.ranges` never claims coverage the node cannot back up.

## Reproduction notes

- After a pend (no commit yet), assert `meta.ranges` is `[]`, and that `getBlock(rev)` for an
  absent revision invokes the restore callback rather than short-circuiting.
- After a commit at rev N, assert `[N, N+1]` is merged into `meta.ranges`.

Interaction: this is the honesty fix that makes gap detection in
`st-commit-accepts-noncontiguous-revisions` and lazy repair in
`st-recoverblock-no-production-caller` actually observable; the review calls this seed the root
that quietly disables the reconstructive model.

Suggested-fix hint: seed `ranges: []` at pend; merge closed `[rev, rev+1]` ranges at commit,
mirroring `saveReplica`/`saveDeletion`.
