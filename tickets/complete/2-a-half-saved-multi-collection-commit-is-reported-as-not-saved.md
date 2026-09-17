description: When one change touches several collections and its retry ends up saving some of them but not others, the caller used to be told only that the change failed, so the application rolled back as if nothing had been saved. Every failure after part of the change is saved is now reported as a partial save that names what was saved.
files:
  - packages/db-core/src/transaction/coordinator.ts (`commit`, `commitAttempts`, `refreshBetweenAttempts`, `reportSaved`, `stagedCollections`, `CommitCycle`; `commitOnce`)
  - packages/db-core/src/collection/collection.ts (`RefreshReport`, `refreshInFlight(report)`, `updateInternal(report)`)
  - packages/db-core/src/transaction/errors.ts, packages/db-core/src/collection/struct.ts (doc comments)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts, packages/db-core/test/coordinator-single-stamp.spec.ts
  - docs/internals.md, docs/transactions.md, docs/correctness.md
----
# What was built

`TransactionCoordinator.commit` commits one transaction across several collections and refreshes every registered collection between retry attempts. That refresh can find a participant's own log entry (the attempt reported a loss, but the tail was stored), finish the participant's remaining blocks and consume the entry, which saves the participant. Before this change, any later failure escaped as a bare error, and the Quereus bridge read that as "nothing saved, roll back".

- The refresh now fills in a `RefreshReport` (`Collection.refreshInFlight(report)`) as it goes, so a refresh that throws after finishing still reports the save.
- `commit()` keeps a `CommitCycle` (in-flight disposers, every participant, the refresh-saved set) and has a single `catch` (`reportSaved`) that turns any escaping error into `CoordinatorPartialCommitError(committed = saved ∪ the error's own committed set, failed = the other participants, reason = the original error)` and releases the stamp. When nothing was saved, the error passes through untouched.
- `refreshBetweenAttempts` visits every collection even after one throws, so the order the collections were registered in no longer decides whether a participant gets finished.
- When a refresh saved something and nothing is left staged, `commit()` releases the stamp and returns at once.

# Review findings

**Diff read first** (`git show 2b95847a`), then the handoff. Checked: the single-exit catch against every throw site in `commitAttempts` (abort, deadline `throw lastLoss`, budget exhaustion, `throw refused`, `abortableDelay` rejection, a later attempt's hard or partial error). All leave through `reportSaved`. Also checked the merge with a later attempt's own partial error (committed is merged and `reason` is unwrapped, so the error is never wrapped twice), the early return, the bridge's `CoordinatorPartialCommitError` branch (`txn-bridge.ts` `commitTransaction`), the report timing in `updateInternal` (set right after `completeOwnEntry`, before anything that can throw), and `syncAttempts`' unchanged single-collection behaviour.

**Fixed inline (minor):**
- **The stamp stayed open after a commit that staged nothing.** This was the implementer's unverified gap. I confirmed it with a probe: a collection already synced, `applyActions([], stamp)`, then `commit`, left `stampData.size === 1`, so every later stamp on that coordinator was refused. The new test's first version passed by accident, because a freshly created collection's header block is itself staged, so the commit was not empty. The test now syncs first, and it failed before the fix. Fix: `commitOnce`'s nothing-to-commit branch releases the stamp, as the success path does. Added the test `committing a stamp that staged nothing releases it, so a new stamp is accepted` to `coordinator-single-stamp.spec.ts`, and updated the early-return comment and `docs/internals.md`, which said the nothing-to-commit return never releases. The early return is still needed: without it, the next loop turn's abort or deadline check could report a fully saved transaction as failed.
- **The abort test was weakly asserted** (`reason` only had to be some `Error`). It now asserts `name === 'AbortError'` and that the stamp is released.

**Filed (major):**
- `backlog/debt-a-failed-refresh-can-leave-a-collection-half-restaged`. This is the implementer's first known gap, and it is real. The existing NOTE above `replayActions` accepts a half re-applied tracker only if the caller throws the collection's staged state away. The partial-report path added here never does (the bridge restores nothing on a partial commit), so `failedCollections`' "reverted for retry" is untrue for a participant whose replay threw. Filed as `debt-` because session mode is not wired by any host in the repo. It targets the representation fix the NOTE already names: re-apply into a scratch tracker and swap it in only on success. I added a pointer from that NOTE to the ticket.

**Tripwires recorded:**
- `reportSaved` in coordinator.ts: a participant that was saved by a refresh and also held actions staged after its attempt began is listed only as committed. Unreachable while staging and commit share one call path. Parked as a `NOTE:` at the site.
- The refresh cost (one failed read per registered collection when the cluster is unreachable) is already a `NOTE:` on `refreshBetweenAttempts` from the implementer. Left as is.

**Considered, no action:**
- `failedCollections` can be empty (a refresh finished its entry and then threw). This is documented on the error. The "was not atomic" message is slightly off in that case, but the structured fields are right. Cosmetic only.
- The `consumeOwnEntry` guard throw (entry longer than pending) reports the participant saved without dropping its pending actions locally. That is an invariant-violation path, so it was not pursued.
- Arms with no dedicated test (deadline exhaustion, expiry, a later attempt's hard or partial error, a non-participant's `CollectionHeaderVanishedError`) all leave through the one `catch` that the exhaustion, abort and torn cases already exercise. The implementer's mutation check (forcing `reportSaved` to pass the error through fails 4 cases) shows that catch is covered. I did not add per-arm cases.
- Docs: `internals.md` (corrected as above), `transactions.md` (the single-stamp consequences are still accurate) and `correctness.md` Theorem 3 were all read. `yarn lint:docs` passes.

**Validation:**
- `yarn test` in db-core: 1719 passing, 0 failing.
- `yarn build` in db-core, then `yarn test` in quereus-plugin-optimystic: 966 passing, 13 pending, 0 failing.
- `npx eslint` on the changed sources and specs: clean. `tsc --noEmit`: clean. `yarn lint:docs`: all citations resolve.
