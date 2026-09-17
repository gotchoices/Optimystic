description: Before every live query each table checks the network for changes, and even when nothing had changed that check fetched the same two small blocks seven or eight times, one at a time. It now stops after one request when the table has not moved, and never fetches a block twice in one check.
files:
  - packages/db-core/src/collection/collection.ts (`updateInternal`, `tailShowsNothingNewer`, `disagreesWithHeld`, `readLogEnds`, `readLogTail`, `checkedLogTail`, `bootstrapContext`, `logTailId`)
  - packages/db-core/src/transactor/transactor-source.ts (`answeredBlock`, `servedRevision`)
  - packages/db-core/test/refresh-read-cost.spec.ts
  - packages/db-core/test/collection.spec.ts
  - docs/internals.md
  - docs/debugging.md
repro: verified
----
# Complete: a refresh of an unchanged collection no longer refetches the same blocks

## What landed

`Collection.updateInternal` (run by `Tree.update` before every live read of each tree) now:

1. Reads the collection header and the log tail block in one request (`readLogEnds`), using the tail id the previous header named. If the header names a different tail, that tail is fetched separately. Both answers go through `answeredBlock`, the unavailable / possibly-stale check extracted from `TransactorSource.tryGet` so the two paths cannot drift.
2. Returns early (`tailShowsNothingNewer`) when the tail block has no successor, its claimed revision equals the held revision, its newest entry is that claimed action, the held context names the same action, and no action entry in the tail block disagrees with the held list. A write's retry refresh always walks.
3. Otherwise walks the log through one `CacheSource` seeded with the header and tail, so no block is fetched twice.

Measured against `TestTransactor`: an idle refresh went from 7 requests to 1 (independent of history length); table + index idle refresh from 16 to 2; a refresh with one new commit fetches no block twice. Budgets are asserted as upper bounds in `refresh-read-cost.spec.ts`.

Known gaps are parked as `NOTE:` at their sites: forks below the tail block go unnoticed by idle refreshes until the next commit; an invalidation in the newest log slot makes every refresh walk until the next commit; a rolled tail is fetched twice in that one refresh; a batched get can fail on an unreachable out-of-date tail; the refresh cache keeps the 128-block default. Real-network request counts were not measured.

## Review findings

- **Diff read first.** Read the implement commit (299e1499) in full before the handoff.
- **Correctness of the early exit.** Checked that skipping the walk skips nothing observable. With no new entries, the entry loop, invalidation handling and `sourceCache.clear` do nothing. `advanceContext` would adopt a context at the same revision. `reportShortfall` stays silent because tail rev = held rev = adopted rev. `mustReplay` returns false because there are no conflicts and the revision did not change. Invalidations take their own revision slot and are committed like actions (`Log.addInvalidation`), so a new one raises the tail's claim and forces a walk. The only thing the exit can skip is replacing a held list that is missing some revisions with the log's fuller list. That case is covered where it matters, at the held revision itself (the `NewestActionHidingTransactor` test). Lower revisions only one side names are "missing evidence", the same rule `earliestFork` uses. No defect found.
- **Soundness of seeding the cache with unpinned reads.** Checked `CacheSource`: seeded entries are handed out with `structuredClone` on every hit, so sharing the raw transactor objects is safe. A stale header that names the old tail is tolerated by `Chain.getTail` following `nextId`, as the code comment says. If a lagging header points at a filled old tail, the pinned revision is too low. That already happened before this change (the old code read the header the same way), so it is not a regression.
- **Error paths: gap found and fixed.** No test covered the tail's unavailable / possibly-stale checks on the *refresh* path after open, and that path can now stop on the batched answer alone. I added two tests to `collection.spec.ts`: `update()` throws `BlockUnavailableError` / `BlockPossiblyStaleError` when the log tail goes bad after open, even with nothing new. Mutation check: with the `answeredBlock` call in `checkedLogTail` removed, the possibly-stale test fails. The unavailable test still passes, because a blockless tail has no claim, so the refresh walks and `TransactorSource` throws. That second layer of protection is acceptable.
- **Stale comments fixed.** `answeredBlock`'s doc and two `collection.spec.ts` comments still named `bootstrapContext` as the tail read that checks flags. They now point to `checkedLogTail`. The other `bootstrapContext` mentions (network-transactor, struct.ts, internals.md, collection.spec.ts) are about adopting the tail's claim, which `bootstrapContext` still does, so they stay accurate.
- **Docs.** Read the internals.md and debugging.md changes. They accurately describe the early exit, the lineage-check blind spot and `checkedLogTail`. No other doc describes refresh request counts.
- **Performance.** `disagreesWithHeld` scans the whole held `committed` list on every refresh. That list grows by one per commit until checkpoints exist. It is still far cheaper than the walk it replaces, and the list's growth is already tracked (`debt-the-collection-log-never-writes-a-checkpoint`). No ticket.
- **Type safety / modularity.** `LogEnds` is typed well. `answeredBlock` / `servedRevision` are now public exports through the transactor barrel. That is acceptable because other packages consume raw `GetBlockResult`s and should use the same check. The collection.ts additions are cohesive. The file was already large, and nothing split out cleanly for this ticket.
- **Resource cleanup.** No long-lived resources: the per-refresh cache is dropped when the refresh ends. `logTailId` is updated before the early exit. A stale value only costs one extra request (covered by the rolled-tail test).
- **Accepted tradeoffs / tripwires.** The implementer's `NOTE:`s (tail-block-only lineage check, invalidation slot, batched-get failure, cache size) are appropriately conditional. I added no new tripwires and filed no tickets.
- **Validation.** db-core `yarn test`: 1730 passing (1728 + 2 new). `tsc --noEmit`: clean. eslint on the changed files: clean. `yarn lint:docs`: clean. I did not rerun downstream packages: this review changed only tests and comments, and the implementer's runs of quereus-plugin-optimystic and db-p2p cover the source change.
