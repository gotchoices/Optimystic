description: When a block first gets a pending change, storage falsely records that it holds every past version of that block. That false claim turns off the code that would fetch versions the node is actually missing, so reads of a missing version fail or silently return a stale one. Fix the false claim and record real coverage as each version commits.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/src/storage/helpers.ts, packages/db-p2p/src/storage/struct.ts
difficulty: medium
----

# Pend seeds an open-ended `ranges: [[0]]` — a false coverage claim that disables restoration

## Background (read first)

`BlockMetadata.ranges` (`struct.ts:10`) is a list of half-open revision ranges
`[startInclusive, endExclusive?)` describing **which revisions of a block this node can locally
reconstruct**. `endExclusive === undefined` means "open-ended, everything from `start` onward."
`ensureRevision` (`block-storage.ts:225`) trusts this list: if the requested revision falls
`inRanges`, it serves locally; otherwise it fires `restoreCallback` to fetch the missing
revision from a peer, then merges the restored range in.

The honest, intended pattern is visible in `saveReplica` / `saveDeletion`
(`block-storage.ts:126-223`): they seed `ranges: []` (a fresh block covers *nothing* on its
own) and, as each revision lands durably, `unshift` a **closed** range `[rev, rev+1]` and call
`mergeRanges` (`helpers.ts`). `ranges` therefore stays an exact statement of what is
reconstructible.

## The bug

`savePendingTransaction` (`block-storage.ts:57`) instead seeds:

```ts
meta = { latest: undefined, ranges: [[0]] };   // open-ended: "rev 0..∞ all present"
```

That is a lie — the node holds *no* committed revision yet. Two damaging consequences:

- **Restoration is switched off.** `inRanges(rev, [[0]])` is `true` for every `rev >= 0`, so
  `ensureRevision` never fires `restoreCallback`. A `getBlock(rev)` for a revision the node does
  not actually hold then falls into `materializeBlock`, which throws
  `Failed to find materialized block …` (or, if an older materialization exists in the log,
  silently serves the wrong revision) instead of restoring the requested one.
- **The seed is the *only* thing making commits look "in range."** `internalCommit`
  (`storage-repo.ts:526`) advances `meta.latest` (via `setLatest`) but **never merges the
  committed revision into `meta.ranges`.** The open-ended seed masks that omission. Remove the
  seed without also fixing the commit path and every committed revision would (correctly, but
  newly-visibly) report as out-of-range.

The two are a matched pair: the seed must become honest (`[]`) **and** the commit path must
start merging closed ranges, in the same change.

## Expected behavior

- After a pend with no commit, `meta.ranges === []`. `getBlock(rev)` for a revision the node
  lacks fires `restoreCallback` rather than short-circuiting.
- After a commit at revision `N`, `[N, N+1]` is merged into `meta.ranges`. Non-contiguous
  commits (`N`, then `N+2`) yield two disjoint closed ranges — `mergeRanges` keeps the gap,
  which is what makes gap detection observable for the sibling tickets below.
- `meta.ranges` never claims coverage the node cannot back up, at any point in the lifecycle.

## Design of the fix

**Seed honesty.** Change the pend seed (`block-storage.ts:57`) to `ranges: []`. Two testing
sites mirror the same lie and should change with it so the honest invariant holds everywhere:
`mesh-harness.ts:233` (the sim-sync path seeds `[[0]]` then saves the materialized block +
revision and calls `setLatest` for `latest.rev` — it should seed `[]` and let the merge below
cover `[latest.rev, latest.rev+1]`), and `mid-ddl-crash.spec.ts:177` (`preSeedMetadata`
emulates the pend seed).

**Merge closed ranges when a revision lands.** Fold the range merge into `setLatest`
(`block-storage.ts:85`) — it already does the metadata read-modify-write and is the single
"this revision is now durably committed" signal on the production commit path
(`internalCommit` → `setLatest`, `storage-repo.ts:560`). Mirror the `saveReplica` idiom:

```ts
async setLatest(latest: ActionRev): Promise<void> {
    const meta = await this.storage.getMetadata(this.blockId);
    if (!meta) {
        throw new Error(`Block ${this.blockId} not found`);
    }
    meta.latest = latest;
    meta.ranges.unshift([latest.rev, latest.rev + 1]);
    meta.ranges = mergeRanges(meta.ranges);
    await this.storage.saveMetadata(this.blockId, meta);
}
```

Because `internalCommit` calls `setLatest` **last** (after `saveMaterializedBlock`,
`saveRevision`, `promotePendingTransaction`), the revision is fully reconstructible before the
range is claimed, and the range+latest advance land in one `saveMetadata` write — atomic under
the commit latch. A crash before `setLatest` advances neither.

**`recover()` must also merge (same file, same principle).** `recover()`
(`block-storage.ts:94`) advances `meta.latest` by writing metadata *directly* (not via
`setLatest`) after probing forward over already-durable revisions. In the crash window it exists
for, the original `setLatest` — and therefore its range merge — was lost, so those recovered
revisions would advance `latest` without honest range coverage, re-introducing the exact bug for
the recovered span. When `recover` advances from `currentRev` to `maxRev`, also merge the closed
range `[currentRev + 1, maxRev + 1]` into `meta.ranges` before saving. (Every revision in that
span was probed present in the committed log, so it is reconstructible — honest to claim.)

Leave `saveReplica` / `saveDeletion` as-is; they already merge their own closed ranges and set
`meta.latest` directly without `setLatest`.

## Reproduction / tests

Add coverage in `packages/db-p2p/test/` (extend `storage-repo.spec.ts` or add a
`block-storage.spec.ts`). Construct `BlockStorage` with a `MemoryRawStorage` and a spy
`restoreCallback`:

- **Pend seeds `[]`.** After `savePendingTransaction`, assert `getMetadata(blockId).ranges`
  deep-equals `[]`.
- **Restore fires for an absent revision.** With `ranges: []` and no committed revision for the
  target, `getBlock(rev)` invokes the spy `restoreCallback` (assert it was called), rather than
  short-circuiting via `inRanges`. (Have the spy return a minimal `BlockArchive` so the call
  completes.)
- **Commit merges `[N, N+1]`.** Drive a pend + commit at rev `N` through `StorageRepo`; assert
  `meta.ranges` contains `[N, N+1]`.
- **Non-contiguous commits stay disjoint.** Commit rev `N` then rev `N+2`; assert `ranges` is
  `[[N, N+1], [N+2, N+3]]` (the gap survives).
- **`recover` merges the recovered span.** Reuse the Crash-D3 setup style from
  `mid-ddl-crash.spec.ts` (durable revision + promoted action, `setLatest` lost) and assert that
  after `recover()`, `ranges` covers the recovered revision.

## Interaction with sibling tickets

This is the honesty fix the review calls the root that quietly disables the reconstructive
model. It is what makes gap detection in `st-commit-accepts-noncontiguous-revisions` and lazy
repair in `st-recoverblock-no-production-caller` actually observable — but it does **not** depend
on them; land it independently.

## Validation

Run from `packages/db-p2p`:

```
yarn test 2>&1 | tee /tmp/db-p2p-test.log
```

Existing crash-recovery tests (`mid-ddl-crash.spec.ts`) assert on `meta.latest`, not on restore
short-circuiting, so they should stay green after the `preSeedMetadata` seed change; if any
asserts `ranges` shape, update it to the now-honest value. Also run `yarn build` (tsc) for the
package to confirm types.

## TODO

- Change pend seed `block-storage.ts:57` `ranges: [[0]]` → `ranges: []`.
- Change `mesh-harness.ts:233` seed `[[0]]` → `[]`.
- Change `mid-ddl-crash.spec.ts:177` `preSeedMetadata` seed `[[0]]` → `[]`.
- Merge closed `[latest.rev, latest.rev+1]` + `mergeRanges` inside `setLatest`
  (`block-storage.ts:85`); import already present.
- In `recover()` (`block-storage.ts:94`), when advancing `currentRev` → `maxRev`, merge
  `[currentRev+1, maxRev+1]` into `meta.ranges` before `saveMetadata`.
- Add the five tests above under `packages/db-p2p/test/`.
- Run `yarn test` and `yarn build` in `packages/db-p2p`, streaming output with `tee`; fix
  fallout from the seed change; report to review honestly (esp. any `ranges`-shape test edits).
