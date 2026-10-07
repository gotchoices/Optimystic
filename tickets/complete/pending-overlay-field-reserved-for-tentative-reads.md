description: The request field that lets a read see one unfinished change stays in place but unused, and its comments now say what it is reserved for, the rule its future user must follow, and why the old "remember pending changes seen while reading" idea was dropped. No behaviour changed.
architecture: docs/correctness.md#theorem-3-multi-collection-atomicity-of-intent-eventual-reported-visibility
files: packages/db-core/src/collection/action.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-p2p/src/storage/storage-repo.ts, docs/internals.md, tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md
----

# Reserve `ActionContext.actionId` for tentative reads; retire the `tryGet` TODO

Applies the 2026-10-07 maintainer decision: the pending-overlay field `ActionContext.actionId` keeps its storage-side behaviour, gets no producer now, and is not used for early abort. Long-lived pend (backlog `feat-long-lived-pend-completes-as-members-appear`) is named as its future producer.

## What changed (comment, doc and ticket text only)

- `ActionContext.actionId` doc comment (`packages/db-core/src/collection/action.ts`): dropped the pointer to the deleted blocked ticket; now states the reservation for tentative reads, why it is not an early-abort signal (`state.latest` already carries the only certain one), and the producer's cache rule (`mayRetain: false` via `TransactorSource.describeServed`, no read dependency, `materialized` names the base under the overlay).
- `TransactorSource.tryGet`: the `TODO` about remembering `state.pendings` and the commented-out `//state.pendings` line replaced by a `NOTE:` tripwire explaining why rival pendings are not remembered, with the revisit condition (lost pend rounds after a rival commit showing up in measurements).
- `StorageRepo.get` overlay comment: stale `tickets/blocked/repo-pending-overlay-has-no-producer` pointer replaced with a pointer to the `ActionContext.actionId` doc comment. The accepted-tradeoff `NOTE:` below it is untouched.
- `docs/internals.md`: one sentence appended to the per-block overlay paragraph in the three-answers bullet, stating nothing in production names a pending action and that an overlay answer must never be cached as committed content.
- Backlog ticket `feat-long-lived-pend-completes-as-members-appear`: appended "# Reading a tentative revision" naming the existing overlay (`StorageRepo.get`, mirrored by `TestTransactor.get`), this feature as its first producer, and the cache rule. Header untouched.

## Validation

- No executable line changed (only the commented-out `//state.pendings` removed).
- `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-p2p build` pass.
- `yarn lint:docs`: all citations resolve.
- `git grep -n "repo-pending-overlay-has-no-producer" -- ':!tickets'` returns nothing.
- No tests added or run — no behaviour to test. Existing overlay tests left as they are.

## Review findings

Review skipped (`review: skip`). The tripwire on rival pendings is parked as a `NOTE:` in `TransactorSource.tryGet`.
