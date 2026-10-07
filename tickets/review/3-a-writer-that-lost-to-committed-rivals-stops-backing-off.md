description: A writer that has lost several times in a row to writes that already landed now retries at once instead of sleeping, so the slot the storage machines hold for it is not spent asleep. Review the rule, its edges, and the two tests.
prereq: slot-hold-for-an-aged-writer
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-core/src/collection/collection.ts (`retryBackoffMs`, and its call in `syncAttempts` with the `lostToCommittedRival` flag)
  - packages/db-core/src/collection/struct.ts (`SyncOptions.baseBackoffMs` / `maxBackoffMs` docs)
  - packages/db-core/test/collection.spec.ts (`bounded sync retry` → `staleAt on exhaustion` → `backoff once a member holds the slot`)
  - docs/correctness.md (Theorem 9, the slot-hold paragraph and the aged-priority sentence), docs/transactions.md (retry policy bullet)
----

# A writer that lost to committed rivals stops backing off — review handoff

## What changed

- `retryBackoffMs(failures, lostToCommittedRival, config, rand)` in `collection.ts` returns `0` when the failure just handled carried a confirmed `staleAt` and `failures >= SlotHoldAfterLosses` (3); otherwise the same `jitteredBackoffMs(failures - 1, …)` as before. The NOTE on it records the accepted cost against members that do not hold (old release, `slotHoldWindowMs: 0`): the same attempt budget is spent sooner.
- In `syncAttempts`, the refresh loop seeds `lostToCommittedRival` from `lastFailureConfirmedStaleAt` and clears it when a refresh is refused with `TornActionError('completion-refused')` — that refusal is a race against a pending rival, so the next sleep in that inner loop is jittered again.
- The sleep still goes through `abortableDelay(0, signal)`, so abort and deadline handling are unchanged (the deadline/abort checks at the top of the outer loop and in the inner catch are untouched).
- Docs: `SyncOptions` backoff fields say when they do not apply; Theorem 9's slot-hold paragraph now states the writer side as current, with the coordinator-loop exception; transactions.md's retry-policy bullet notes the one difference between `Collection.sync` and `coordinator.commit()`.
- The arm on `tickets/backlog/debt-multi-collection-retry-cannot-see-the-taken-revision.md` was already present (added by the plan stage); not duplicated.

## Tests added

- `stops sleeping after SlotHoldAfterLosses losses to a committed revision` — a transactor refusing every commit with `staleAt`; the injected `rand` records which failure each jittered sleep followed: `[1, 2]`, i.e. failures 3–5 sleep zero. Also asserts the constant is 3 so a change to it is a visible test edit.
- `keeps sleeping when the refusal confirms no committed revision` — same with `conflict: true` and no `staleAt`: `[1, 2, 3, 4, 5]`.

Observation is via `rand` call counts (it is consulted exactly once per jittered sleep, never on the zero branch), not fake timers; no spec in the repo recorded `setTimeout` arguments as the ticket assumed.

## Validation

- `packages/db-core`: `yarn test` — 1881 passing.
- `packages/db-core` rebuilt, then `packages/db-p2p`: `yarn test` — 3274 passing, 70 pending.
- `yarn lint:docs` clean.
- Not run: `yarn test:integration`, and `packages/db-p2p/test/aged-writer-slot-hold.spec.ts` outcome was not compared before/after (it passed in the full db-p2p run). A reviewer wanting evidence the zero sleep improves the measured shape could compare that spec's landing counts with and without the change.

## Known gaps / things to look at

- The completion-refused inner-loop path is not covered by a test of its own (clearing the flag there is a one-line judgment; covering it needs a half-landed-write double such as the ones in `own-entry-completes-the-action.spec.ts`).
- With zero sleep, the stall check (`maxStalledAttempts`, default 2) fires sooner in wall-clock terms for a wedged view; its strike count is unchanged, so outcomes are the same, only faster.
- `TransactionCoordinator.commit` keeps backing off until the debt ticket above lands.
