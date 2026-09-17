description: After a shared table changes, a machine that re-reads the changed record can be handed an old copy of it, keeps that old copy in memory, and never looks again — so it goes on showing stale data even after its own disk has been brought up to date. The machine already has the information needed to see that the copy is too old, and does not use it.
prereq:
files: packages/db-core/src/collection/collection.ts (updateInternal — the per-entry `sourceCache.clear(entry.blockIds)`), packages/db-core/src/transactor/transactor-source.ts (tryGet, servedRevision), packages/db-core/src/transform/cache-source.ts, packages/db-p2p/src/repo/coordinator-repo.ts (get — the `isStale = shouldReadRepair(blockId)` decision), docs/transactions.md (§ Lazy read-repair window)
difficulty: hard
repro: verified
----

# A refreshed collection re-reads a changed block, is served an older revision of it, and caches that forever

Reported from the downstream `sereus` repository (its ticket `control-peer-row-refresh-invisible-to-third-node`). This is the follow-up that `complete/a-reader-cannot-tell-its-view-stopped-advancing` said could not be verified from here: that fix landed, the downstream symptom persisted, and a trace taken on 2026-09-17 against `1.0.0-beta.3` (dist built 11:17 local, before every run below) shows why. **That fix is correct and is not on this path.** It gates which *commits* may arm the 10-second "recently checked" window; here the window was armed by a legitimate *cohort consult*, and the stale copy that does the damage is not in the repo at all — it is in the collection's in-memory block cache.

## What a user sees

Three machines share a member directory (a table). Machine C updates its own row. Machine B, polling that row four times a second, keeps reading the old row. In a bad run it reads the old row for the whole 45 s the test waits (167 identical reads), although B's own disk copy of the row was corrected 12 s in. Nothing is logged as wrong. B recovers only when some later write happens to touch the same block.

## The mechanism, step by step, from the failing trace

Names: A is the owner and storage node, B the reader, C the writer. B has connections only to A. The table's log tail block is `ur43ihnle…`; the one data block holding the rows is `a4ildVl5q…`. Times are seconds within 17:49 UTC.

1. `05.66` — revision 6 (A adds C's row, with no address yet) commits on the cohort {A, B}. B's disk copy of the data block is at revision 6.
2. `06.44` and `06.66` — revisions 7 and 8 (C writes its address into its row) commit on the cohort **{C, A}**, `peerCount: 2`. C cannot reach B, so the cohort was downsized and B took no part. B's disk copy of the data block stays at revision 6. This is expected; catching B up is read-repair's job.
3. `06.493` — B's poll refreshes the collection. `Collection.updateInternal` reads the header and log tail unpinned. For the tail block B's cached coordinator is **A**, which holds revision 7, so B correctly learns the log has moved. It walks the new entry, calls `sourceCache.clear(entry.blockIds)` for the blocks the entry names — which include the data block — and advances its context to revision 7. All correct so far.
4. `06.497` — the SQL read now re-fetches the data block, pinned at revision 7. For *this* block B's coordinator lookup picks **B itself** (`findCoordinator:done … source=cohort`, `coordinator-cache:self-write-ignored`, then a local `storage-repo get` and no dial). `CoordinatorRepo.get` finds the block present locally and asks only `shouldReadRepair(blockId)` — a pure time test. B last consulted the cohort about this block at `04.401` (`cluster-fetch:synced … rev: 4`), 2.1 s earlier, inside the 10 s `readRepairWindowMs`. So there is no consult, and B's revision-6 content is returned as the answer to a read pinned at revision 7.
5. The collection accepts that answer and puts it in its `CacheSource`. **The log entry that would have invalidated it has just been consumed.**
6. `06.775`–`06.781` — the same thing happens again for revision 8: tail from A, walk, clear, re-read the data block from self, revision-6 content, cached.
7. From here every refresh reads the tail from A, sees revision 8 = held revision 8, and `tailShowsNothingNewer` correctly stops it after one request. The data block is served from memory. **B never fetches the data block again** — the trace has exactly three `findCoordinator:start` lines for that block on B (`04.383`, `06.497`, `06.780`) and then none for 43 s.
8. `18.77` — B's lazy read-repair finally consults about the data block and fixes B's disk copy: `cluster-tx:read-repair-applied { oldRev: 6, newRev: 8 }`. It changes nothing a reader can see, because the collection is not reading the disk; it is reading its cache. 120 more identical stale reads follow.

The content B returned throughout is byte-identical and is exactly the revision-6 row: `updatedAt=1789667345586, addrs=[], sig=(empty)`.

## Why the same defect usually passes — and why that is luck

A passing run traced the same morning has the **same stale self-served read**, 33 failed polls over about 9 s. The only difference: there B also routed the *tail* block to itself, so B's view of the log was stale too (revision 6) until its window expired. At `16.122` and `16.131` read-repair fixed the tail (`oldRev: 6, newRev: 8`) and the data block in the same refresh, so the re-read that followed the walk was served fresh.

So the outcome is decided by which machine B happens to use as coordinator for two different blocks of one collection:

| tail block read from | data block read from | result |
| --- | --- | --- |
| A (current) | A (current) | correct immediately |
| B itself (stale) | B itself (stale) | correct after the ~10 s window, by coincidence of two repairs landing together |
| **A (current)** | **B itself (stale)** | **stale until another write touches the block** |

The faster a reader learns that the log moved, the more durable its stale copy becomes. What picks the coordinator per block was not investigated here.

## The check that is missing

The collection holds, at the moment it re-reads the block, everything needed to know the answer is too old — and needs no wire change to know it:

- the log entry it just walked says *revision 7 changed block X*;
- the answer for block X reports the revision its content was materialized at (`servedRevision(entry)`, already computed in `TransactorSource.tryGet` and handed to the cache via `getReadRevision`);
- 6 < 7.

A block named by a log entry at revision *r*, read at a context at or above *r*, must come back materialized at *r* or later. Anything lower is provably not the view that was asked for. Today nothing compares the two numbers, and the too-old answer goes into a cache that has no expiry and is cleared only by log entries.

### Hypotheses for the correction (for the implementer to weigh; not decided here)

- **db-core, the invariant.** Have `updateInternal` record, per block it clears, the revision of the newest entry naming it (a floor). A later read of that block through `TransactorSource`/`CacheSource` that is served below its floor must not be cached or returned as an answer. What it does instead is the design question: retry excluding the coordinator that answered (the transactor already has an `excluded` retry round — the passing trace shows `findCoordinator:start … excluded=[self]`), and if no coordinator can meet the floor, raise the existing `BlockPossiblyStaleError` rather than serve. This arm alone closes the hole regardless of why a coordinator served old content, and it is a unit-testable property with a test transactor that answers a pinned read below the entry's revision.
- **db-p2p, the cause of this particular too-old answer.** `CoordinatorRepo.get` lets a time stamp suppress the consult for a read whose own `context.rev` is above the block's local revision. The stamp says "this block matched the cohort at some past moment"; the context says "the collection has moved since". A block legitimately lags its collection's revision when later revisions did not touch it, so `context.rev > localRev` alone cannot force a consult on every read without undoing the window. Options: remember with the stamp the highest context revision it was earned under and consult when a read arrives above that (one consult per block per new revision, and only for blocks a reader actually re-reads — which after a refresh are predominantly the blocks the log says changed); or carry the floor from the first arm on the request so the repo knows this specific block is expected at *r*.

The first arm is the one that makes the class unrepresentable to the reader; the second reduces how often the first has to fire. `backlog/feat-refresh-can-demand-a-revision-floor` is the general, wire-level form of the second arm and lists the open design questions; this ticket is the concrete instance where the floor is already known on the client and a wrong answer is already detectable without any protocol change.

## What this is not

- Not the corroboration deadlock (`complete/1-repair-deadlock-is-never-named`): no `no-quorum` and no `repair-deadlock` line for either block in the failing window; when the repair finally ran it succeeded first time.
- Not a fork: B's context advances along the same lineage as A's and C's (no `collection:lineage-divergence`, no `collection:context-not-lowered`, no `collection:context-short-of-tail` in a run with `optimystic:db-core:collection` enabled). B is *ahead* in what it knows about the log and *behind* in one block's content.
- Not commit-side freshness arming (`complete/a-reader-cannot-tell-its-view-stopped-advancing`): the stamp in play was earned by a consult.
- Not routing as such: self-coordinating a block one is a cohort member for is intended. The defect is that a too-old answer is indistinguishable from a good one to the component that could tell them apart.

## Reproducing downstream

In `../sereus/packages/integration-tests` (needs `@serfab/cadre-core` built, and this repo's `dist` fresh — sereus refuses to run when any `src` here is newer than `dist`):

```
DEBUG='optimystic:db-p2p:*,optimystic:db-core:collection*,sereus:cadre:node' DEBUG_COLORS=0 \
  npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

Failure fingerprint: `Timeout waiting for B resolves C's signed CadrePeer address record after 45000ms`. Measured 2026-09-17: 2 of 6 cold single-file runs failed (1 of 1 untraced, 1 of 5 traced); 12 of 12 boots of the same helper repeated inside one warm process passed. Intermittent, so loop it — and make the loop look for a positive pass marker: a stale-build abort prints neither pass nor the failure string, which voided a further 54 "passes" in that session.

In a trace, B is the second `Control node started with ID` line. `db-p2p:storage-repo` and `block-storage` lines carry no peer id; attribute through the peer-tagged `libp2p-key-network:<peer>` and `coordinator-repo:<peer>` lines around them. The tell is B's `findCoordinator:start key=<base64 of the data block id's first 9 characters>` — it stops appearing while `resolvePeerAddrs: signature verification failed … addrs=[]` keeps repeating. The two traces this ticket was written from are `../sereus/tickets/.logs/control-peer-row-refresh.failing-trace.log` and `…passing-trace.log`; that directory is pruned after 14 days, which is why the evidence is quoted above rather than referenced.

Upstream cannot run the downstream scenario as part of its own suite, so the acceptance test here should be the db-core unit property; the downstream ticket owns re-running the scenario after a release.

## TODO

- Write the failing db-core spec first: a test transactor that serves the tail at revision *r* with an entry naming block X, and serves X materialized at *r − 1* for a read pinned at *r*; assert the collection does not return or cache that content.
- Decide and implement what the reader does with a below-floor answer (retry with the answering coordinator excluded; then `BlockPossiblyStaleError`), keeping `CacheSource` free of below-floor content on every path including the replay inside `updateInternal`.
- Decide whether the db-p2p arm is done here or left to `backlog/feat-refresh-can-demand-a-revision-floor`; if left, say so in that ticket.
- Add a spec in `packages/db-p2p/test` for the window case if the db-p2p arm is taken: block present at local revision 6, stamped fresh, read pinned at 7 above the stamp's known revision → consult fires.
- Update `docs/transactions.md` § *Lazy read-repair window* — it lists what arms the window and says nothing about a pinned read that proves the collection has moved.
- Note the outcome in `../sereus/tickets/blocked/control-peer-row-refresh-invisible-to-third-node.md` so the downstream re-measurement gets scheduled.
