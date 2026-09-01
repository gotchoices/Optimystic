description: A transaction commit locks each data collection it writes to so nothing else can refresh that collection mid-commit. Tests now cover the second of the two places that take this lock, plus multi-collection and failing-commit cases; this ticket is the review pass over those tests.
files:
  - packages/db-core/test/coordinator-latch-span.spec.ts (NEW — all seven cases)
  - packages/db-core/src/testing/refresh-probe.ts (NEW — `drainMacrotasks`, `releaseRefresh`)
  - packages/db-core/src/testing/test-transactor.ts (`GatedCommitTransactor`, `GatedPendTransactor` promoted here)
  - packages/db-core/src/testing/index.ts (exports the new module)
  - packages/db-core/test/coordinator-latch-interleaving.spec.ts (now imports the promoted helpers)
  - packages/db-core/src/transaction/coordinator.ts (one `NOTE:` comment at `execute`'s post-commit fold, line ~742)
difficulty: medium
----

# Review: commit-time collection lock, proven on the `execute` path and with two collections

## What the change is

A *collection* is one logical set of data (a table or an index) held as a local `Collection` object
over shared storage. While a commit is in flight, nothing else in the process may refresh the
collections it is writing to — a refresh landing mid-commit used to leave the collection's local
revision counter permanently one step ahead of what storage recorded, after which every later read
silently served stale data. Both commit paths hold each participating collection's instance lock
(`Collection.acquireLatch()`) across the whole commit.

Before this ticket only one path (`commitOnce`), one collection, and the success case were tested.
This adds `packages/db-core/test/coordinator-latch-span.spec.ts` with seven cases covering the
other three corners. **No production behaviour changed** — the only non-test edit is a `NOTE:`
comment.

## The seven cases, and what each actually proves

| Case | Proves |
|---|---|
| `execute holds the span over every participant` | Two collections; commit parked mid-flight; `Collection.update()` on **both** is still pending; `execute` succeeds; both refreshes settle; each collection's recorded revision + lineage match a freshly opened handle over the same storage. Also the no-self-deadlock proof for `execute` acquiring *after* it stages actions. |
| `execute takes exactly one span latch for a collection its actions name twice` | The de-duplication before locking. Completing at all is the assertion — an undeduped span takes one instance's non-reentrant lock twice and hangs. |
| `execute acquires span latches in sorted collection-id order` | The `.sort()` at `coordinator.ts:676`, fed actions in the opposite order. |
| `commitOnce acquires span latches in sorted collection-id order` | The `.sort()` at `coordinator.ts:290`, fed a coordinator map in the opposite insertion order. |
| `two concurrent commits over overlapping collections both complete` | Two coordinators over the *same* collection instances with opposite map orders, both pinned at their first acquisition by externally held locks. Without the sort they deadlock. |
| `execute releases the span when the commit fails inside it` | `execute` returns a failure result from inside the locked block; both collections still refresh afterwards. |
| `commitOnce releases the span when the commit rejects out of it` | `commit()` rejects with `CoordinatorStaleLossError`; both collections still refresh afterwards. |

## Verification actually run (not inferred)

Every one of these was executed, not reasoned about:

- `yarn test` from `packages/db-core`: **1553 passing, 0 failing**. `yarn build`, `yarn typecheck`,
  `eslint` — all clean, at package and repo root.
- **Negative control — remove `.sort(...)` at `coordinator.ts:290`**: `commitOnce acquires span
  latches in sorted order` fails on the order assertion (`["span-b","span-a"]`), and `two
  concurrent commits` times out. Restored; `git diff` clean.
- **Negative control — remove `.sort()` at `coordinator.ts:676`**: `execute acquires span latches
  in sorted order` fails on the order assertion. Restored; `git diff` clean.
- **Negative control — remove `execute`'s whole acquisition loop**: all three `execute` span cases
  fail (the blocked-refresh assertion goes false; both order arrays come back empty). Restored.
- **Negative control — suppress `execute`'s release in its `finally`**: the multi-collection case
  and the `execute` failure case both time out. Restored.
- **Negative control — suppress `commitOnce`'s release**: `two concurrent commits` and the
  `commitOnce` failure case both time out. Restored.

`git diff packages/db-core/src/transaction/coordinator.ts` now shows only the added `NOTE:`.

## Things the reviewer should push on

These are the honest soft spots, not a list of things already handled:

- **The concurrency case's second commit carries no work.** The two coordinators must share the two
  `Collection` instances (the lock is per-instance), so they also share staged state. Instrumenting
  `getPendingActions` showed the first commit takes *both* transactions' staged actions into its log
  entry and the second, arriving after that fold reset the trackers, appends an **empty** entry.
  Both still run their full span (append → pend → commit → fold, at revisions 1 and 2), which is
  what the deadlock property needs, and the case now asserts both folds landed. But it is not "two
  independent bodies of work land concurrently", and a reader could easily over-read it. The spec
  says so in a comment; judge whether that is the right scope or whether the case should be built
  differently.
- **The duplicate-collection case deliberately asserts no outcome.** That path commits durably and
  then throws `Collection span-a: action <id> was pended at rev N but the collection now expects
  rev N+1` out of `execute`'s post-commit fold — a separate dormant defect, already filed as
  `debt-execute-duplicate-collection-actions-double-record` (that ticket names this spec file as the
  place to add the success assertion once fixed). The case swallows the outcome so it survives the
  fix. Check the comment is clear enough that nobody "helpfully" adds an assertion.
- **Scope grew slightly beyond the ticket's promotion list.** The ticket said to promote
  `GatedCommitTransactor` and `GatedPendTransactor` into `src/testing/test-transactor.ts` (done;
  `GatedPendTransactor` is now generic in its action type). I *also* promoted `drainMacrotasks` and
  `releaseRefresh` into a new `src/testing/refresh-probe.ts`, because `drainMacrotasks`' turn-count
  doc comment is load-bearing for both specs' "still pending" assertions and duplicating it would
  let the two drift. Reasonable, but it is an added public export on the `@optimystic/db-core/test`
  subpath — worth a second opinion on the file name and placement.
- **No log-entry-count assertion in the multi-collection success case.** It asserts revision and
  lineage agreement with a fresh handle, not "exactly one log entry per collection" the way the
  sibling interleaving spec does. A duplicate entry at the same revision would not be caught here.
- **`spyAcquisitionOrder` monkey-patches `acquireLatch` on the instance.** Per the ticket, no spy
  hook was added to `Collection`. It records only span acquisitions because `act`/`update`/`sync`
  call `Latches.acquire` directly — that is true today and the spec says so, but it is an
  invariant of `Collection`, not something the test enforces. If someone routes `update()` through
  `acquireLatch()`, these order assertions start counting refreshes too.
- **`GatedCommitTransactor` parks only the first `commit` call.** With two collections the commit
  phase issues several; parking all of them would wedge the span. Correct, but it means the blocked
  window is "after the first participant's commit went durable", not an arbitrary point.

## Tripwires parked in code (index only — the analysis lives at the site)

- `NOTE:` at `coordinator.ts` step 5 (`execute`'s post-commit fold, ~line 742): the loop iterates
  `result.actions`, not the distinct participant set the lock acquisition eight lines above already
  deduped to. Names the backlog slug and the pinning test.

## Nothing else outstanding

Every TODO in the implement ticket landed. No pre-existing failures were encountered; no test was
skipped, disabled or loosened; `tickets/.pre-existing-error.md` was not written.
