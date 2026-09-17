description: Before every live query each table checks the network for changes, and even when nothing had changed that check fetched the same two small blocks seven or eight times, one at a time. It now stops after one request when the table has not moved, and never fetches a block twice in one check.
files:
  - packages/db-core/src/collection/collection.ts (`updateInternal`, `tailShowsNothingNewer`, `disagreesWithHeld`, `readLogEnds`, `readLogTail`, `checkedLogTail`, `bootstrapContext`, `logTailId` field, `open` / `createOrOpen` / `attachToLog`)
  - packages/db-core/src/transactor/transactor-source.ts (new `answeredBlock`, `servedRevision`; `tryGet` now uses them)
  - packages/db-core/test/refresh-read-cost.spec.ts (new)
  - docs/internals.md (§ Quereus vtab read path; the unavailable / possibly-stale bullets; lineage-divergence bullet)
  - docs/debugging.md (lineage-divergence guidance)
repro: verified
----
# Review: a refresh of an unchanged collection no longer refetches the same blocks

## What changed

`Collection.updateInternal` (reached from `Tree.update`, which the Quereus adapter calls on every live read for the table tree and each index tree it scans) now runs in three steps:

1. **One request for header and tail.** `readLogEnds` asks for the collection header plus the log tail id the previous header named (`logTailId`, remembered per instance and seeded from the header read at open). If the fresh header names a different tail (the old one filled), that tail is fetched separately; the out-of-date answer is dropped. Both answers go through `answeredBlock`, the same unavailable / possibly-stale checks `TransactorSource.tryGet` applies (extracted from `tryGet` so the two cannot drift; `bootstrapContext`'s hand-copied version is gone).
2. **Early exit.** `tailShowsNothingNewer` returns before the log walk when: the tail block has no `nextId`; its claim (`state.latest`) is at the held revision; its newest entry is at that revision and names the claimed action; the held context names that same action at its revision; and no action entry in the tail block disagrees with the held list. A write's retry refresh (`inFlightActionId` set) always walks. A header that is authoritatively absent with no held revision also returns right away (before, it fell through a walk of nothing).
3. **Refresh-scoped cache.** Otherwise the walk runs through `new Tracker(new CacheSource(source, …, ends.served))`, seeded with the header and tail just read, so `Log.open`, `getFrom` and `getInvalidationsFrom` share one fetch per block. The code comment explains why seeding unpinned reads into a walk pinned at the tail's claim is sound.

## Measured (TestTransactor, counting `get` calls)

| Scenario | Before | After |
|---|---|---|
| Unchanged refresh, 50-commit history | 7 requests (header ×4, tail ×3) | 1 request `[header, tail]` |
| Unchanged, 200-commit history | grew with history | 1 |
| First refresh after open, nothing new | — | 1 |
| Own commit, then refresh | 7 | 1 |
| One new commit, 51 entries over 2 log blocks | header ×4, tail ×3 | 2 requests, no block twice |
| Tail rolled since last refresh | — | 3 requests: batched `[header, old tail]`, new tail, old tail again (walk) |
| Table tree + index tree, both unchanged | 16 | 2 |

The spec asserts upper bounds, not exact counts.

## Tests

- New `packages/db-core/test/refresh-read-cost.spec.ts`: the table above as budgets, plus correctness checks that idle refreshes still pick up later commits and a rolled tail, and a rewriting double (`NewestActionHidingTransactor`) showing that a held context which does not name its own revision still walks and adopts the full list.
- Existing diagnostics in `collection.spec.ts` ('a refresh that lands short of the tail it just read', 'a refresh whose log names a different action at the held revision', including 'names the EARLIEST revision') pass unmodified. Each now takes the fall-through path.
- Mutation check. With each early-exit condition disabled in turn: the in-window lineage check and the newest-entry check are caught by existing `collection.spec.ts` tests, and the held-action check is caught by the new spec. **The `nextId` check and the in-flight check are not caught by any test.** Both are backup guards against states the current log format cannot produce. A roll leaves the old tail's newest entry below its claim, and an in-flight write's own entry sits above the held revision; the newest-entry check already rejects both.
- Runs: db-core `yarn test` 1728 passing; `quereus-plugin-optimystic` 987 passing, 13 pending (none added), smoke ok; db-p2p 2955 passing, 63 pending. `tsc --noEmit` (src + test) clean; `yarn lint:docs` clean.

## Known gaps and tradeoffs (parked as `NOTE:` at the site)

- **Forks below the tail block are not re-checked by an idle refresh.** The early exit compares only the tail block's entries (up to 32). A split older than that, on a log nobody is writing to, is reported by the first refresh after the next commit. Recorded in the `tailShowsNothingNewer` doc and in both docs files.
- **After an invalidation takes the newest log slot, every refresh walks until the next commit.** An invalidation entry names no action, so it never matches. NOTE at `tailShowsNothingNewer`.
- **A rolled tail is fetched twice in that one refresh.** The batched answer for the old tail is dropped rather than seeded, because nothing proves it is current at the pinned revision. This happens once per 32 commits for a reader that crosses a roll.
- **Batching can fail a refresh on an unreachable out-of-date tail.** `NetworkTransactor.get` throws if any id gets no answer. That is harmless while the log has no checkpoints, because the walk reads the old tail anyway. NOTE at `readLogEnds`.
- **Refresh cache size.** It uses the default 128-block LRU, so logs past about 4,000 entries re-fetch their newest blocks on the invalidation walk. NOTE at the cache construction.
- **Two walks are not merged.** The optional `getFrom` / `getInvalidationsFrom` merge was not done. The cache makes the second walk request-free, and only CPU remains.
- **Open path unchanged.** `open` / `createOrOpen` still probe the header, read the tail, then re-read both pinned through the collection cache. Only the tail read was refactored (`readLogTail` + `bootstrapContext`).
- **Network-level count not measured.** Budgets are asserted against `TestTransactor` only. On a real node, header and tail route independently, so the single request can still become two parallel `/repo` streams when they land on different coordinators (it was 7 sequential before).
- **New public exports.** `answeredBlock` and `servedRevision` are new exports of `@optimystic/db-core` through the transactor barrel.
- **Small check change.** `bootstrapContext`'s old unavailable check was `unavailable !== undefined && block == null`. The shared check is `!block && unavailable`, which is equivalent for the string-union reason type.

## Out of scope (unchanged)

- The held `committed` list still grows by one entry per commit and rides on every `get`: `debt-the-collection-log-never-writes-a-checkpoint`.
- Skipping the refresh entirely when a change notification says nothing moved: `feat-a-live-read-can-skip-a-refresh-the-cohort-already-told-it-about`.
