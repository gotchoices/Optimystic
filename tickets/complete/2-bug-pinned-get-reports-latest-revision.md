description: Storage used to hand back older versions of data labelled with the newest version number, so the safety check that catches work built on out-of-date data was being told the data was fresher than it really was. Storage now reports the version the content actually is.
files: packages/db-core/src/network/struct.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/repository.md, docs/internals.md
----

# Complete: revision-pinned reads report the revision they materialized at

## What shipped

A block read can be *pinned*: the caller passes `context.rev = N` and storage serves the newest
committed content at or below N. Storage did that correctly but labelled the answer with
`state.latest` — the newest revision it holds for the block. Everything downstream that asks "what
revision did this read observe?" believed the label, so a pinned read recorded a read dependency at
a revision it never saw, and the validator's exact-equality stale-read check wrongly passed.

The materialized revision was already computed and discarded: `IBlockStorage.getBlock(rev)` returns
`{ block, actionRev }`, and `actionRev` **is** it. The fix carries it out to the caller.

`GetBlockResult` (`packages/db-core/src/network/struct.ts`) gained one **optional** field,
`materializedRev`. Two invariants hold the design together:

- **`state.latest` was NOT redefined.** It still means "the newest revision this repo holds for the
  block" — `StorageRepo.get`'s promotion pre-scan and `CoordinatorRepo`'s read-repair both still
  work off the same number.
- **Optional, with a fallback.** Producers that cannot report it leave it absent; `TransactorSource`
  falls back to `state.latest?.rev ?? 0`, exactly today's behaviour. No unchanged producer or test
  double needed an edit.

Producers: `StorageRepo.get` (both the committed read and the pending-overlay read, the latter
reporting the revision of the committed base the pending was applied over) and `TestTransactor`.
Consumer: `TransactorSource.tryGet`, which feeds both sinks — the `ReadDependencyCollector` and
`getReadRevision`, which `CacheSource` learns on a miss-load and re-emits on every later hit.

## Review findings

### Verified correct

- **`actionRev` really is the materialized revision.** Traced `BlockStorage.materializeBlock`:
  `listRevisions(blockId, targetRev, 1)` walks **descending**, so both the `actions[0]` arm and the
  `materializedActionRev` arm return the highest committed revision at or below the pin. The field
  is what it claims to be.
- **The field survives every hop to the consumer.** `CoordinatorRepo.get` returns `StorageRepo`'s
  entries by reference (including where read-repair swaps in `refreshed[blockId]`);
  `NetworkTransactor.get` merges per block through `rankOf` without rebuilding entries; `RepoClient`
  returns the decoded response as-is over plain JSON. Nothing reconstructs a `GetBlockResult` and
  drops the field.
- **No downstream invariant is broken by recording a *lower* revision.** The dispute cascade's
  `assertForwardOnly` (`packages/db-p2p/src/dispute/cascade.ts`) requires a dependent's revision to
  strictly exceed the read pair it depends on within a collection. Lowering recorded revisions can
  only make that easier to satisfy. `matchReads` matches `(blockId, revision)` exactly, and
  `materializedRev` is always a real revision from the block's own log, so matching still lands.
- **The read-view seed filter improves rather than regresses.** `Collection.createReadTracker` drops
  seeded cache entries whose stamped revision exceeds the pin. Those stamps now come from
  `materializedRev`, which is the revision the cached content genuinely is — so entries that used to
  be dropped spuriously (stamped with a block latest above their own content's revision) are now
  correctly retained. Checked for the opposite direction too; a wrongly-retained entry requires the
  pre-existing "cache loaded at an older context, then a commit landed" case, which
  `transformCache` already covers and which this diff does not touch.
- **`ClusterRepo` is not a `GetBlockResult` producer**, confirming the implementer's deliberate
  deviation from the ticket's TODO. Independently re-verified: the only `GetBlockResult` references
  under `packages/db-p2p/src` are `client.ts`, `coordinator-repo.ts`, `storage-repo.ts`.
- **Source hygiene.** Measured with `wc -l`: `storage-repo.ts` 896, `test-transactor.ts` 489,
  `struct.ts` 231, `transactor-source.ts` 144. Nothing near a size that would warrant a split.

### Fixed in this pass (minor)

- **Docs were out of date.** `docs/repository.md` §1 documents `get`'s output fields and listed only
  `block` and `state`; `docs/internals.md` carries a per-invariant bullet for the parallel optional
  `unavailable` field but had nothing for `materializedRev`. Both updated: `repository.md` now
  documents the field and clarifies that `state.latest` is the answering repo's newest revision, not
  necessarily the returned block's; `internals.md` gained a bullet covering the two-fields-two-
  meanings split, every producer, the single consumer, and why the fallback let the change land
  without touching anything else.
- **The pending-overlay arm was untested.** The implementer flagged this as the least-tested edge.
  Added `a pending-overlay get reports the committed base it was applied over` to
  `packages/db-p2p/test/storage-repo.spec.ts`: commits rev 1 and rev 2, leaves a third action
  pending, reads with `{ actionId, rev: 1 }`, and asserts the content is the rev-1 base plus the
  pending while `materializedRev` is 1 and `state.latest.rev` is still 2.
- **A comment duplicated the field's own doc verbatim.** `TransactorSource.tryGet` restated nine
  lines of `GetBlockResult.materializedRev`'s JSDoc, including a sentence word-for-word. Condensed
  to a pointer, keeping only the locally-relevant part (both sinks must take the same value).

### Filed as a new ticket (major)

- **`tickets/backlog/debt-pending-only-insert-unreadable-with-context`** — `StorageRepo.get`'s
  pending-overlay branch is shaped to serve a brand-new insert that has a pending record but no
  committed revision, and this diff added an explicit "no committed base" arm to `materializedRev`
  for it. That branch is **unreachable**: `ActionContext.rev` is a required number, and
  `BlockStorage.getBlock` only tolerates a missing committed base when `rev` is `undefined`, so any
  contextful read of such a block throws inside `getBlock` and is caught into
  `unavailable: 'unmaterializable'` before the overlay branch runs.

  Verified by driving `StorageRepo`'s own public API — pend an insert, then `get` with
  `{ actionId, rev, committed: [] }` — which returned `{ state: {}, unavailable: 'unmaterializable' }`
  for rev 0, 1 and 2. **Pre-existing**, not introduced here: the `getBlock` throw and its catch
  predate the diff, and the inaccurate claim was already in the branch's own comment. This diff
  reinforced it with a second inaccurate comment.

  Filed as `debt-` rather than `bug-` because the path is dormant: no caller in this repository
  reaches it (full suite green), since a collection's own uncommitted inserts are served from its
  in-memory tracker rather than from storage. It is reachable in principle through the repo
  protocol, which is a public surface.

  Corrected in this pass without changing behaviour: both misleading comments in `storage-repo.ts`
  now say the arm is dead and point at the ticket, and
  `KNOWN GAP: a pending-only insert read WITH a context never reaches the overlay at all` pins the
  actual behaviour in the spec (following the file's existing `KNOWN GAP:` idiom) so the dead branch
  is visible rather than merely believed to work.

### Tripwires (conditional — deliberately not tickets)

- **Cross-peer disagreement on `materializedRev` is not tie-broken.** The implementer parked a
  `NOTE:` on `rankOf` in `packages/db-core/src/transactor/network-transactor.ts`. Reviewed and
  agreed: `materializedRev` is not part of the three-way ranking, so two peers answering the same
  pinned get with block-carrying entries at different materialized revisions resolve to whichever
  arrived first. The realistic trigger is a lagging replica, and the failure direction is safe — the
  lower recorded revision spuriously stale-rejects rather than wrongly accepting — and it is not a
  regression, since a lagging peer served older content under the old labelling too. Left as the
  `NOTE:` it is; no new parking needed.

### Checked and deliberately left alone

- **Pre-existing unused parameter**, as the implementer reported: `network-transactor.ts` has an
  unused `blockIds` on `commitBlock` (TypeScript hint 6133, not an error). `yarn lint` exits 0 and
  `yarn build` exits 0, so nothing is being suppressed. Outside this diff's scope.
- **`read-view-pinned.spec.ts` mostly does not reach the changed line** (it builds views with
  `recordReads: false`). True, and noted by the implementer. Not worth widening here — the changed
  line is directly covered at both the storage layer and the `TransactorSource`/`CacheSource` layer.

### Explicitly empty

- **No `fix/` or `plan/` tickets.** The one major finding is a dormant latent defect with a settled
  shape, which belongs in `backlog/`; nothing else needed further design or investigation.
- **No `blocked/` tickets.** Nothing here needs a human decision or an out-of-repo dependency.
- **No pre-existing test failures.** Nothing failed at any point, so no
  `tickets/.pre-existing-error.md` was written. The 56 pending specs across the monorepo are
  long-standing skips; none were added, and no test was skipped, disabled, or loosened.

## Known gaps carried forward

- **The end-to-end consequence is still not directly observed.** The original ticket was honest that
  "a transaction commits on unread data" was *inferred* from reading the validator and collector.
  That remains true: the mis-stamping is verified at the storage layer and the
  `TransactorSource`/`CacheSource` layer, but no test drives a full pinned-read → pend → commit →
  validate cycle across two peers and watches a wrongly-accepted commit become a rejection.
  `tickets/backlog/debt-e2e-stale-cache-hit-read-rejected` proposes that harness and should cover it.
- **`TestTransactor`'s pending-overlay `materializedRev` is still unasserted directly.** The
  production producer (`StorageRepo`) now is. The test double's semantics are simpler (it always uses
  its own `latestRev` as the pending base, ignoring the pin) and are exercised indirectly by the
  db-core specs.

## Validation

From the monorepo root, all green, zero failures:

- `yarn lint` → exit 0, no output
- `yarn build` → exit 0
- `yarn test` (all 11 workspace suites) → exit 0

```
1349 passing   (db-core)
1519 passing, 44 pending   (db-p2p — 1517 before this pass, +2 new tests)
  52 passing, 1 pending
  49 / 44 / 43 / 12 / 125 passing
 359 passing, 11 pending
   6 passing   (quereus-plugin-optimystic smoke)
 258 passing   (quereus-plugin-optimystic)
```
