description: A block's stored list of "which past versions I can rebuild locally" was being filled with a false claim the moment the block got its first uncommitted change, which turned off the code that fetches versions the node is actually missing. This fixes the false claim and records real coverage as each version commits.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/src/storage/helpers.ts, packages/db-p2p/src/storage/struct.ts
difficulty: medium
----

# Review: Pend no longer seeds a false open-ended coverage range

## What the code does (context for the reviewer)

`BlockMetadata.ranges` (`struct.ts:10`) is a list of half-open revision ranges
`[startInclusive, endExclusive?)` stating **which revisions of a block this node can locally
reconstruct**. `endExclusive === undefined` means open-ended ("everything from `start` on").
`ensureRevision` (`block-storage.ts`) trusts it: if the requested revision is `inRanges`, serve
locally; otherwise fire `restoreCallback` to fetch it from a peer, then merge the restored range.

The honest pattern (already used by `saveReplica`/`saveDeletion`): seed `ranges: []` and, as each
revision lands durably, `unshift` a **closed** range `[rev, rev+1]` then `mergeRanges`.

## The bug that was fixed

`savePendingTransaction` seeded `ranges: [[0]]` — open-ended, claiming "rev 0..∞ all present" —
the instant a block first got a pending change, before any revision was committed. That lie:

- **Disabled restoration.** `inRanges(rev, [[0]])` is true for every `rev >= 0`, so a
  `getBlock(rev)` for a revision the node did not hold never fired `restoreCallback`; it fell into
  `materializeBlock`, which throws `Failed to find materialized block …` (or silently serves a
  stale materialization) instead of fetching the requested revision.
- **Masked a matching omission on the commit path.** `internalCommit` advances `meta.latest` via
  `setLatest` but never merged the committed revision into `meta.ranges`. The open-ended seed hid
  that. The two had to be fixed together.

## What changed

Production (`block-storage.ts`):
- Pend seed `ranges: [[0]]` → `ranges: []` (honest: a fresh pend reconstructs nothing).
- `setLatest` now merges the closed range `[latest.rev, latest.rev+1]` via `mergeRanges` before
  saving. `internalCommit` calls `setLatest` **last** (after materialize/saveRevision/promote), so
  the revision is fully reconstructible before its range is claimed, and range+latest land in one
  `saveMetadata` write (atomic under the commit latch).
- `recover()` now merges `[currentRev+1, maxRev+1]` when it advances `latest` over the probed span
  (the lost `setLatest`'s range merge, redone for the recovered revisions — each was verified
  present in the committed log by the probe loop).

Test-only seed mirrors (same honesty invariant):
- `mesh-harness.ts` sim-sync path: `[[0]]` → `[]` (the following `setLatest` covers the range).
- `mid-ddl-crash.spec.ts` `preSeedMetadata`: `[[0]]` → `[]`.

`saveReplica`/`saveDeletion` were left as-is — they already merge their own closed ranges.

## Validation performed

- `yarn build` (tsc) in `packages/db-p2p` — clean.
- `yarn test` in `packages/db-p2p` — **1151 passing, 0 failing, 36 pending**. Crash-recovery
  suite (`mid-ddl-crash.spec.ts`) stayed green; those asserts target `meta.latest`, not `ranges`
  shape, so the seed change did not disturb them. No `ranges`-shape asserts needed editing there.
- New `test/block-storage.spec.ts` — 5 passing:
  - pend seeds `ranges: []`
  - `getBlock` for an absent revision fires the spy `restoreCallback` (restore not short-circuited)
  - commit merges `[1, 2]`
  - non-contiguous commits (rev 1 then rev 3) yield disjoint `[[1,2],[3,4]]` (the gap at rev 2 survives)
  - `recover` merges the recovered span into `ranges`

## Where a reviewer should push (test floor, not ceiling)

- **`recover` span math.** The merged range is `[currentRev+1, maxRev+1]`. The new test only
  covers the single-revision case (`currentRev=0 → maxRev=1`, range `[1,2]`). A multi-revision
  recovery (e.g. `currentRev=0`, revisions 1 and 2 both durable → `maxRev=2`, range `[1,3]`) is
  untested. Worth adding if you want the span-endpoint arithmetic pinned.
- **Contiguity merge on commit.** The tests cover contiguous (implicit — a single `[1,2]`) and
  non-contiguous. A commit that *closes* an existing gap (claim rev 1, rev 3, then rev 2 → expect a
  single merged `[[1,4]]`) is not tested; it exercises `mergeRanges`' adjacency-join branch through
  `setLatest`. Low risk (`mergeRanges` is separately covered) but not asserted end-to-end here.
- **Restore-then-serve correctness.** The restore test asserts the callback fired and the range was
  claimed, but uses a trivial single-revision archive; it does not exercise a multi-revision or
  tombstone archive through `saveRestored` + `materializeBlock`. The reconstructive path beyond
  "callback fired" is only lightly touched.
- **No production caller drives `restoreCallback` yet.** `BlockStorage` is constructed without a
  `restoreCallback` in `mesh-harness.ts` and (per the sibling ticket
  `st-recoverblock-no-production-caller`) elsewhere in production. So this fix makes restoration
  *possible and observable in tests*, but the end-to-end lazy-repair path is still not wired by a
  real caller — the sibling ticket owns that. Do not treat "restore fires in a unit test" as proof
  the distributed repair loop works.

## Tripwire noted

- `setLatest` does `meta.ranges.unshift(...)` then `mergeRanges` on every committed revision. For a
  block with a long history of non-contiguous ranges this is O(n log n) per commit on the ranges
  array. Fine now (ranges collapse to a handful of spans in practice). Parked as a `NOTE:` at the
  merge site in `block-storage.ts` — if a block ever accumulates many disjoint ranges and commits
  show up as slow, keep a running merged structure instead of re-sorting each time.

## Sibling tickets (context, not blockers)

This is the honesty fix that makes gap detection in `st-commit-accepts-noncontiguous-revisions`
and lazy repair in `st-recoverblock-no-production-caller` observable. It does not depend on them
and landed independently.
