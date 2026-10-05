description: When the cohort refuses a write because the transaction already expired by the members' clocks, the writing application now gets one named, non-retryable error that says how far apart the clocks appear to be, instead of a stream reset or a generic failure that its retry loop keeps re-sending.
prereq: a-writer-refused-for-clock-skew-is-reported-as-silence
architecture: docs/correctness.md#74-clock-assumptions
files:
  - packages/db-core/src/network/struct.ts (`TransactionExpiry`, `ExpiredFailure`, `WriteFailure`; `PendResult`/`CommitResult` widened)
  - packages/db-core/src/network/stale-failure.ts (`isExpiryFailure`; `isConflictFailure` false for an expiry)
  - packages/db-core/src/network/transaction-expired-error.ts (the one `TransactionExpiredError`, `toFailure()`)
  - packages/db-core/src/utility/format-instant.ts (moved from db-p2p)
  - packages/db-core/src/transactor/network-transactor.ts (`pend` aggregate now uses `refusalFrom`; an expiry in any batch is the answer)
  - packages/db-core/src/collection/collection.ts (`syncAttempts` stops on the first expiry)
  - packages/db-core/src/transaction/coordinator.ts (pend and commit phases carry and surface the expiry)
  - packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-core/docs/collections.md, packages/db-core/docs/transactor.md (updated in review)
  - docs/correctness.md, docs/debugging.md, docs/internals.md
----

GitHub issue #24, writer side. The prereq made skewed members cast signed expiry votes and made the cluster coordinator raise `TransactionExpiredError`. This ticket gets that verdict to the application that wrote.

# What landed

- **Returned refusal.** An expiry crosses the repo protocol as `ExpiredFailure` (`{ success: false, conflict: false, reason, expired: TransactionExpiry }`), a sibling of `StaleFailure` inside `PendResult`/`CommitResult`. The fields it can never carry are typed `never` on each side, so consumers still read `reason`/`staleAt`/`missing` without narrowing, and a producer cannot build "expired and conflict". `isExpiryFailure` is the one predicate for it.
- **One error class.** `TransactionExpiredError` lives in db-core, and every layer raises it: the cluster coordinator, and each write path again from the returned facts. It carries `expiration`, `memberClocks`, `coordinatorClock`, `localClock` and `apparentSkewMs`, which is measured against the clock of whichever node raises it. It is no longer a `ValidatorRejectionError`. Its message is written for a person and never contains "super-majority".
- **Coordinating repo.** `CoordinatorRepo.pend` and `.commit` return `error.toFailure()` before their conflict and stale classifiers run.
- **Transactor.** `NetworkTransactor.pend`'s hand-built aggregate is replaced by `refusalFrom`, which the commit side already used. An expiry in any batch is the whole answer.
- **Write paths.** `Collection.syncAttempts` throws on the first expiry, before it touches the counters or retains the attempt, and the staged actions stay staged. `TransactionCoordinator` throws it from the pend phase and the commit phase without re-driving. When a sibling collection has already committed, the expiry is the `reason` of the `CoordinatorPartialCommitError`. `commitCollection` no longer maps an expiry to `stale: true`.

# Review findings

Read the diff of `ticket(implement): a-writer-is-told-its-transaction-expired-by-name` before the handoff, then followed an expiry through every path it can take.

**Checked and correct**
- **Pend path.** `NetworkTransactor.pend` cancels every batch before it returns the rebuilt refusal. `TransactorSource.transact` passes the refusal straight through. The `refusalFrom` rewrite keeps the old behaviour otherwise: first `reason`, `some` conflict, highest `staleAt`, distinct `missing`.
- **Commit path.** `TransactorSource.transact` cancels the pend after any returned commit refusal (`dischargePend`), and the coordinator's `cancelPhase` does the same. The one-round commit (`commitInOneRound`) and the tail-first `commitTailThenSweep` both go through `refusalFrom`, so an expiry reaches the caller intact.
- **Coordinator classification.** An expiry counts as a hard failure in `pendPhase` and `commitPhase`, so it never becomes a stale loss and is never re-driven. When nothing has committed it is thrown by name. With a committed sibling it becomes the `reason` of `CoordinatorPartialCommitError`. `commit()`'s outer catch does not wrap it twice.
- **`apparentSkewMs`.** The sign is right, and it reads low by the time the answer took to come back. The old db-p2p comment said "inflated", which was wrong; the new class says "low". The "past as well" branch of the message is always positive, because a member clock at or below the local clock is still past the expiration.
- **Nothing else depended on the old subclassing.** No code outside the coordinator relied on `TransactionExpiredError` being a `ValidatorRejectionError`. The Quereus bridge passes it through its generic rewrap, and the message survives.
- **Mixed versions.** An old writer reads `conflict: false` as a hard failure, as the handoff says.

**Tests.** I kept all four. Each one pins a contract with real branching:
- the expiry winning over a conflict through the real `NetworkTransactor` rebuild, with one pend per coordinator (the implementer mutation-checked this one);
- the coordinator's pend phase and its commit phase, each tested separately;
- `CoordinatorRepo` returning the expiry ahead of its stale classifiers.

None of them restates the implementation or only checks a mock. I added no tests.

**Fixed in this pass (minor)**
- `packages/db-core/docs/collections.md` did not mention the new way `sync()` can fail. Added a "No retry on an expired transaction" bullet.
- `packages/db-core/docs/transactor.md` had no mention of `ExpiredFailure`. Added a section for it. Corrected the stale line "Commit-side failures never set it": `CoordinatorRepo.commit` does set `conflict` now, and the commit side does not read the field.

**Tripwires recorded**
- A malformed coordinator answer (`expired` present but `memberClocks` missing or empty) gives a TypeError or a NaN skew in the writer instead of a `TransactionExpiredError`. Parked as a `NOTE:` in the `TransactionExpiredError` constructor.
- The implementer's `NOTE:` in `completeOwnEntry` stays as written: an expiry on a re-send is retried as `completion-refused` until the budget runs out.

**Major findings.** No new tickets. One known gap is already tracked: an expiry on a commit sweep leaves the log entry behind. I confirmed the arm in `tickets/backlog/bug-a-refused-write-can-leave-its-log-entry-behind.md` and the matching `NOTE:` at the throw in `syncAttempts`.

**Accepted as designed.** When one collection's pend expires and another fails hard, the expiry is reported. Hiding the other failure until the clock is fixed is the right priority, because no retry gets past the clock. The coordinator-side message also says "this device" when it means the coordinator; only the coordinator's logs see that text.

**Runs.** db-core build and `yarn test` (1866 passing). db-p2p build and `yarn test` (3222 passing, 68 pending). `yarn lint:docs` is clean. After the comment-only source edit I rebuilt db-core and re-ran the expiry specs. Not run: `yarn test:integration` and `yarn check:rn`; the change adds no new runtime APIs or syntax.
