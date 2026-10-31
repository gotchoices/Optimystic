description: Let a read ask the machine answering it not to start the background check against the other machines in the group that a routine read of a held block normally starts, so the table watcher's timer can read its own copy without sending a network request.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/network/struct.ts (`BlockGets.skipWindowConsult`), packages/db-core/src/transactor/network-transactor.ts (`downstreamGets`), packages/db-core/src/collection/collection.ts (`Collection.readCommittedTails`, `readAttributed`, `readAlone`, `tailReadFields`), packages/db-core/src/collection/struct.ts (`CommittedTailReadOptions`), packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock`), packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts, docs/transactions.md, docs/internals.md
----
First half of GitHub #48's remaining idle cost; `an-idle-watch-tick-sends-no-read-request` wires the watch tick to it (not done here — `committedTailReader` in `packages/db-p2p/src/reactivity/collection-watch.ts` does not pass the option yet).

## What was built

- `BlockGets.skipWindowConsult?: true` with a doc comment: skips only the consult the lazy window alone would run behind a read; never the missing-block consult, a floor-demanded consult, or `'paranoid'`; forwarded on the wire; older peers ignore it; distinct from `skipClusterFetch`.
- `CoordinatorRepo.readRepairBlock`: computes `windowOnly = isStale && !floorDemands && readRepairMode === 'lazy'`. With the flag and `windowOnly`, it calls `flagUnconfirmedCurrency` and returns — no consult, no `cluster-tx:read-repair-triggered` line, freshness stamp untouched. This sits ahead of the `awaitWindowConsults` split, so the test seam skips too (as the plan asked).
- `downstreamGets` forwards the flag on every batch (first round and second-chance round both go through it).
- Confirmed preserved without change: `stateHoldingsOnReads` (spreads `blockGets`), `RepoClient` left-out rounds (`narrowBlockGets` keeps `...rest`), `RepoService` → `CoordinatorRepo.get` verbatim.
- `Collection.readCommittedTails(transactor, queries, options?: CommittedTailReadOptions)` puts the flag on both requests and on the per-block fallback (`readAttributed` / `readAlone` now take the fields).
- Docs: one sentence in transactions.md § Lazy read-repair window; one clause in internals.md's read-path paragraph.

## Tests added (db-p2p `coordinator-repo-held-block-background-consult.spec.ts`)

- "a read marked skipWindowConsult starts no consult for a held block, and leaves the window expired" — held block, expired (never-stamped) window: flagged read asks no remote peer and returns the held copy; the following unflagged read consults once.
- "a read marked skipWindowConsult still consults for a block missing locally" — absence verdict still asks the cohort; whole cohort says nothing → unflagged absent.

No test for forwarding through `NetworkTransactor` or `readCommittedTails` (wiring), per the plan.

## Verified

- `yarn lint:docs` clean; db-core and db-p2p built; `yarn test` db-core 2025 passing, db-p2p 3564 passing / 74 pending, no failures.
- Not run: `yarn lint` (eslint), integration suites, quereus plugin suite (no plugin code touched).

## For the reviewer

- Floor-above-copy and `'paranoid'` with the flag are covered by inspection only (`windowOnly` requires `!floorDemands` and `'lazy'`).
- A doubt memo present + flag: still stamped `unconfirmedAheadRev` by inspection (same `flagUnconfirmedCurrency` call as the background branch).
- The flag silences the trigger log line entirely for skipped reads, so `cluster-tx:read-repair-triggered` counts in debugging won't reflect watch-tick reads — intended (no consult started).
