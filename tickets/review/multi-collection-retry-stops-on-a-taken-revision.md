description: When a write that spans several collections keeps losing to a revision someone else already committed, it now stops within a couple of attempts and says why, as a write to one collection already did. The confirmed revision is carried to the retry loop per collection, where it also floors the refresh's log-tail read and skips the backoff while a member holds the slot.
architecture: docs/internals.md#the-revision-context-is-monotonic
files: packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transaction/errors.ts, packages/db-core/src/transaction/entry-commit.ts, packages/db-core/src/transaction/index.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/transaction.spec.ts, packages/db-core/test/stale-failure.spec.ts, docs/internals.md, docs/transactions.md, docs/debugging.md, docs/correctness.md
difficulty: hard
----

## What was built

One shared rule. The stall and slot-hold evidence that lived inside `AttemptCycle` is now `RevisionStallWatch` in `packages/db-core/src/collection/write-attempts.ts`: one instance per collection per write, with `noteRefusal`, `noteRefusedRound`, `noteCommit`, `check(requestedRev)` (returns a `StallVerdict`: `clear`, `strike`, or `stalled`), `holdsSlot()`, `tailFloor()` and `staleAt`. `AttemptCycle` keeps its budget, its error classes and the `collection:sync-stalled` line, and delegates the evidence to one watch; `retryBackoffMs` is now "0 when the watch holds the slot, else jittered". `DefaultMaxStalledAttempts` (2) is exported from the same file and is the single default for both loops. The watch keeps two flags where the old code had one field plus a local: the attempt's own confirmation (read by the stall check, untouched by a refused refresh round) and the latest loss's confirmation (read by the slot hold, cleared by a refused round). That is exactly what `refreshUntilSettled`'s local variable did before, so the single-collection path is behaviour-neutral; the `bounded sync retry`, `stalled revision view` and `backoff once a member holds the slot` suites in `collection.spec.ts` pass unchanged.

Attribution. `staleAtOwner(staleAt, blocksByOwner)` in `packages/db-core/src/network/stale-failure.ts` answers which collection of a batch owns the block a confirmed revision names. The coordinator has two small wrappers beside `PendRejectedError`: `ownStaleAt` for a request of one collection (attributed without looking at the block id, as the single-collection loop does) and `batchStaleAt` for a batched answer (the owner only; nothing when no collection of the batch owns the block). The `NOTE:` on `highestStaleAt` now describes that rule instead of naming the backlog ticket.

Carrying the number. `PendRejectedError` keeps a `staleAtByCollection` map (its message is unchanged); `pendFailure` merges the conflicting pends' maps into `PendPhaseFailure.staleAt`. The refused arm of `CollectionCommitOutcome` carries `staleAt`, set by `collectionCommitOutcome` from an explicit argument: the answer's own number in `commitCollection`, the owner's share of the batched answer in `commitTogether`. `commitPhase` merges them; `coordinateAttempts` puts whichever phase's map on the failure arm of `CoordinationResult`; `cleanFailureError` and both partial-retry throws pass it to `CoordinatorStaleLossError`, which gained `staleAtByCollection` (default empty).

The loop. `RetryBudget` keeps a `Map<CollectionId, RevisionStallWatch>`. `assertNotStalled(actionId, driver.nextRevisions())` runs at the top of every loop turn, after `assertOpen` and outside the `try` that catches the stale loss, checking each participant in sorted collection-id order; a `strike` logs `commit:revision-stalled` under `trx:coordinator`, and the first `stalled` verdict throws `CoordinatorRevisionStalledError`. `recordLoss` notes each failed collection's refusal (with `undefined` for a collection refused without a number or cancelled beside a refused sibling) and drops the watch of any collection the loss did not name. `recordRefusedRound` calls `noteRefusedRound` on every watch. `pause()` sleeps 0 when any watch holds the slot (the `NOTE:` at the site gives the reason it is "any", not "all"). `tailFloor(id)` answers each participant's refresh floor. `AttemptDriver` gained `actionId`, `nextRevisions()` and a `tailFloor` argument on `refresh`; `commit` reads next revisions off `stagedCollections()` (unlatched, with the one-line comment the ticket asked for) and `commitEntry` off a new `EntryParticipants.nextRevisions()`. `RefreshParticipant.refresh` takes `tailFloor`, forwarded by `registeredRefreshers` to `Collection.refreshInFlight` and by `EntryParticipants.refreshers` to `HeadCommitHandle.refresh`.

The error. `CoordinatorRevisionStalledError extends CoordinatorStaleLossError` in `packages/db-core/src/transaction/errors.ts`, with `collectionId`, `staleAt` (the one confirmed revision), `requestedRev`, `heldRev`, `attempts`, `failedCollections` (every participant still to commit) and the base's `reason`. Its message reads like `SyncRevisionStalledError`'s and says neither "lost a stale race" nor "exhausted". It is exported beside `CoordinatorStaleLossError` and, being a subclass, is filed as `contention` by `classifyCommitFailure` with no change there. `commit`'s and `commitEntry`'s single catch wraps it in `CoordinatorPartialCommitError` when a participant is already saved, which is what fixes the partial-retry shape.

## One deviation from the ticket's naming

The ticket gives both the base class's map and the subclass's single revision the name `staleAt`. TypeScript will not let a subclass redeclare a property at an incompatible type, and the ticket's own test asserts `staleAt` on the stalled error deep-equals the refusal's single revision (matching `SyncRevisionStalledError.staleAt`). So the base class's map is `staleAtByCollection`, and `PendRejectedError`'s is the same name. The stalled error's `staleAtByCollection` holds its one entry. A reviewer who prefers another name for the map has one site per class to rename.

## Use cases to validate

- A multi-collection commit whose pend keeps being refused with a confirmed `staleAt` while the refresh moves that collection nowhere stops on the second strike (default) with `CoordinatorRevisionStalledError`, not after about twenty seconds of backoff.
- The same with a sibling already committed: `CoordinatorPartialCommitError` whose `reason` is the stalled error, the winner logged exactly once, the loser still staged.
- A batched refusal whose number names a block of `posts` never strikes `users`; `users` is treated as refused with no number.
- Bare refusals (`commit-not-durable`, `missing-base-revision`, an unclassified pend conflict) carry no number and keep the whole budget, as before: the existing "refused forever" tests in `transaction.spec.ts`, `coordinator-rollback-pending.spec.ts` and `coordinator-single-stamp.spec.ts` pass unchanged.
- A participant whose refresh moves it forward without clearing the confirmed revision resets its count (shared rule; covered by the single-collection suites).

## Tests added

- `packages/db-core/test/transaction.spec.ts`, "a clean loss whose refusal keeps confirming a taken revision stops as CoordinatorRevisionStalledError, not after the whole budget": a new `PendLossTransactor` double refuses `posts`'s pend forever with `{ conflict: true, staleAt: { blockId: 'hot-block', rev: 42 } }` under `maxAttempts: 10`. Verifies the error class and its `instanceof CoordinatorStaleLossError`, `collectionId`, `staleAt`, `requestedRev === 1`, `heldRev === undefined`, `failedCollections` sorted, the message wording, exactly 2 pends of `posts`, and nothing logged or committed.
- Same file, "a PARTIAL landing whose loser keeps confirming a taken revision is reported as CoordinatorPartialCommitError within maxStalledAttempts": `PartialLossTransactor` with the same confirmed refusal. Verifies committed `['users']`, failed `['posts']`, `reason` a `CoordinatorRevisionStalledError` for `posts` whose `failedCollections` is `['posts']`, `commitCalls === 3`, `users` logged once, `posts` still staged, the stamp released.
- `packages/db-core/test/stale-failure.spec.ts`, `staleAtOwner` case table: a block of the second collection maps to it, a block nobody owns maps to `undefined`, and no number maps to `undefined`.

No test for the tail-floor wiring, the backoff skip in the coordinator, or the `AttemptCycle` refactor, per the ticket: the first two were verified by inspection (below) and the refactor by the single-collection suites passing unchanged.

## Verified by inspection (the ticket's list)

- Unlatched `nextRevisions` in `commit`: only `getNextRev()` and `committedRevision()` are read; a concurrent refresh can only raise the former, which the check reads as progress.
- Deadline before stall: `assertOpen` precedes `assertNotStalled` on every turn.
- `nothingLeft` exit precedes the check: it sits at the end of the catch block and of the opening-refresh block, so a cycle whose refresh saved everything returns before the next turn's check.
- A participant saved mid-cycle leaves `stagedCollections()` / the handle set, so it is absent from the next `nextRevisions()` and its watch is dropped by the next `recordLoss`.
- A collection that joins in a later attempt gets a watch at its first check with no evidence, so no strike.
- `maxStalledAttempts >= maxAttempts` restores the whole-budget behaviour: `recordLoss` throws at `maxAttempts` before the check can reach the threshold.
- The opening refresh of `commitEntry` runs with no watches, so no floor and no sleep.
- Abort is checked first in `assertOpen`.
- Both batched call sites (`pendTogether`, `commitTogether`) attribute through `batchStaleAt` over the block ids they already compute.

## Known gaps and things worth a reviewer's eye

- Watches are created for every participant at its first check (not lazily at its first loss), so the "did the refresh move it" comparison has the previous attempt's requested revision from the start, exactly as `AttemptCycle.beforeAttempt` does. Creating them lazily at the first loss would have made a catching-up participant's first forward move count as a strike instead of a reset. Worth confirming the reviewer agrees that is the faithful reading of the ticket's "exactly `AttemptCycle.beforeAttempt`'s rule today".
- `pause()` reads the hold over the watches of the last attempt's participants. A refused refresh round clears every hold (`noteRefusedRound`), so the only moment a hold can be true is the pause right after a loss, when the watch set is exactly the participants still to commit. If a refresh round ever saves a participant AND leaves another's hold standing in the same round, the next pause would still honour the saved one's hold for one sleep; today that cannot happen because a saved participant's round is a successful round and no refusal preceded it in that round.
- The batched attribution has no db-core unit test with a `pendMany`/`commitMany` double; `packages/db-p2p/test/offline-queue-mesh.spec.ts` exercises the batched path on a real two-member cohort and passed, but it does not assert on attribution.
- `tickets/.garden-report.md` shows as modified in `git status`; I did not touch it, and left it alone per the working-tree rule.

## Validation run

- `packages/db-core`: `yarn test` — 2040 passing. The targeted `bounded sync retry|stalled revision view|backoff once a member holds the slot` run — 23 passing, unchanged.
- `packages/db-core`: `yarn build` then `yarn typecheck` from the root — clean.
- `packages/db-p2p`: `yarn test` — 3607 passing, 75 pending (env-gated).
- `packages/quereus-plugin-optimystic`: `yarn test` — 1204 passing, 14 pending, smoke ok.
- `yarn lint:docs` — 48 documents, all citations resolve.

## Docs updated

- `docs/internals.md`: the `commitEntry` bullet in §Staged actions are segments (tail floor now passed per participant), the §A block re-read after a refresh paragraph (the coordinator passes each participant its own floor), and the stall bullet in §The revision context is monotonic (one rule, per-participant application, attribution, the new error).
- `docs/transactions.md`: the retry-policy bullet no longer says the coordinator cannot see the confirmed revision; it says the coordinator stops on a wedge with `CoordinatorRevisionStalledError`.
- `docs/debugging.md`: a `trx:coordinator` row in the db-core sub-namespace table, and a `commit:revision-stalled` paragraph beside `collection:sync-stalled` in the write-path section.
- `docs/correctness.md`: the slot-hold paragraph's last sentence (the coordinator loop now skips the sleep too). Not in the ticket's list, but it named the backlog ticket as still open.
- Doc comments: `SyncOptions.maxStalledAttempts`, `Collection.refreshInFlight`, `RetryBudget`, `refreshBetweenAttempts` (NOTE removed), `highestStaleAt` (NOTE rewritten).
