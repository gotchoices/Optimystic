description: When one change touches several collections and its retry ends up saving some of them but not others, the caller used to be told only that the change failed, so the application rolled back as if nothing had been saved. Every failure after part of the change is saved is now reported as a partial save that names what was saved; review that change.
files:
  - packages/db-core/src/transaction/coordinator.ts (`commit`, new `commitAttempts`, `refreshBetweenAttempts`, `reportSaved`, `stagedCollections`, the `CommitCycle` type; `commitOnce` now takes the cycle)
  - packages/db-core/src/collection/collection.ts (new `RefreshReport` type, new `refreshInFlight(report)`, `updateInternal(report)` fills the report; `syncAttempts` reads it)
  - packages/db-core/src/transaction/errors.ts (doc comments on `CoordinatorPartialCommitError` and `CoordinatorStaleLossError`)
  - packages/db-core/src/collection/struct.ts (`TornActionError` doc comment)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts (new and strengthened cases)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (unchanged; the consumer that relies on the partial report)
  - docs/internals.md, docs/transactions.md, docs/correctness.md (Theorem 3)
difficulty: medium
----

# What changed

`TransactionCoordinator.commit` commits one transaction across several collections (the participants). Between attempts it refreshes each collection. That refresh can find a participant's own log entry (an attempt reported a loss, but the participant's log tail was stored), finish the participant's remaining blocks, and drop its staged actions. The participant is then saved. Before this change, any failure after that point left `commit()` as a bare error (`TornActionError`, `CoordinatorStaleLossError`, an abort error, and so on). The Quereus bridge treats every error other than `CoordinatorPartialCommitError` as "nothing was saved, roll back", and a `CoordinatorStaleLossError` explicitly invites a re-drive that would log the saved participant twice.

## How the refresh reports what it saved

- `Collection.updateInternal` now takes a `RefreshReport` object and fills it in as it goes. `report.ownEntryFinished` is set right after `completeOwnEntry` returns, before the entry is consumed, so a refresh that throws later (the invalidation read, the replay) still reports the save. Its `durability` is who holds the write, and it is absent on the status-read fallback (every block already held the write, nothing was re-sent). "Saved" is tested on the field, not on `durability`.
- I chose a filled-in object over the ticket's suggested return value because a return value is lost when the refresh throws after finishing.
- New `Collection.refreshInFlight(report)`: the same latch handling as `update()`, with a required report. The coordinator uses it. Readers' `update()` passes a throwaway `{}`, and `ICollection.update()` is unchanged.
- `syncAttempts` reads `report.ownEntryFinished?.durability` exactly where it used to read the returned durability, so single-collection sync behaves as before.

## How the coordinator uses it

- A `CommitCycle` object is created once per `commit()`. It holds the in-flight disposers (previously a bare array), `participants` (every collection any attempt included, added in `commitOnce`), and `saved` (collections a refresh finished).
- The old loop body moved into `commitAttempts`. `commit()` has one `catch` that calls `reportSaved`. If `saved` is empty, the error passes through untouched. Otherwise it becomes `CoordinatorPartialCommitError(committed = saved ∪ the error's own committed set when it is already a partial error, failed = participants − committed, reason = the original error)`, and the stamp is released. A partial error is merged, never wrapped twice, and its `reason` is kept.
- `refreshBetweenAttempts` visits every registered collection even after one throws. It then throws the first error that is not `completion-refused`, or returns the first `completion-refused` error so the existing retry round handles it. This fixes the ordering hole: registering B before A used to leave A unfinished.
- After a successful refresh round, if something was saved and no collection has anything staged, `commit()` releases the stamp and returns at once. **This also fixes a leak I confirmed:** before, the next attempt's "nothing to commit" return never released the stamp, so a transaction the refresh saved completely left the coordinator refusing every later stamp with `CoordinatorConcurrentStampError`. I checked this by disabling the new return, which makes the new stamp assertion fail. I used "nothing staged" rather than "every participant saved" so that actions staged onto a saved participant after its attempt began still get committed by the next attempt.

# Validation

- `yarn test` in packages/db-core: 1718 passing, 0 failing.
- `yarn build` in db-core, then `yarn test` in packages/quereus-plugin-optimystic: 966 passing, 13 pending, 0 failing, smoke test OK. No bridge test depended on a bare refresh error being mapped to a unique-constraint error.
- `npx eslint` on the changed files: clean. `yarn lint:docs`: all citations resolve.
- Mutation checks, run by hand and then reverted:
  - With `reportSaved` forced to always pass the error through, the 4 new partial-report cases fail.
  - With the early return disabled, the stamp-release assertion fails.

## Test cases (coordinator-own-action-replay.spec.ts)

- "one participant finished and another torn for good is reported as a partial commit", run with refresh order A then B **and** B then A. Checks: partial error with committed [A], failed [B], `reason` a `TornActionError` (`rival-holds-revision`, collection B). A's blocks all landed, A has nothing staged, A is logged once. B's block is unlanded and B is still staged. The stamp is released.
- "nothing saved: every participant torn for good still fails with the bare torn error". A rival takes both collections, and the error stays a bare `TornActionError` naming A (the first one visited).
- "one participant saved by the refresh and another losing until the budget runs out". Partial error with `reason` a `CoordinatorStaleLossError`, exactly `maxAttempts` losses, no second log entry or revision for the saved participant, and the stamp is released. The `TearsOneLosesOtherTransactor` fixture gained `losses` and `onLoss` parameters.
- "an abort after a participant was saved is reported as a partial commit". An abort signal fires on the second loss, and `reason` is the abort error.
- "finishes every half-landed participant of a multi-collection commit" now also asserts that the stamp is released.
- The single-collection "refuses by name" and "gives up as a TORN commit" cases still pin the unchanged bare errors when nothing was saved.

# Known gaps for the reviewer

- **Local state of an unsaved participant after a replay throw.** A refresh can throw in the middle of `replayActions` on a participant that was not saved, for example a guarded insert whose key a rival took (`TreeKeyTakenError`). That participant's tracker is then only partly replayed, while its pending list is intact (see the existing NOTE in `updateInternal`). Before this change the bridge's clean rollback restored its snapshot. Now, if another participant was saved, the bridge takes the partial path and restores nothing. The error's doc says the failed collections' state is "reverted for retry", which is not strictly true in this sub-case. No test covers it. It is also the case where a unique-constraint refusal no longer becomes the plain UNIQUE message, which the ticket says is intended.
- **Arms not tested one by one:** deadline exhaustion (`throw lastLoss`), an expired transaction, a hard error from a later attempt, `CollectionHeaderVanishedError` from a non-participant, and merging a later attempt's own partial error with the refresh-saved set. All of them leave through the same single `catch`. Only exhaustion, abort and torn are exercised.
- **`failedCollections` can be empty**, when a failure comes after every participant was saved (for example a refresh that finished its entry and then threw). This is documented on the error. The message still reads "was not atomic".
- **`consumeOwnEntry`'s guard throw** ("entry longer than pending") happens after finishing. The participant is reported saved, which is correct for storage, but its pending actions are not dropped locally. This is an invariant-violation path and is untested.
- **Unverified, possibly pre-existing: the stamp may also stay open after a first attempt with nothing staged at all.** `commitOnce`'s `if (collectionData.length === 0) return;` does not release the stamp. I fixed only the refresh-saved path. I did not check whether a read-only session transaction that opened a stamp through the pre-stage `applyActions([])` barrier reaches this. If it does, the next stamp on that coordinator would be refused.
- **Refresh cost.** Because the refresh no longer stops at the first throw, an unreachable cluster costs one failed read per registered collection instead of one. Recorded as a NOTE on `refreshBetweenAttempts`.
