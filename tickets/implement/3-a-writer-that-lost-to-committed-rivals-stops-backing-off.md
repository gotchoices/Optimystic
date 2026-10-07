description: A writer that has lost several times in a row to writes that already landed keeps sleeping longer and longer between attempts, which only delays it further. Once the storage machines hold a slot for such a writer, it should retry at once so the held slot is not spent sleeping.
prereq: slot-hold-for-an-aged-writer
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-core/src/collection/collection.ts (`syncAttempts`: the backoff before the refresh, `lastFailureConfirmedStaleAt`, `consecutiveFailures`)
  - packages/db-core/src/collection/struct.ts (`SyncOptions` doc comment on the backoff fields)
  - packages/db-core/src/transaction/transaction.ts (`SlotHoldAfterLosses`, from the prerequisite)
  - packages/db-core/test/collection-sync-retry.spec.ts or wherever the sync backoff delays are pinned with an injected `rand` (grep `baseBackoffMs` under packages/db-core/test)
  - docs/transactions.md (the retry policy paragraph that names the shared default backoff), docs/correctness.md (Theorem 9, the sentence pairing aged priority with backoff and jitter)
difficulty: easy
----

# A writer that lost to committed rivals stops backing off

## Why

The jittered exponential backoff in `Collection.syncAttempts` exists to separate a herd of writers that lost the same race, so they do not re-collide on the next tick. The plan-stage measurement for `slot-hold-for-an-aged-writer` showed the other case: a writer losing not to a herd but to a stream of rivals that each committed before its attempt arrived. There the sleep buys nothing (removing it changed the outcome only in how fast the write gave up), and once the members hold a slot for the writer the sleep actively spends the hold. With the default schedule the sleep after the sixth loss is already 1.6 to 3.2 s, against a default hold window of 3 s.

## The rule

In `syncAttempts`, when the failure just handled carried a confirmed `staleAt` (`lastFailureConfirmedStaleAt`, meaning a rival's revision is durably committed, not merely pending) and `consecutiveFailures` has reached `SlotHoldAfterLosses`, the backoff before the next refresh is zero. Every other failure keeps the jittered backoff: a `held` or `conflict` refusal without a confirmed revision is a race against something still in flight, and backing off there is still right.

The threshold is the same constant the member counts to, so the writer stops sleeping on exactly the loss after which a member holds for it. Nothing is signalled over the wire; the two sides agree by construction.

## Edge cases & interactions

- **Members that do not hold** (previous release, or `slotHoldWindowMs: 0`). The writer retries without sleeping and fails after the same ten attempts, sooner; measured in the plan stage as about twice the pend rate of one writer. Accepted and noted at the site.
- **The stall check.** `maxStalledAttempts` fires on a refresh that moves nowhere against a confirmed revision and is independent of the sleep; a zero backoff reaches it sooner, which is the intent of both.
- **The deadline and abort signal.** Checked at the top of every iteration as today; a zero backoff still calls `abortableDelay(0, signal)` or skips it, either way an aborted sync rejects promptly.
- **The multi-collection coordinator loop** (`TransactionCoordinator.commit`) cannot apply the rule: its `CoordinatorStaleLossError` has no `staleAt` (backlog `debt-multi-collection-retry-cannot-see-the-taken-revision`). An arm appended to that ticket says to apply this rule there once the revision survives. Until then that loop keeps its backoff, and the hold window covers its first few sleeps.
- **Interaction with the retained attempt and own-entry completion.** None: the sleep is before the refresh and the refresh is unchanged.

## Tests

- One test in the existing sync backoff spec with an injected `rand` and a transactor that answers `success: false` with `staleAt` every time: the first `SlotHoldAfterLosses - 1` retries sleep by the pinned schedule, the ones after sleep zero. A second case with the same count of `conflict: true` failures carrying no `staleAt` keeps sleeping. Expected outputs are the delays, asserted through a fake timer or the recorded `setTimeout` arguments the spec already uses.

## TODO

- Implement the zero-backoff branch in `syncAttempts` beside the existing `jitteredBackoffMs` call, with a comment naming the herd case the backoff still serves.
- Update the `SyncOptions` doc on `baseBackoffMs` and `maxBackoffMs` to say when they do not apply.
- Add the two test cases.
- Append the arm to `tickets/backlog/debt-multi-collection-retry-cannot-see-the-taken-revision.md`.
- Update the retry policy sentence in docs/transactions.md and the backoff-and-jitter sentence in Theorem 9.
