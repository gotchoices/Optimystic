description: Saving one row in a two-machine group sends the other machine nine separate consensus messages: three rounds (reserve, commit the history, commit the data), each made of three back-and-forths. Over a relay each costs a round trip, so an insert takes seconds. Two changes could cut this roughly in half, but each loosens a safety rule the commit protocol relies on today.
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`executeTransaction` ~line 538, `collectPromises`, `commitTransaction`, `broadcastMergedRecord`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (member side: `update`, `getTransactionPhase`, commit-vote signing, `applyConsensusOperation`)
  - packages/db-core/src/transactor/network-transactor.ts (`commit`: tail commit, then sweep commit of the remaining blocks)
  - packages/db-core/src/collection/collection.ts (`bootstrapContext` relies on "tail committed first"; `completeOwnEntry` / torn-write handling)
  - packages/db-p2p/src/storage/storage-repo.ts (`commit` apply order)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit durability gate uses each member's apply report)
tradeoffs: Both reductions touch the commit protocol's safety layering (blind commit votes, tail committed before other blocks), where a subtle mistake loses or forks writes. The saving is a constant factor per insert, which a local-network deployment will never notice.
----
# A single-collection commit pays three consensus rounds of three calls each

## Observed

Sereus headless two-party run: every insert opened **9** `/cluster` streams to the other member, whichever party wrote. With 150 ms added each way on the relay link, commits took 6–45 s. (Reads also contributed; see `refresh-of-an-unchanged-collection-refetches-the-same-blocks`.)

## Where the 9 come from (read from code)

Session-mode commit → `TransactionCoordinator` → per staged collection, one pend and then `NetworkTransactor.commit`, which commits the **log tail first** and then **sweeps** the remaining blocks. That makes 3 consensus operations. Each runs `ClusterCoordinator.executeTransaction`, which calls `update()` on every member three times, in sequence:

1. `collectPromises`: promise vote.
2. `commitTransaction`: commit vote. Members cannot apply yet, because the record they receive carries no commit signatures.
3. `broadcastMergedRecord`: members see the merged record, reach consensus, and apply.

3 rounds × 3 calls = 9 streams. The call to self runs in-process. Each extra staged collection or index tree adds another 9.

## Candidate reductions

1. **Coordinator signs its commit vote first.** In `commitTransaction`, run the local member's commit vote before contacting remotes, and include its signature in the record sent out. In a 2-member cohort, the remote then holds a super-majority on receipt and can apply immediately, so the broadcast round is unneeded for any member whose response says it applied. Saves 1 call per round (9 → 6).
   - **Risk:** members sign commit votes blind (`getTransactionPhase`), so a member applying on receipt must itself verify the promise super-majority first. Reconcile relies on the coordinator applying locally first. The durability gate needs every member's apply report, which must then come from the commit response.
2. **Merge the tail and sweep commits into one round.** Send all blocks in one commit operation, and have `StorageRepo.commit` apply the tail block first. Saves a full round (another 3).
   - **Risk:** "the tail is committed before any other block" is what lets `bootstrapContext` trust the tail, and what torn-write handling assumes (`cancelAbandonedSweepBlocks`, `completeOwnEntry`: the tail's fate is known separately from the sweep). With a single round, a partial apply on one member must still never expose a non-tail block without its tail.
3. Promise and commit folded into a single record for single-collection commits in small cohorts. This breaks the blind commit vote and content-digest-on-promise layering. Listed only as the direction a redesign would take.

# Evidence, 2026-09-17: now the dominant cost (sereus remeasure at `012573a2`)

After the refresh and rebalance fixes, sereus measured a two-party relay strand with 150 ms added each way. Reads take 0.6–2.5 s, but inserts still take 9–10 s, once 38 s. With no delay an insert is 9 `/cluster` streams and 40–51 exchanges on A. B's burst about 25–30 s after joining was 45 `/cluster` streams for 5 commits. Report: `../sereus/tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md`. Over a phone-grade link, commit round trips are now what an application feels.
