description: A transaction commit locks each data collection it writes to so nothing else can refresh that collection mid-commit. Tests now cover the second of the two places that take this lock, plus multi-collection and failing-commit cases; this ticket records the review of those tests.
files:
  - packages/db-core/test/coordinator-latch-span.spec.ts (NEW — seven cases)
  - packages/db-core/src/testing/refresh-probe.ts (NEW — `drainMacrotasks`, `releaseRefresh`)
  - packages/db-core/src/testing/test-transactor.ts (`GatedCommitTransactor`, `GatedPendTransactor` promoted here)
  - packages/db-core/src/testing/index.ts (exports the new module)
  - packages/db-core/test/coordinator-latch-interleaving.spec.ts (imports the promoted helpers)
  - packages/db-core/src/transaction/coordinator.ts (two `NOTE:` comments in `execute`)
  - packages/db-core/src/collection/collection.ts (one `NOTE:` at `acquireLatch`)
  - docs/internals.md (regression anchors for the commit-span latch)
----

# Complete: commit-time collection lock proven on the `execute` path and with two collections

## What landed

A *collection* is one logical set of data (a table or an index) held as a local `Collection` object
over shared storage. While a commit is in flight nothing else in the process may refresh the
collections it writes to — a refresh landing mid-commit used to leave the collection's local
revision counter one step ahead of what storage recorded, after which every later read silently
served stale data. Both commit paths (`TransactionCoordinator.commitOnce` and
`TransactionCoordinator.execute`) hold each participating collection's instance lock
(`Collection.acquireLatch()`) across the whole commit.

Before this ticket only `commitOnce`, one collection, and the success case were tested.
`packages/db-core/test/coordinator-latch-span.spec.ts` now covers the other three corners with
seven cases: the `execute` span over two participants; the de-duplication that keeps `execute` from
taking one instance's non-reentrant lock twice; sorted acquisition order on both paths; two
concurrent commits over overlapping collections; and release of the span on both failure shapes.
Two gated transactor wrappers moved from the sibling spec into `src/testing/test-transactor.ts`,
and `drainMacrotasks` / `releaseRefresh` into a new `src/testing/refresh-probe.ts`, so the two
specs share one copy rather than drifting.

**No production behaviour changed.** Every non-test edit is a comment.

## Review findings

### Verification run in this pass

- `yarn build`, `yarn typecheck`, `yarn test` from `packages/db-core`: **1553 passing, 0 failing**.
  `yarn lint` from the repo root: clean. Re-run after every edit below; same result.
- **Independent negative control.** I did not take the implementer's controls on trust. Removed the
  `.sort()` at `execute`'s span acquisition and re-ran the span spec: 6 passing, 1 failing —
  `execute acquires span latches in sorted collection-id order`, on `["span-b","span-a"]` vs
  `["span-a","span-b"]`. Restored the line and confirmed `git diff` on `coordinator.ts` was empty
  before making my own edits. The suite is not vacuous.
- **The spy's stated invariant is real, not assumed.** Checked every latch call site in
  `collection.ts`: `act`, `update`, `sync` and `updateAndSync` take the mutex through
  `Latches.acquire(this.latchId)` directly; `acquireLatch()` is called only by the commit paths.
  So the order recordings really do contain span acquisitions only.
- **Docs read, not assumed current.** Grepped every doc mentioning the latch span and read the one
  hit in context.

### Minor findings — fixed in this pass

- **`docs/internals.md` still named one regression anchor.** The concurrency-mode paragraph cited
  `coordinator-latch-interleaving.spec.ts` as *the* anchor for the commit-span latch, which stopped
  being true when this ticket landed a second spec covering the `execute` path, multi-collection
  spans, sorted acquisition, and failure release. Both are now named, with what each covers.
- **The multi-collection success case could not see a duplicate log entry.** It asserted revision
  and lineage agreement with a freshly opened handle, which a span that appended twice at one
  revision would still satisfy. Added a log read-back per collection asserting exactly one entry
  carrying that collection's own action — the same assertion shape the sibling spec uses. Verified
  non-vacuous (it reads real values back, not an empty list).
- **Two unhandled-rejection hazards in the new spec.** The file's own `releaseRefresh` is carefully
  built to avoid exactly this — a promise left unawaited across `drainMacrotasks` whose rejection
  reaches end-of-turn with no handler kills the whole mocha run instead of failing one case — but
  two cases reintroduced it. In `two concurrent commits`, both commit promises sit unawaited across
  two drains; attached no-op catches that keep the real `Promise.all` reporting intact. In `execute
  holds the span over every participant`, `await transactor.commitParked` on its own would hang to
  the mocha timeout while `execute`'s rejection went unhandled; it is now
  `Promise.race([commitParked, executePromise])`, which surfaces the real error instead.
- **The `execute` fold `NOTE:` pointed at one of the two loops that share the defect.** The
  partial-commit branch a few lines above folds `result.actions` the same way. Extended the comment
  so a fix cannot cover only the loop the comment sits on. (The backlog ticket already names both;
  the code did not.)

### Major findings — none filed, with the reason

Nothing in this diff needs a new ticket. The one real defect the work surfaced — `execute` throwing
out of its post-commit fold when a transaction names one collection twice — was already filed
during the implement stage as `debt-execute-duplicate-collection-actions-double-record`, and that
ticket already covers both fold loops and names this spec as the place to add the success assertion
once fixed. Filing anything further would be a second ticket at the same code site.

### Tripwires parked in code (index only — the analysis lives at the site)

- `NOTE:` at `Collection.acquireLatch` (`collection.ts`): the order-assertion cases work only
  because no refresh path routes through this method. That is an invariant of `Collection`, not
  something the spy enforces — routing `update()` through here would silently fold refreshes into
  the recordings and weaken the assertions rather than fail them. States the condition and what to
  do alongside it.
- `NOTE:` at `execute`'s span acquisition (`coordinator.ts`): deadlock-freedom against a concurrent
  `commitOnce` needs both paths to sort the *same* way, not merely each to sort. `CollectionId` is
  a string, so `execute`'s default `.sort()` and `commitOnce`'s explicit `<`/`>` comparator agree
  today; the note says to change both together if either spelling does.

### Considered and deliberately left alone

- **`drainMacrotasks` living in `refresh-probe.ts` rather than `async-wait.ts`.** The implementer
  flagged the placement for a second opinion. `async-wait.ts` holds condition polls (`waitFor`,
  `delay`), not a bounded turn-count drain, so there is no duplication to collapse — and
  `drainMacrotasks`' doc comment is an argument *about* `releaseRefresh`'s `blocked()` assertions
  having teeth. Splitting them would separate the claim from its justification. Kept together.
- **The concurrency case's second commit carries no work.** The two coordinators must share the two
  `Collection` instances (the lock is per-instance) and therefore share staged state, so the first
  commit takes both transactions' actions and the second appends an empty entry. Both still run
  their full span at revisions 1 and 2, which is exactly what the deadlock property needs, and the
  spec says so at length in a comment. Correct scope for the case; rebuilding it to carry two
  independent bodies of work would require unshared instances, which cannot contend at all.
- **`GatedCommitTransactor` parking only the first commit.** With two participants the commit phase
  issues several; parking all of them would wedge the span. The blocked window is "after the first
  participant's commit went durable", which is the window the case is about. Documented on the
  class.
- **`execute` skips latching a collection absent from the coordinator's map.** Not a gap — the
  subsequent apply step resolves the same map, so an unregistered participant fails before the lock
  would have mattered.
- **Three near-copies of a `flush` helper in `packages/db-p2p/test`.** Pre-existing, in another
  package, outside this diff, and a single-turn flush rather than this ticket's bounded drain. Not
  this ticket's to file.

### Pre-existing failures

None. No test was skipped, disabled or loosened; `tickets/.pre-existing-error.md` was not written.
