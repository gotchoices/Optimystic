description: When the cohort refuses a write because the transaction already expired by the members' clocks, the writing application should get one clearly named, non-retryable error that says how far apart the clocks appear to be, instead of a stream reset or a generic failure that its retry loop keeps re-sending.
prereq: a-writer-refused-for-clock-skew-is-reported-as-silence
architecture: docs/correctness.md#74-clock-assumptions
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`pend` and `commit` catch paths; `classifyStaleRejection` and its commit-side sibling — a `TransactionExpiredError` from the cluster layer currently escapes as a throw)
  - packages/db-p2p/src/repo/service.ts (a thrown repo operation aborts the stream, so a remote writer sees only "The stream has been reset")
  - packages/db-core/src/network/struct.ts (`StaleFailure`, `PendResult`, `CommitResult` — the returned-refusal shape that crosses the JSON repo protocol intact, as `staleAt` does)
  - packages/db-core/src/transactor/network-transactor.ts (`pend`: a thrown batch re-picks another coordinator; a returned non-success is rebuilt into one aggregate `StaleFailure` — new fields must be carried explicitly; `commit` likewise)
  - packages/db-core/src/collection/collection.ts (`syncAttempts`: retries ANY non-success up to `maxAttempts`, conflict or not)
  - packages/db-core/src/transaction/coordinator.ts (`pendPhase` → `PendRejectedError`; the commit loop's stale-loss re-drive)
  - packages/db-core/src/network/stale-failure.ts (`isConflictFailure`, `highestStaleAt` — the pattern for one shared rule)
difficulty: medium
repro: static
----

GitHub issue #24: https://github.com/gotchoices/Optimystic/issues/24. Follows `a-writer-refused-for-clock-skew-is-reported-as-silence`, which makes cohort members refuse an expired record with a signed reject vote and makes the cluster coordinator raise `TransactionExpiredError` (a `ValidatorRejectionError` subclass carrying the expiration, each refusing member's signed clock reading, the coordinator's clock and an apparent-skew estimate). That ticket stops the misclassification and the penalty; this one gets the verdict to the application that wrote.

# Where the verdict is lost today (read from code, not run)

Two routes, both seen in the issue's output ("… / The stream has been reset"):

- **Coordinator is a remote node.** `CoordinatorRepo.pend` throws (an unconfirmed validator rejection is a throw), `RepoService` aborts the stream, and the writer's `NetworkTransactor.pend` sees a transport failure, excludes that peer and re-picks another coordinator. The typed error and its numbers never leave the coordinator.
- **Coordinator is the writer's own node.** The typed error reaches `NetworkTransactor.pend` in-process, but `processBatches` still treats a thrown batch as a coordinator failure and re-picks; the aggregate it finally throws is an `Error` whose `cause` is the first batch error.

And even where a refusal is *returned* as a non-success `PendResult`, `Collection.syncAttempts` retries every non-success up to `maxAttempts` (10 by default), conflict or not. The skewed writer's clock is wrong on every attempt, so every retry is a decided failure.

What would confirm it: a two-node in-process mesh (or a `NetworkTransactor` over mock repos) with one node's expiration check forced to fail, observing the writer's error type and the number of pend attempts.

# Required behavior

- An expiry refusal crosses the repo protocol as a **returned** refusal, not a thrown one: `CoordinatorRepo.pend` (and `commit`, whose cluster round can be refused the same way) converts `TransactionExpiredError` into a non-success result carrying the structured facts — expiration, the coordinator's clock, the per-member clocks, the skew estimate — in a typed field, `conflict: false`. A returned refusal is what lets a remote writer see it at all, and what stops `NetworkTransactor` re-picking coordinators for it.
- Whether that field lives on `StaleFailure` or on a sibling failure variant is the implementer's call; the name `StaleFailure` says "lost to a newer revision", which an expiry is not, so a sibling variant of `PendResult` / `CommitResult` is the cleaner reading if the consumers' narrowing stays simple. Either way it must survive `NetworkTransactor.pend`'s aggregate rebuild (which today copies `reason`, `staleAt`, `missing`, `conflict` by hand) and the commit path's equivalent.
- One shared predicate in `packages/db-core/src/network/stale-failure.ts` (beside `isConflictFailure`) decides "this failure is an expiry"; no consumer re-derives it, and none parses reason text.
- `Collection.syncAttempts` stops on the first expiry refusal and throws a db-core `TransactionExpiredError` (named, not `SyncRetryExhaustedError`): non-retryable, carrying the same numbers, with a message an application can show — the transaction expired before the cohort could accept it; the clocks appear to differ by about N s; fix the clock of the device that is wrong. Staged actions stay staged (as for any failed `sync`), so a retry after the clock is fixed works.
- `TransactionCoordinator`'s pend phase and its commit re-drive surface the same error rather than re-driving. Respect the existing rule that once a refresh has saved one participant every failure is a `CoordinatorPartialCommitError` (the expiry is its `reason` then).
- The db-p2p and db-core error classes must not drift: either db-p2p's `TransactionExpiredError` is built on the db-core one, or the db-core one is the only class and the cluster layer constructs it — pick one and say why at the class.

# Tests

At the lowest layer that shows the defect: a `Collection.sync` (or `NetworkTransactor.pend`) spec over a transactor/repo double that returns an expiry refusal, asserting a `TransactionExpiredError` after exactly one pend attempt and the numbers carried through. If the aggregate rebuild in `NetworkTransactor.pend` gains a field, the same spec should go through it rather than a separate one.

# Docs

`docs/correctness.md` §7.4 and `docs/debugging.md` (written by the prereq) gain the writer-side name of the error; `docs/internals.md`'s bullet on pend retryability ("Pend retryability is an explicit field, not a payload shape") gains the expiry predicate beside `conflict`.

# TODO

- Decide the returned-refusal representation (field on `StaleFailure` vs. a sibling variant) and add it to `packages/db-core/src/network/struct.ts`, plus the shared predicate in `stale-failure.ts`.
- Add the db-core `TransactionExpiredError`; reconcile with db-p2p's class from the prereq.
- Convert `TransactionExpiredError` to the returned refusal in `CoordinatorRepo.pend` and `CoordinatorRepo.commit`.
- Carry the field through `NetworkTransactor.pend`'s aggregate rebuild and the commit path.
- Stop `Collection.syncAttempts` on it; stop `TransactionCoordinator` pend phase / commit re-drive on it.
- Add the spec; update the three docs; `yarn lint:docs`.
- Build db-core then db-p2p; run `yarn test` in both (and `quereus-plugin-optimystic` if `TransactionCoordinator` changed).
