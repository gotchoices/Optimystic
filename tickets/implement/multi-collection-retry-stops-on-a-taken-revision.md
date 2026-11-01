description: When a write that spans several collections keeps losing to a revision someone else already committed, it should stop within a second and say why, as a write to one collection already does. Today it retries for about twenty seconds, because the number it would need is thrown away before its retry loop sees it.
architecture: docs/internals.md#the-revision-context-is-monotonic
files: packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transaction/errors.ts, packages/db-core/src/transaction/entry-commit.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/transaction.spec.ts, packages/db-core/test/stale-failure.spec.ts, docs/internals.md, docs/transactions.md, docs/debugging.md
difficulty: hard
----

## Background

A writer submits a change at a revision number. When another writer already committed that number, the submission is refused, the writer re-reads, and tries again. Two loops do this, and they deliberately share one retry policy (the "Mirrors the single-collection sync default" comment above `DefaultMaxAttempts` in `packages/db-core/src/transaction/coordinator.ts`):

- `Collection.syncAttempts`, driven by `AttemptCycle` in `packages/db-core/src/collection/write-attempts.ts` (one collection; also `Collection.commitHead`).
- `TransactionCoordinator.commitAttempts` in `packages/db-core/src/transaction/coordinator.ts`, under `RetryBudget` (several collections; reached by `commit` and by `commitEntry`, the offline queue's per-entry commit).

The single-collection loop uses the revision a refusal confirms (`StaleFailure.staleAt`, set only by a producer that read it out of its own storage) for three things the multi-collection loop cannot do, because the number never reaches it:

1. **The stall check** (`AttemptCycle.beforeAttempt`). When the refresh moved the collection nowhere — the revision the next attempt would request is unchanged — and a responder confirmed a revision at or above it, the next attempt is byte-identical to the one that just failed. After `maxStalledAttempts` (default 2) such strikes it throws `SyncRevisionStalledError`. Any forward movement of the requested revision resets the count: a writer still catching up is behind, not wedged (a corrected bug — do not re-derive it).
2. **The tail floor** (`AttemptCycle.refreshUntilSettled` passes `lastStaleAt?.rev` into the refresh). `Collection.updateInternal` puts it on the log-tail read, so a coordinator that has not caught up to the rival is not the only machine asked and the write can land next time.
3. **The backoff skip** (`retryBackoffMs`). Once `SlotHoldAfterLosses` of a write's refusals confirmed a committed rival, and the latest one did, cohort members hold the next slot for this write, so the retry follows with no sleep.

In the multi-collection loop the number is lost at three seams: `PendRejectedError` folds `staleAt` into its message and keeps no field; `collectionCommitOutcome` drops `result.staleAt` from a stale commit refusal; and `CoordinatorStaleLossError` (`packages/db-core/src/transaction/errors.ts`) carries only `failedCollections` and a `reason` string. So `RetryBudget` spends the whole budget (~21 s at defaults) on a refusal settled on the first try, passes no tail floor to any refresh (the `NOTE:` on `refreshBetweenAttempts`), and always sleeps.

Two shapes are affected:

- **Clean loss**: nothing committed, every participant refused or cancelled, retried as `CoordinatorStaleLossError`.
- **Partial retry**: some participants committed and another was refused with a returned refusal; `commitOnceLatched` (and `commitEntryOnce`) record the committed ones in `cycle.saved` and throw `CoordinatorStaleLossError` to retry the rest forward. Pinned by `transaction.spec.ts` "a PARTIAL landing whose loser is refused forever is reported as CoordinatorPartialCommitError once the budget ends". The retry there must stay ungated on `conflict` (the `NOTE:` in `collectionCommitOutcome`): a bare `commit-not-durable` refusal carries no `staleAt` and does clear, and the stall check never strikes without a confirmed `staleAt`, so it stays covered.

## Design

### One shared rule: `RevisionStallWatch`

Pull the stall and slot-hold evidence out of `AttemptCycle` into one per-collection, per-write class that both loops use, so the rule exists once (the habit `isConflictFailure`, `highestStaleAt` and `isOwnRevision` follow in `packages/db-core/src/network/stale-failure.ts`). Put it in `packages/db-core/src/collection/write-attempts.ts` beside `AttemptCycle` (or a sibling file if that reads better), and export it for the coordinator.

```ts
type ConfirmedRevision = { blockId: BlockId; rev: number };   // StaleFailure['staleAt'] narrowed

type StallVerdict =
	| { kind: 'clear' }                               // progress, no evidence, or no news this round
	| { kind: 'strike'; strike: number; of: number; staleAt: ConfirmedRevision }
	| { kind: 'stalled'; strike: number; of: number; staleAt: ConfirmedRevision };

class RevisionStallWatch {
	constructor(maxStalledAttempts: number);
	/** A refused attempt of this collection: its own confirmed revision, or undefined. Highest wins
	 * across the write (highestStaleAt); counts a confirmed loss; marks whether THIS refusal confirmed. */
	noteRefusal(staleAt: ConfirmedRevision | undefined): void;
	/** A refresh round refused for a cause that can clear: the latest failure no longer confirms a
	 * committed rival, for the backoff only (the stall evidence is unchanged — as refreshUntilSettled does today). */
	noteRefusedRound(): void;
	/** Forward progress: stall evidence starts over. confirmedLosses is NOT reset (a member counts per action for its whole life). */
	noteCommit(): void;
	/** The check before an attempt that would request `requestedRev` — exactly AttemptCycle.beforeAttempt's rule today. */
	check(requestedRev: number): StallVerdict;
	/** Members hold the next slot for this write: latest refusal confirmed && confirmedLosses >= SlotHoldAfterLosses. */
	holdsSlot(): boolean;
	/** The highest confirmed revision, for the refresh's tail read. */
	tailFloor(): number | undefined;
	readonly staleAt: ConfirmedRevision | undefined;
}
```

`AttemptCycle` keeps its error classes, its budget and its log line (`collection:sync-stalled`) and delegates the evidence to one watch; `retryBackoffMs` becomes "0 when `holdsSlot()`, else jittered". The refactor must be behaviour-neutral for the single-collection path: the existing `collection.spec.ts` suites `bounded sync retry` and `stalled revision view`, and the backoff-skip tests from `a-writer-that-lost-to-committed-rivals-stops-backing-off`, pass unchanged. `DefaultMaxStalledAttempts` (2) stays the single default.

### Carry the confirmed revision to the loop, per collection

Revisions are per-collection counters, so the number is only meaningful against the collection that owns it. Carry a `ReadonlyMap<CollectionId, ConfirmedRevision>`:

- **Attribution helper** in `packages/db-core/src/network/stale-failure.ts`, beside `highestStaleAt`: `staleAtOwner(staleAt, blocksByOwner)` — given a confirmed revision and each candidate collection's block ids, the one collection whose blocks include `staleAt.blockId`, or `undefined`. Rules:
  - A request for **one** collection (`pendCollection`, `commitCollection`) attributes its `staleAt` to that collection without looking at the block id (the single-collection loop does the same; the `stalled revision view` tests use a block id the collection never wrote).
  - A **batched** answer (`pendTogether`, `commitTogether`) carries one `staleAt`, the highest across the batch's collections (`CoordinatorRepo.classifyStaleRejection` / `confirmCommitRivalAgainstLocal`). Attribute it only to the collection owning `staleAt.blockId` (via `blockIdsForTransforms(attempt.transforms)`); every other collection of the batch was refused with no confirmed number. No owner: attribute nothing. Rewrite the `NOTE:` on `highestStaleAt` to say the coordinator now attributes a batch's number by block id.
- **Pend side.** `PendRejectedError` keeps a `readonly staleAt: ReadonlyMap<CollectionId, ConfirmedRevision>` (message unchanged). `pendRefusalError` builds it (needs the attempts, or the block ids, for a batch). `PendPhaseFailure` gains the merged map, built in `pendFailure`.
- **Commit side.** The refused arm of `CollectionCommitOutcome` gains `staleAt?: ConfirmedRevision`, set by `collectionCommitOutcome` for the stale branch (only for the owner on a batched answer — `commitTogether` passes the attribution). `commitPhase` merges them into the map it returns.
- **Through the attempt.** `CoordinationResult`'s failure arm carries the map from whichever phase failed (`coordinateAttempts`). `CoordinatorStaleLossError` gains `readonly staleAt: ReadonlyMap<CollectionId, ConfirmedRevision>` (default empty), passed by `cleanFailureError` and by both partial-retry throws (`commitOnceLatched`'s `commit:partial-retry` branch and `commitEntryOnce`'s `commitEntry:partial-retry`).

### Use it in the multi-collection loop

`RetryBudget` (or a small companion it owns) keeps a `Map<CollectionId, RevisionStallWatch>`, created lazily with `options?.maxStalledAttempts ?? DefaultMaxStalledAttempts`.

- **After a loss** (`recordLoss`): for every collection in the loss's `failedCollections`, `watch.noteRefusal(loss.staleAt.get(id))` — `undefined` for a collection refused without a confirmed number, or cancelled because a sibling was refused, so it gets no strike that round. A collection the loss did not name (committed in a partial retry) is done: `noteCommit()` or drop its watch.
- **After a refused refresh round** (`recordRefusedRound`): `noteRefusedRound()` on every watch.
- **The stall check.** `AttemptDriver` gains `nextRevisions(): { collectionId; requestedRev; heldRev }[]` — the participants the next attempt would commit and what they would request. `commit`: `stagedCollections()` with `collection.getNextRev()` and `collection.committedRevision()`. `commitEntry`: the remaining handles' `nextRev()` and `heldRev()`. In `commitAttempts`, each loop turn runs `budget.assertOpen()` (deadline first, as on the single path), then the `nothingLeft` exit stays where it is, then checks each participant's watch in sorted collection-id order, **outside** the `try` that catches `CoordinatorStaleLossError` (otherwise the stall would be retried as a loss). A `strike` logs `commit:revision-stalled tx=%s collection=%s heldRev=%s requestedRev=%d staleBlock=%s staleRev=%d strike=%d of=%d` under `trx:coordinator`. The first `stalled` verdict throws `CoordinatorRevisionStalledError`.
- **The new error**, in `packages/db-core/src/transaction/errors.ts`: `CoordinatorRevisionStalledError extends CoordinatorStaleLossError`, with `collectionId`, `staleAt` (the one confirmed revision), `requestedRev`, `heldRev`, `attempts` (losses taken), and `failedCollections` = the participants still to commit. Its message reads like `SyncRevisionStalledError`'s ("this client holds rev …, would request rev …, but block … is confirmed committed at rev … and refreshing did not close the gap") and must not say "lost a stale race" or "exhausted". It subclasses the stale loss so existing catches keep working and `classifyCommitFailure` still files it as `contention` (the same choice `SyncRevisionStalledError` made by subclassing exhaustion). It escapes `commitAttempts` like any other error, so `commit`'s and `commitEntry`'s single catch (`reportSaved`) turns it into `CoordinatorPartialCommitError` with it as `reason` when a participant is already saved. That is what fixes the partial-retry shape.
- **The tail floor.** `RefreshParticipant.refresh` (in `packages/db-core/src/transaction/entry-commit.ts`) takes `tailFloor?: number`. `registeredRefreshers` forwards it to `Collection.refreshInFlight`, and `EntryParticipants.refreshers` forwards it to `HeadCommitHandle.refresh`; both already accept it. `refreshBetweenAttempts` passes each participant `budget`'s `tailFloor(collectionId)`, which is `undefined` for a non-participant and for any collection with no confirmed number. Remove the `NOTE:` saying no floor is passed, and the backlog reference in `Collection.refreshInFlight`'s doc.
- **The backoff skip.** `RetryBudget.pause()` sleeps 0 when the watch of any participant still to commit `holdsSlot()`. Otherwise it keeps the jittered backoff it has now. The rule is "any", not "all", because a member's hold lasts `slotHoldWindowMs` (3 s by default) against a backoff that grows to 5 s, so sleeping wastes a hold that is real now, while another participant's herd race is already handled by the aged priority. Put that reasoning in a `NOTE:` at the site.

### Docs (part of this ticket)

- `docs/internals.md`: the commitEntry bullet in §Staged actions are segments ("pass no tail floor (backlog … covers the slice too)"), and the paragraph in §A block re-read after a refresh … that says `TransactionCoordinator.commit`'s refresh "has none to pass today". Update both to describe the new behaviour. Also extend §The revision context is monotonic's stall bullet: the multi-collection loop applies the same rule per participant through `RevisionStallWatch` and throws `CoordinatorRevisionStalledError`.
- `docs/transactions.md` retry-policy bullet: delete "the coordinator loop cannot see the confirmed revision yet and keeps backing off", and say the coordinator stops on a wedge.
- `docs/debugging.md`: add `commit:revision-stalled` beside `collection:sync-stalled`.
- `SyncOptions.maxStalledAttempts` doc (`packages/db-core/src/collection/struct.ts`): say that `TransactionCoordinator.commit` and `commitEntry` read it too, per participant. The offline queue already forwards it to `commitEntry` (`OfflineQueueOptions.submit`).
- `RetryBudget`'s doc comment: drop the "cannot yet" sentence.
- Run `yarn lint:docs`.

## Edge cases & interactions

- **Catching up is not a wedge.** A participant whose requested revision rises without clearing the confirmed revision resets its count. This comes from the shared `check` and is covered by the existing single-collection tests, so it needs no new test.
- **A batch's number belongs to one collection.** A batched refusal whose `staleAt` names a block of `posts` must never strike `users`, which has a different counter. Test (the `staleAtOwner` unit test below), plus inspection of both batched call sites.
- **Unlatched read of the next revision** in `commit()`: `nextRevisions` runs between attempts with no latch held. A reader's concurrent refresh can only raise `getNextRev()` (`advanceContext` is monotonic), which reads as progress, so it can never manufacture a stall. `commitEntry` holds its handles' latches for the whole cycle. Verify by inspection, and put a one-line comment at `nextRevisions`.
- **Deadline before stall.** A commit past its deadline and also stalled reports the deadline (`assertOpen` runs first), as `SyncOptions.maxStalledAttempts` documents. Verify by inspection.
- **`nothingLeft` exit precedes the check.** A commit whose refresh saved everything returns success, never a stall. Verify by inspection.
- **Bare refusals never strike.** `commit-not-durable`, `missing-base-revision` and an unclassified pend conflict carry no `staleAt`, so they keep the whole budget, as today. The existing "refused forever" tests (`transaction.spec.ts`, `coordinator-rollback-pending.spec.ts`, `coordinator-single-stamp.spec.ts`) use refusals with no `staleAt` and must pass unchanged.
- **The partial-retry shape.** A participant committed, a sibling is refused with a confirmed revision forever. The result is `CoordinatorPartialCommitError` within `maxStalledAttempts` rounds, with `reason` a `CoordinatorRevisionStalledError`, the committed half logged exactly once, and the loser still staged. Test.
- **A participant saved mid-cycle** (a refresh finished its own entry, or it committed in a partial retry) leaves the participant set, and its watch no longer counts. Verify by inspection.
- **A collection that joins in a later attempt** (staged after the first attempt began) has no evidence yet and gets no strike. Verify by inspection.
- **`maxStalledAttempts >= maxAttempts`** brings back the old whole-budget behaviour on both paths, because the check can never reach its threshold first. Verify by inspection.
- **The opening refresh of `commitEntry`** runs before any loss, so it has no watch and no floor. Verify by inspection.
- **Abort** is still checked first in `assertOpen`, so an aborted commit never reports a stall. Verify by inspection.
- **Out of scope:** `TransactionCoordinator.execute` has no retry loop, so it is untouched. Making a wedged write *succeed* is reconciliation, backlog `feat-replay-mode-collections-merge-divergent-histories`. The tail floor is what turns the merely-behind case into a success.

## Tests (only these)

- `packages/db-core/test/transaction.spec.ts`, beside the PARTIAL-landing tests (reuse `makeMultiCollection` and the delegating doubles there):
  - **Clean stall.** `posts`'s PEND is refused forever with `{ success: false, conflict: true, reason, staleAt: { blockId: 'hot-block', rev: 42 } }`, and `commit(transaction, { maxAttempts: 10, baseBackoffMs: 1, maxBackoffMs: 5 })` runs. Expect a `CoordinatorRevisionStalledError`, which is also an `instanceof CoordinatorStaleLossError`, with `collectionId === 'posts'`, `staleAt` deep-equal to the refusal's, and `requestedRev === 1`. Expect exactly **2** pends of `posts`, against the 10 the budget allows, and nothing logged in either collection.
  - **Partial stall.** `PartialLossTransactor(inner, 'posts', Infinity, () => ({ success: false, conflict: true, reason: 'forced loss: posts', staleAt: { blockId: 'hot-block', rev: 42 } }))` with `maxAttempts: 10`. Expect `CoordinatorPartialCommitError` with committed `['users']`, failed `['posts']`, and a `reason` that is an instance of `CoordinatorRevisionStalledError`. Expect `commitCalls === 3`: two in attempt 1, then one more before the second strike. `users` is logged exactly once, and `posts` is still staged.
- `packages/db-core/test/stale-failure.spec.ts`: one `staleAtOwner` case table. A block of the second collection maps to the second collection, a block no collection owns maps to `undefined`, and an `undefined` `staleAt` maps to `undefined`.

The tail floor's wiring, the backoff composition and the refactor need no new tests: they are verified by inspection, and the refactor is checked by the existing single-collection suites passing unchanged.

## TODO

- Extract `RevisionStallWatch` from `AttemptCycle`, and switch `AttemptCycle` and `retryBackoffMs` over to it. Run `yarn test -- --grep "bounded sync retry|stalled revision view|backing off"` in `packages/db-core`, and confirm nothing changed.
- Add `staleAtOwner` to `stale-failure.ts`, with its unit test. Rewrite the `NOTE:` on `highestStaleAt`.
- Carry the per-collection map through `PendRejectedError`, `pendRefusalError`, `pendFailure`, `PendPhaseFailure`, `CollectionCommitOutcome`, `collectionCommitOutcome`, `commitTogether`, `commitPhase`, `CoordinationResult`/`coordinateAttempts`, `cleanFailureError`, and both partial-retry throws.
- Add `staleAt` to `CoordinatorStaleLossError`, and add `CoordinatorRevisionStalledError` to `errors.ts`. Export it beside `CoordinatorStaleLossError` in `packages/db-core/src/transaction/index.ts`.
- `RetryBudget`: add per-collection watches, update them in `recordLoss` and `recordRefusedRound`, add the stall check in `commitAttempts` (outside the stale-loss `try`), add `tailFloor(id)`, and add the slot-hold rule to `pause()`.
- `AttemptDriver.nextRevisions` for both `commit` and `commitEntry`. Add `tailFloor` to `RefreshParticipant.refresh`, and forward it in `registeredRefreshers` and `EntryParticipants.refreshers`.
- Add the two `transaction.spec.ts` tests.
- Update the docs listed above, and the `NOTE:`s and doc comments that name this backlog ticket: `RetryBudget`, `refreshBetweenAttempts`, `Collection.refreshInFlight`, `highestStaleAt`. Run `yarn lint:docs`.
- `yarn build` and `yarn test` in `packages/db-core`, then `yarn typecheck` from the root. The `quereus-plugin-optimystic` and `db-p2p` suites consume these errors, so run their tests too, after rebuilding db-core.
