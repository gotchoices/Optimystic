description: A transaction that writes several collections at once could save some of them and permanently lose the rest when the writer's own machine was behind on one of them, as on a node that has just joined. The commit phase now keeps trying to finish the collection it lost, the way a single-collection write already does, instead of giving up at the first refusal. Implemented and green on every gate; needs the review pass. This blocks the release planned for the morning of 2026-09-18.
architecture: docs/transactions.md#session-mode-distributed-commit-is-not-atomic-across-collections-either
files:
  - packages/db-core/src/transaction/coordinator.ts (the fix: the partial-commit branch of `commitOnceLatched` now records the committed siblings in `cycle.saved` and throws `CoordinatorStaleLossError` when every failure was a returned refusal; `commitOnce` threads the cycle; comments on `CommitCycle.saved`, `commit`, `commitCollection`)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorStaleLossError` message no longer asserts nothing committed; `CoordinatorPartialCommitError.reason` doc)
  - packages/db-core/src/transactor/network-transactor.ts (`staleFromBatches` carries `reason` and `conflict`, mirroring `pend`)
  - packages/db-core/test/transaction.spec.ts, packages/db-core/test/coordinator-rollback-pending.spec.ts, packages/db-core/test/coordinator-single-stamp.spec.ts, packages/db-core/test/network-transactor.spec.ts (the nine re-pointed tests and three new arms)
  - packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts (the reproducer, unchanged; failed at HEAD, passes now)
  - docs/transactions.md, docs/internals.md, docs/debugging.md, packages/db-p2p/src/repo/coordinator-repo.ts (comment), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (comments)
difficulty: hard
repro: verified
----

# A multi-collection commit half-lands when the writer's replica lags — implemented

## What changed

One behavioural site. In `TransactionCoordinator.commitOnceLatched` (`packages/db-core/src/transaction/coordinator.ts`), the branch for a commit phase that landed some collections and was refused on others used to throw `CoordinatorPartialCommitError` at once, and the retry loop in `commitAttempts` retried only `CoordinatorStaleLossError`. Now, when every refusal was a *returned* one (`coordResult.staleLoss`: a member behind on the block's base answering the durability gate's `commit-not-durable`, or a rival that took the revision slot), the branch adds the committed collections to `cycle.saved` and throws `CoordinatorStaleLossError`. The existing retry loop then backs off, refreshes every collection, and re-attempts: the refresh finishes the refused collection's own log entry where its tail landed (`Collection.completeOwnEntry`, from the attempt `retainInFlightAttempt` kept), or the next attempt re-pends it afresh, and it commits only what is still staged (`stagedCollections`), so the durable siblings are never re-logged. Every failure that still escapes is wrapped by `reportSaved` into the `CoordinatorPartialCommitError` it is, naming the committed siblings. A partial landing on a hard failure (thrown transport fault after three tries, structural rejection) still drops the stamp and reports at once. A new `commit:partial-retry` debug line on `optimystic:db-core:trx:coordinator` names the committed set, the collection being re-driven, and the refusal's reason.

Session mode (`TransactionSession.commit`) goes through `coordinator.commit`, so it gets the same recovery. `coordinator.execute()` has its own partial fold and is untouched: it still reports the partition on the `ExecutionResult` without retry, as its documentation says.

Diagnostic site: `NetworkTransactor.staleFromBatches` now carries the producer's `reason` and `conflict` through the rebuilt commit failure, mirroring the pend aggregation in the same file, so the coordinator's error text names `commit-not-durable` instead of the generic "Stale commit". The retry is deliberately still not gated on `isConflictFailure` (see "Decisions" below).

## How to exercise it

- **The reproducer**: `packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts`. Two mock-mesh nodes; the joiner's raw storage is veiled over Member's blocks; the joiner writes Member + UNIQUE index + ConsumedInvite in one SQL transaction. The assertion is all-or-nothing on both nodes. Run it several times from the plugin package with `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/two-node-lagging-replica-multi-collection-commit.spec.ts"`. 3 of 3 passed here.
- **db-core, refused twice then accepted, legacy shape**: `transaction.spec.ts` "a PARTIAL landing whose loser is refused twice then accepted lands the whole transaction". Pins: commit calls = 2 + 1 + 1 (the loser alone is re-driven, once per attempt), each collection holds exactly one log entry, values read back, stamp released.
- **db-core, refused forever, legacy shape**: "a PARTIAL landing whose loser is refused forever is reported as CoordinatorPartialCommitError once the budget ends". Pins: committed `['users']`, failed `['posts']`, `reason` is a `CoordinatorStaleLossError` whose message names the refusal, winner logged once, loser never landed and still staged, stamp released by the report.
- **Session mode**: "session commit: a collection refused once then accepted lands the whole transaction, the winner logged once" (uses `FailCollectionNTimesTransactor.durableCommits` to show the winner committed once). The existing "durably commits one collection, permanently fails another, and reports the partition honestly" is the session-mode refused-forever arm, now with a small budget.
- **Cancel discipline across attempts**: "should cancel pended collections when commit fails for one collection" and "should do forward recovery and targeted cancel on partial commit failure" pin one cancel per attempt, always for the refused collection's blocks and never the committed one's, and commit calls = 1 + attempts.
- **Stamp release timing**: `coordinator-rollback-pending.spec.ts` "stays a no-op after a partial landing dropped the stamp" and `coordinator-single-stamp.spec.ts` "a partial commit drops the stamp": the stamp is now dropped by `reportSaved` once the budget ends, not on the first refusal; both pass a small budget.
- **Network transactor**: `network-transactor.spec.ts` "carries reason, conflict and staleAt through a rebuilt commit failure".

## Results

| Gate | Result |
|---|---|
| the reproducer, 3 runs | 3 passing |
| `@optimystic/db-core` `yarn test` | 1805 passing, 0 failing |
| `@optimystic/db-p2p` `yarn test` | 3023 passing, 63 pending (pre-existing) |
| `@optimystic/quereus-plugin-optimystic` `yarn test` (with smoke) | 997 passing, 13 pending |
| every other workspace's `yarn test`, and `yarn test:harness` | all passing |
| `yarn lint`, `yarn lint:docs`, `yarn lint:deps`, `yarn typecheck`, `yarn check:rn` | pass |
| `yarn test:integration` (db-p2p 44 passing; plugin 1002 passing) | pass |

`yarn check` was run **piecewise**, each of its steps as its own command in the order the script chains them, because the single chained command would exceed the agent tool's ten-minute limit. Every step passed. No pre-existing failure surfaced; `tickets/.pre-existing-error.md` was not written.

**`dist/` was rebuilt for every package (`yarn build` at root) and now contains this fix.** The sereus session asked to be told before `dist/` is rebuilt; it can re-run its release gate against this tree.

## Decisions taken

- **Forward recovery over the alternatives** (catch-up before pend; cross-collection prepare), as the fix ticket argued; the loop, the retained attempt and `completeOwnEntry` are all reused, not reimplemented.
- **The retry is not gated on `isConflictFailure`.** Today's rule stays "returned failure means stale means retryable". Gating would turn a solo node's `missing-base-revision` (bare `reason`, no `conflict`, no `missing`) into a hard failure on a path with no evidence about it. The existing NOTE in `commitCollection` says where to gate if a producer ever returns hard rejections as results; `reason` and `conflict` now survive the transactor so that gate can be built on the machine-readable flag.
- **Budget**: a partial landing that never clears now costs the ordinary retry budget (about 21 s at the defaults: ten attempts, 100 ms base backoff capped at 5 s) before it is reported, where it used to be reported at once. Accepted as the price of landing the write; a caller wanting the old fail-fast passes a small `maxAttempts`. The plugin's session-mode commit inherits the defaults.
- **`CoordinatorPartialCommitError.reason`** is a `CoordinatorStaleLossError` (carrying the refusal string as its own `reason`) in the retried case, rather than the bare string. No consumer in this repo reads `reason`; documented on the field.
- **`CoordinatorStaleLossError`'s message** no longer says "no collection durably committed", since it is now also the internal signal a half-landed attempt retries on and surfaces as a partial error's `reason`. The class doc explains when it escapes bare.

## Known gaps and things worth a reviewer's eye

- **`coordinator.execute()` is untouched.** Its partial fold still reports the split without retry. Nothing in this repo commits multi-collection transactions through `execute()`'s own coordination (the plugin stages via the session's `execute` and commits via `session.commit`, which is `coordinator.commit`), but a host that does would still see the old behaviour there. Documented as non-retryable in `docs/transactions.md`; not a regression, and not fixed here.
- **The committed sibling's refresh between attempts.** The retry loop refreshes every registered collection, including the sibling that already committed, with its in-flight mark still set (marks are cleared at the end of the whole commit cycle). That refresh is inert in every test and in the reproducer, and the shape is the same one a refresh-saved participant already goes through on later rounds. I did not trace `Log.getFrom`'s inclusivity by hand to prove `consumeOwnEntry` is unreachable for an already-advanced participant; a reviewer who wants certainty should eyeball `updateInternal` in `packages/db-core/src/collection/collection.ts` with that question.
- **"should handle transactor becoming unavailable during cancel phase gracefully"** now pins only that the cancel fault does not replace the commit refusal in the reported error and that cancel was attempted at least once. What the retry does when the loser's pending record is stranded in `TestTransactor` (re-pend refused as a pending conflict, or accepted as the same action) was not pinned; both routes end in the same `CoordinatorPartialCommitError`.
- **Session mode has no mesh-level reproducer**; it is covered by the db-core doubles as the fix ticket asked. The reproducer exercises the legacy pended batch.
- **A returned hard rejection that half-lands** (a validator policy refusal returned as a result, say) would now cost the budget before being reported. No producer in this repo returns one today; the `commitCollection` NOTE is the tripwire.
- `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold` stays open: the `reconcile:no-rev-quorum { behind: 1 }` race in the reproducer's trace is a legitimate refusal the coordinator now survives, not something this fix removes.
