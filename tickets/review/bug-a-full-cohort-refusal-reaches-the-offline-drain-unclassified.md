description: When the machines responsible for a write have no space left, the offline write queue could not tell what went wrong and recorded the failure as unexplained. The refusal now has its own name, and a new guard makes the test suite fail if someone adds a write failure and forgets to name it.
architecture: docs/offline-sync.md
files: packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/network/cohort-out-of-space-error.ts, packages/db-core/test/commit-failure-class.spec.ts, docs/offline-sync.md
----

# A full cohort's refusal reaches the offline drain unclassified — review

## What the two arms do

**Arm 1 — the refusal has a name.** `classifyCommitFailure` (`packages/db-core/src/transaction/commit-failure-class.ts`) now has a `cohort-out-of-space` arm carrying `CohortOutOfSpaceError`, so a write refused by members with no storage left no longer falls through to `unknown`. The offline drain's `applyFailure` (`packages/db-core/src/offline/queue.ts:911`) queues it `waitingFor: 'cohort'` and logs `offline:cohort-out-of-space entry=… action=… peers=… approvals=n/needed` instead of incrementing `unclassifiedFailures` and logging `offline:unclassified-failure`. The counter that `docs/offline-sync.md` promises is "zero in a correct deployment" — and that the Quereus plugin surfaces as a health reading — therefore stays at zero when the only thing wrong is that the network is full.

No new `EntryWaitingFor` value and no change to the state shape the plugin reads: `'cohort'` already existed. It also changes no retry mechanics, which is worth checking rather than taking on trust — the drain loop asks the reachability gate at the top of every iteration whatever `waitingFor` says, and `'cohort'` and `'backoff'` park on the same timer (`OfflineQueue.drain`, `untilWokenOrTimer`).

**Arm 2 — a guard so the next one can't be missed.** `packages/db-core/test/commit-failure-class.spec.ts` now scans the write-path source for error classes it constructs and requires each to be either sorted by the classifier (`SORTED`, 16 entries, each a factory asserted to not sort as `unknown`) or explicitly excused with a written reason (`UNSORTED`, 8 entries). Set equality is asserted **both** directions, so a newly added class fails until someone decides about it, and a table entry for a class nobody constructs any more fails until it is pruned.

## How to validate

Commands run, all green:

- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/commit-failure-class.spec.ts --reporter spec` from `packages/db-core` — 17 passing.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/offline-queue.spec.ts --reporter dot` from `packages/db-core` — 20 passing. Run because `queue.ts` changed.
- `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-core typecheck` — clean. The typecheck is load-bearing for this ticket: `applyFailure`'s `switch` is exhaustive and `summarize`'s `never` default would have failed the build had either been left without the new arm.
- `yarn lint:docs` — 49 documents, all citations resolve. `yarn lint:deps` — every import declared (run because a new import was added, intra-package).

Per `tickets/rules/testing.md` the full db-core suite is review's to run, not implement's.

### The guard was proved to fail, not just to pass

A source-scanning guard that silently stops matching passes forever, so it was exercised against deliberate breakage before being handed off (mutations made in a scratch copy, reverted; the working tree holds only the real file):

- Removing `CohortOutOfSpaceError` from `SORTED` — simulating a class added to the write path with nobody deciding about it — fails with `sort these in classifyCommitFailure or excuse them in UNSORTED: CohortOutOfSpaceError`.
- Adding a `GhostError` entry to `UNSORTED` — a stale table entry — fails with `no longer constructed under collection, collections, transaction, transactor, network; prune from SORTED/UNSORTED`.
- Blanking that entry's reason fails with `GhostError needs a reason, not a bare name`.

The spec also carries two detector self-tests in the shape of the sibling guards (`no-fret-import.spec.ts`), proving the matcher fires on every construction form this tree uses — a plain `throw new X(`, arguments across lines, a class built in a `return` rather than a `throw`, the body of a static factory, a helper-built error never thrown by name — and does not fire on the built-ins or on a static-factory *call*.

### Tests added

| test | what it verifies |
|---|---|
| `cases` row "a cohort with no room left" in `commit-failure-class.spec.ts` | the reproduction: `CohortOutOfSpaceError` sorts as `cohort-out-of-space`, not `unknown` |
| `classifyCommitFailure coverage` — "sorts every class it claims to sort" | each of the 16 sorted classes really reaches a non-`unknown` arm when built with arguments the write path uses |
| — "accounts for every error class the write path constructs" | the guard itself: found classes equal `SORTED` ∪ `UNSORTED`, both directions |
| — "gives a reason for every class left unsorted" | nobody can quiet the guard with a bare class name |
| — the two detector self-tests | the scan still matches the real construction forms, so it cannot rot into a no-op |

## Known gaps — please weigh these

**No queue-level test that the counter stays at zero.** This is the one judgement call worth a reviewer's disagreement. The ticket named the classifier as the reproduction layer and listed only the classifier spec in its TODO, and the drain's arm is three lines whose existence the exhaustive `switch` already forced. But the *filed* symptom is the health counter rising, and the classifier case does not prove `unclassifiedFailures` is left alone — only reading `applyFailure` does. If you want it pinned, the harness is cheap and already there: `offline-queue.spec.ts:481` pins exactly this contract for the shortfall path (`expect(queue.queueState().unclassifiedFailures, 'a shortfall is classified').to.equal(0)`), and an out-of-space double would be a near-copy of `RefusesPendsAsShortfall` in `packages/db-core/src/testing/test-transactor.ts:690` returning `outOfSpace: { peerIds, approvals, peerCount, needed }` in place of `shortfall`.

**The guard's scope is the five write-path directories, not all of db-core.** `collection/`, `collections/`, `transaction/`, `transactor/`, `network/` under `packages/db-core/src`. The scan therefore does not see `RecordAttemptFailed`, which lives in `offline/` — it is in the matcher by name but not expected to be found, and the test's doc comment says so. Widening the scope would drag blob, queue-internal and wire error classes into the allow-list; narrowing it would lose classes. The two limits that are stated rather than chased — a bare `throw new Error(...)` is a deliberate fail-fast the scan skips by name, and the scan cannot see db-p2p without breaking the package layering the sibling guards enforce — are written into the spec's doc comment, not just here.

**Only the four named built-ins are skipped** (`Error`, `TypeError`, `RangeError`, `AggregateError`). If some other built-in is ever constructed in scope the guard fires and costs one allow-list line. That is the designed direction: over-matching is recoverable, a blind spot is not.

**The `cases` table and `SORTED` deliberately do not overlap in what they assert.** `SORTED` asserts only "not `unknown`"; which kind each class means stays pinned in `cases`. If you think the guard should pin kinds too, note the cost: a second place to edit on every rename.

## Things worth a second pair of eyes

- The wording of the new `docs/offline-sync.md` paragraph that argues for a separate row rather than widening `cohort-unreachable`. The argument is: `cohort-unreachable` means too few members *answered*, a full cohort answers clearly, and the two want different things from an operator (restore connectivity vs. add storage or shed data). It sits after the `SyncRetryExhaustedError.rivals` paragraph in §Classifying an attempt's outcome.
- The stale `NOTE:` at the end of `CohortOutOfSpaceError`'s class doc — the one that said the classifier had no arm and pointed at this ticket — was deleted, since this work is what removes the condition it described.
- The `UNSORTED` reasons are prose a human wrote and a future reader will trust. Eight entries; the `PendRejectedError` one in particular makes a claim about `cleanFailureError` in `transaction/coordinator.ts` that is worth re-reading against the code.

## No pre-existing failures

Nothing unrelated failed in anything that was run; `tickets/.pre-existing-error.md` was not written.
