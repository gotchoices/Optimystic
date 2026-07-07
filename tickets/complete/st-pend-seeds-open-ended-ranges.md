description: A block's stored list of "which past versions I can rebuild locally" was being filled with a false claim the moment the block got its first uncommitted change, which turned off the code that fetches versions the node is actually missing. This fixes the false claim and records real coverage as each version commits.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/src/storage/helpers.ts, packages/db-p2p/src/storage/struct.ts
difficulty: medium
----

# Complete: Pend no longer seeds a false open-ended coverage range

## What shipped (implement stage, commit `2dd6806`)

`BlockMetadata.ranges` lists which revisions of a block this node can locally reconstruct;
`ensureRevision` trusts it to decide "serve locally" vs "fetch from a peer".

- **Pend seed fixed (correct, kept).** `savePendingTransaction` seeded open-ended `ranges: [[0]]`
  the instant a block got its first pending change — claiming "every revision present" before any
  revision committed, which made `inRanges` always true and disabled restoration. Changed to
  `ranges: []` (a fresh pend reconstructs nothing). Test-only seed mirrors updated to match
  (`mesh-harness.ts` sim-sync path, `mid-ddl-crash.spec.ts` `preSeedMetadata`).
- **Commit-path range merge added.** `setLatest` and `recover` now merge a committed revision's
  range into `meta.ranges` (previously `internalCommit` advanced `latest` but never claimed the
  range; the open-ended seed had masked that).
- New `test/block-storage.spec.ts` (5 cases) + build/lint/full suite green.

## Review findings

**Scope reviewed:** the implement diff (`git show 2dd6806`) with fresh eyes; `block-storage.ts`
(`savePendingTransaction`, `setLatest`, `recover`, `ensureRevision`, `materializeBlock`,
`saveReplica`/`saveDeletion`, `inRanges`); `helpers.ts` `mergeRanges`; the commit path
`storage-repo.ts` `internalCommit`/`get`; the read entry `TransactorSource.tryGet`; the
descending-walk contract in `test-transactor.ts`; every remaining `[[0]]` seed site in the repo;
the new and touched tests. Ran `yarn build` (clean), `yarn test` (**1151 passing / 0 failing / 36
pending**), `npx eslint` on all changed files (clean).

### Major — filed as a new ticket

- **`tickets/fix/st-ranges-sparse-coverage-breaks-historical-reads.md` — the point-per-revision
  coverage model is a reachable regression.** The fix over-corrected: making each committed
  revision claim only its own single-point range `[rev, rev+1)` leaves a block's coverage as
  disjoint points. But revisions are **sparse in the global rev space**, and `getBlock(rev)` means
  "state as of rev N" = highest committed ≤ N, served by `materializeBlock`'s descending walk. So a
  block modified at revs 1 and 3 **can** reconstruct rev 2 (walks to rev 1) — the point-range model
  says it can't, so `ensureRevision` fires `restoreBlock`, and with no `restoreCallback` wired in
  production it throws `Block <id> revision <n> not found during restore attempt`. **Reachable via
  the public API:** `TransactorSource.tryGet` passes `context.rev = collection tip` on every read;
  reading any block not modified by the latest commit (common in multi-block collections) now
  throws instead of serving its prior state. Confirmed with two reproductions (unit `getBlock(2)`
  and `StorageRepo.get(context.rev=2)`); simulating the old open-ended seed on the same state
  serves correctly, proving it is a regression, not pre-existing. The suite misses it because most
  in-test reads are served by the `CacheSource` in front of the transactor. The ticket includes a
  candidate fix (contiguous `[E, L+1)` coverage, extend from prior latest in `setLatest`) and calls
  out that the implement-stage test `'non-contiguous commits stay disjoint (the gap survives)'`
  **pins the buggy behaviour** and must be reversed to expect `[[1,4]]`.

### Minor — none fixed inline

The pend→`[]` change and the `setLatest`/`recover` range-merge wiring are correct as far as they go;
the defect is the coverage **model**, not a local slip, so there was no safe one-line inline fix to
apply in this pass. The corrective work is a design change touching `setLatest`/`recover`/
`saveReplica`/`saveDeletion` and reversing a deliberately-written test — squarely major, hence the
ticket above rather than an inline edit.

### Checked — found correct (no change needed)

- **Pend empty seed.** `ranges: []` is honest (nothing committed ⇒ nothing reconstructible) and the
  `rev===undefined && latest===undefined` early-return in `getBlock` still short-circuits the
  pending-only default read, so the empty seed does not throw on the common path.
- **`mergeRanges` adjacency + open-ended handling** (`helpers.ts`): half-open join (`range[0] <=
  last[1]`) correctly merges `[1,2]+[2,3]→[1,3]`, keeps genuine gaps disjoint, and an open-ended
  range consumes followers. In-place sort/mutation is harmless (return value reassigned).
- **Commit atomicity.** `internalCommit` calls `setLatest` **last** (after materialize / saveRevision
  / promote), so range + latest advance in one `saveMetadata` write under the commit latch; a crash
  before it advances neither.
- **No stray `[[0]]` seeds.** All three production seed sites now use `ranges: []`
  (pend, `saveReplica`, `saveDeletion`); the only remaining `[[0]]` occurrences are in `docs/` and
  ticket text (historical review artifacts), not code.

### Tripwire (recorded, not filed)

- `setLatest` runs `unshift` + `mergeRanges` (O(n log n) re-sort of the whole ranges array) on every
  commit. Fine now — ranges collapse to a handful of spans. Parked as a `NOTE:` at the merge site in
  `block-storage.ts:95`; if a block ever accumulates many disjoint spans and commits show as slow,
  keep a running merged structure instead of re-sorting. (Note: the follow-up fix, by making
  coverage contiguous, will tend to collapse ranges to a single span, which also mitigates this.)

## Validation performed (review)

- `yarn build` (`packages/db-p2p`) — clean.
- `yarn test` (`packages/db-p2p`) — 1151 passing, 0 failing, 36 pending.
- `npx eslint` on the four changed source/test files — clean.
- Two throwaway reproduction specs (removed after running) confirming the major finding above and
  its regression status.

## Follow-up

- `st-ranges-sparse-coverage-breaks-historical-reads` (`fix/`) — corrects the coverage model.

Sibling context (not blockers): `st-commit-contiguity-guard-premise` (`blocked/`, commit accepting
non-contiguous bases) and `st-recoverblock-no-production-caller` (`fix/`, wiring a real
`restoreCallback`).
