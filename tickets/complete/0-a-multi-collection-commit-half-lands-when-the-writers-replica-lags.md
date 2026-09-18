description: A transaction that writes several collections at once could save some of them and permanently lose the rest when the writer's own machine was behind on one of them, as on a node that has just joined. The commit phase now keeps trying to finish the collection it lost, the way a single-collection write already does, instead of giving up at the first refusal. Implemented, reviewed, and accepted downstream; unblocks the release planned for the morning of 2026-09-18.
architecture: docs/transactions.md#session-mode-distributed-commit-is-not-atomic-across-collections-either
files:
  - packages/db-core/src/transaction/coordinator.ts (the fix: the partial-commit branch of `commitOnceLatched` records the committed siblings in `cycle.saved` and throws `CoordinatorStaleLossError` when every failure was a returned refusal; review added a NOTE there on why the committed sibling's refresh is inert, a NOTE tripwire at `execute()`'s partial fold, and a wording fix in `commitCollection`'s NOTE)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorStaleLossError` message no longer asserts nothing committed; `CoordinatorPartialCommitError.reason` doc)
  - packages/db-core/src/transactor/network-transactor.ts (`staleFromBatches` carries `reason` and `conflict`, mirroring `pend`)
  - packages/db-core/test/transaction.spec.ts, packages/db-core/test/coordinator-rollback-pending.spec.ts, packages/db-core/test/coordinator-single-stamp.spec.ts, packages/db-core/test/network-transactor.spec.ts
  - packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts (the reproducer)
  - docs/transactions.md, docs/internals.md, docs/debugging.md, packages/db-p2p/src/repo/coordinator-repo.ts (comment), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (comments)
  - tickets/backlog/debt-multi-collection-retry-cannot-see-the-taken-revision.md (review appended an evidence arm)
difficulty: hard
repro: verified
----

# A multi-collection commit half-lands when the writer's replica lags — complete

## What shipped

One behavioural change in `TransactionCoordinator.commitOnceLatched` (`packages/db-core/src/transaction/coordinator.ts`). When the commit phase lands some collections and is refused on others, and every refusal was one the cluster *returned* (a member behind on the block's base answering the durability gate's `commit-not-durable`, a solo node's `missing-base-revision`, or a rival that took the revision slot), the attempt now records the committed collections as saved and throws the internal stale-loss signal. The existing retry loop then backs off, refreshes every collection, and re-attempts. The refresh finishes the refused collection's own log entry where its tail landed, or the next attempt re-pends it afresh, and each attempt commits only what is still staged, so the durable siblings are never re-logged. A refusal that never clears within the budget is reported as `CoordinatorPartialCommitError` naming the committed set, with the stale-loss error as its `reason`. A partial landing on a hard failure (thrown transport fault after three tries, structural rejection) still drops the stamp and reports at once.

`NetworkTransactor.staleFromBatches` now carries the producer's `reason` and `conflict` through a rebuilt commit failure, so the coordinator's error text names the real refusal instead of a generic "stale commit".

Session mode goes through the same `coordinator.commit`, so it gets the same recovery. `coordinator.execute()` has no retry loop and is unchanged; see the review findings for why that is acceptable today.

## Review findings

### What was checked

- The implement-stage diff in full (`git show 7253862e`), read before the handoff.
- The retry loop (`commitAttempts`), `refreshBetweenAttempts`, `stagedCollections`, `reportSaved`, `commitOnce`, `commitOnceLatched`, `coordinateTransaction`, `commitPhase`, `commitCollection`, `cancelPhase`, and the `execute()` partial fold.
- `Collection.updateInternal`, `completeOwnEntry`, `consumeOwnEntry`, `recordCommitted`, `beginInFlightAction`, `retainInFlightAttempt`, and `Log.getFrom`, to settle the handoff's open question about the committed sibling's refresh.
- Every re-pointed test (nine) and the three new arms, judged individually below.
- Production callers of `coordinator.execute()` in optimystic and in `../sereus` (read-only).
- The member side of a re-pend: `StorageRepo.pend`'s `isOwnRevision` handling for a block already committed under the same action and revision, and the shapes of the `commit-not-durable` and `missing-base-revision` refusals.
- Docs: `docs/transactions.md`, `docs/internals.md`, `docs/debugging.md` against the new behaviour.
- The open board for tickets already claiming these files.

### Gates run in this pass

| Gate | Result |
|---|---|
| `@optimystic/db-core` `yarn test` | 1805 passing, 0 failing |
| `@optimystic/quereus-plugin-optimystic` `yarn test` | 997 passing, 13 pending |
| the reproducer, 3 runs | 3 passing |
| root `yarn lint`, `yarn lint:docs`, `yarn typecheck` | pass (lint and typecheck re-run after the review's comment edits) |
| sereus `strand-removal-cuts-network.integration.ts`, 3 runs against the rebuilt `dist/` | 3 of 3 runs passing, 3 tests each; "leaves an open strand alone" passed every run (it failed 3 of 3 before the fix) |
| sereus `strand-membership-closed-strand-e2e.integration.ts`, 1 run | 9 passing |

The sereus tree was only read and run; nothing there was edited, committed, or built. Sereus links its `@optimystic/*` dependencies straight at this repo's package folders, and `packages/db-core/dist/src/transaction/coordinator.js` was confirmed to contain the fix (`partial-retry`, and the rebuilt `staleFromBatches`) before the runs. `dist/` was not rebuilt in this pass: the review's edits are comments only.

No pre-existing failure surfaced; `tickets/.pre-existing-error.md` was not written.

### The nine re-pointed tests

Each one now asserts the new contract or asserts more than before; none asserts less.

- `transaction.spec.ts` "should cancel pended collections when commit fails for one collection": was `cancelledActions.length > 0`; now exactly one cancel per attempt, every cancel targets only the refused collection's blocks, and the committed collection's blocks are never cancelled. Stronger.
- "should handle transactor becoming unavailable during cancel phase gracefully": the old assertion (`instanceOf(Error)`) and its comment claimed the cancel fault propagates, but `cancelPhase` has always logged and swallowed cancel faults, so the old test only proved the commit failed. It now asserts the error is the partial-landing signal, that the cancel fault does not replace the commit refusal in the message, and that cancel was attempted. Stronger and now true to the code.
- "should do forward recovery and targeted cancel on partial commit failure": commit calls went from 2 to 1 + 3 attempts, cancels from 1 to 3, the error from any failure to `CoordinatorPartialCommitError`. A contract change, and the right one: the refused collection is re-driven alone, and the committed one is neither re-committed nor cancelled. Still pins no orphaned pending records.
- Session mode "durably commits one collection, permanently fails another, and reports the partition honestly": only a small budget was added; every assertion on the committed and failed halves and the stamp is unchanged.
- "re-driving commit() after a partial landing" became "the coordinator's own retry after a partial landing re-attempts only the failed collection": the caller's manual second `commit()` is now the coordinator's own second attempt; the load-bearing assertion, `durableCommits` equal to `['users', 'posts']` (the winner produced no second durable commit), is unchanged.
- "a PARTIAL landing throws and is NOT auto-retried" was split into "refused twice then accepted lands the whole transaction" and "refused forever is reported once the budget ends". Both pin commit-call counts and one log entry per collection; the second also pins the loser still staged and the stamp released. Stronger.
- `coordinator-rollback-pending.spec.ts` "stays a no-op after a partial landing dropped the stamp" and `coordinator-single-stamp.spec.ts` "a partial commit drops the stamp": only a small budget added; the stamp-release assertions are unchanged and now cover the later release point.
- `network-transactor.spec.ts` "carries reason, conflict and staleAt": now asserts the reason and the conflict flag survive, where it used to assert the reason was dropped. Stronger.

### The double-apply question

The retry is not gated on `conflict`, so a permanent returned refusal costs the ordinary budget before being reported. That is slower, not harmful, for these reasons, each covered by a test:

- Re-applying a staged action onto a sibling that already committed: `clearPendingActions` and `tracker.reset` run for every committed participant before the throw, so `stagedCollections()` excludes it on the next attempt. Pinned by "the winner logged exactly once" in both new transaction.spec.ts arms and by `durableCommits` in the session-mode arm and the retry arm.
- The committed sibling's refresh between attempts: its in-flight mark stays set until the cycle ends, so the blanket refresh walks its log, but `recordCommitted` advanced its held revision to the entry's own and `Log.getFrom` is exclusive of the held revision, so the own entry never comes back, `consumeOwnEntry` is unreachable, and no attempt was retained for it. This settles the handoff's open question; recorded as a comment at the partial-retry site in `commitOnceLatched`.
- Re-pending over a block a member already committed under this action and revision: `StorageRepo.pend` treats that as the writer's own work (`isOwnRevision`), and `NetworkTransactor.commit` stores the log tail first, so the refresh's `completeOwnEntry` path covers the tail-landed case. The reproducer exercises exactly this on a real two-node cohort and passed 3 of 3.
- Re-pending over a pending record a failed cancel stranded: the re-pend is refused as a pending conflict, which is a returned refusal, so the loop runs to the budget and reports the same partial error. Not pinned beyond "the cancel fault does not replace the commit refusal" (the implementer flagged this); both routes end in the same report.

### `execute()` is untouched, and why that is acceptable

No production caller reaches `coordinator.execute()`'s own coordination. The plugin's session mode stages through `session.execute`, which calls `coordinator.applyActions`, and commits through `session.commit`, which is `coordinator.commit`. Sereus's writers (`control-database.ts`, `strand-membership-writer.ts`) commit through the plugin's `db.commit()`, so the join and reconciler flows go through the fixed path; the sereus acceptance runs above confirm it. `execute()` has no retry loop at all, not even for a clean stale loss, so a multi-collection write through it on a lagging member would still half-land. Recorded as a NOTE tripwire at the `execute()` partial fold, pointing a future caller at `commit()`'s retry rather than a second recovery; `docs/transactions.md` already says `execute()` is not retry-wrapped.

### Minor findings, fixed inline

- The NOTE in `commitCollection` said a returned commit failure "means the revision slot moved"; it now also names the lagging-member refusals (`commit-not-durable`, which sets `conflict`, and a solo node's `missing-base-revision`, which does not) and says why gating on `conflict` there would fail the latter fast.
- A comment at the partial-retry site now states the invariant that keeps the committed sibling's refresh inert (above), so the next reader does not have to re-trace `Log.getFrom`.

### Major findings

None. The one class-level concern, a permanent returned refusal spending the whole budget before the split is reported, is already owned by `backlog/debt-multi-collection-retry-cannot-see-the-taken-revision`. This review appended an update to that ticket: `staleFromBatches` no longer drops `staleAt`, `reason` or `conflict` (so the stall rule it asks for now has its data), and the partial-retry branch is a second shape its fail-fast rule must cover.

### Tripwires recorded

- `coordinator.ts`, `execute()` partial fold: NOTE that `execute()` has no retry and no production caller; route a future multi-collection `execute()` caller through `commit()`.
- `coordinator.ts`, `commitCollection`: the existing NOTE on where to gate on `conflict` if a producer ever returns hard commit rejections as results, now with the refusal shapes that must keep clearing.
- `coordinator.ts`, partial-retry branch: the invariant (held revision advanced, `getFrom` exclusive) that makes the committed sibling's refresh a reader's walk; if `Log.getFrom` ever becomes inclusive or `recordCommitted` stops advancing the held revision, `consumeOwnEntry` becomes reachable for an already-committed participant.
- `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold` stays open: the `reconcile:no-rev-quorum` race in the reproducer's trace is a legitimate refusal the coordinator now survives, not something this fix removes.

### Considered and declined

- Gating the partial-retry branch on `isConflictFailure`: declined for the reason recorded at `commitCollection`; a solo node's `missing-base-revision` carries no `conflict` flag and does clear.
- A mesh-level session-mode reproducer: session mode is covered by the db-core doubles as the fix ticket asked, and sereus's own scenarios exercise it end to end on a real two-node strand.
- Pinning which route the stranded-pending case takes in `TestTransactor`: both routes produce the same report; a pin would encode the double's conflict policy, not a contract.

## Decisions carried from implement

- Forward recovery over catch-up-before-pend or cross-collection prepare; the retry loop, the retained attempt and `completeOwnEntry` are reused.
- A partial landing that never clears costs the ordinary retry budget (about 21 s at the defaults) before it is reported. A caller wanting the old fail-fast passes a small `maxAttempts`.
- `CoordinatorPartialCommitError.reason` is a `CoordinatorStaleLossError` in the retried case. No consumer in this repo reads `reason`.
