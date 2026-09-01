description: One way of running a transaction used to report an error even though the write had already succeeded, whenever a single transaction touched the same data collection twice. That path now succeeds, and its post-commit bookkeeping matches the path that ships today.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` ~600: the new grouping ~663, the latch acquisition ~697, the apply loop ~710, the partial-commit fold ~751, the success fold ~772, the success return ~793)
  - packages/db-core/test/coordinator-latch-span.spec.ts (`logEntries` helper ~146; the rewritten duplicate case ~224 and three new cases after it)
difficulty: medium
----

# Review: `TransactionCoordinator.execute` — one fold per collection, and the same fold `commitOnce` does

## What landed

Option **A** from the plan: `execute` was hardened, not deleted. Three arms, all in
`packages/db-core/src/transaction/coordinator.ts`.

**Arm 1 — group the engine's batches by collection, once.** `execute` receives a flat
`CollectionActions[]` from the engine. Nothing stopped two entries naming the same collection, but
everything after staging was written per-participant, not per-batch. Right after the existing
`applyActions` call, `execute` now folds the list into
`const batches = new Map<CollectionId, unknown[]>()` — first-appearance collection order, each
collection's own actions concatenated in emission order — and `allCollectionIds`, the latch
acquisition, the apply loop and both folds all derive from it. The now-redundant
`[...new Set(allCollectionIds)]` at the acquisition became a plain `[...allCollectionIds].sort()`;
the comment about matching `commitOnce`'s comparator stayed, and the distinctness *fact* is
restated as now guaranteed upstream.

Two deliberate non-changes, both called out in comments so a later "simplification" does not undo
them:

- `applyActions(result.actions, …)` still runs on the **original, un-coalesced** list — staging
  order is what a re-executing validator reproduces.
- The success result still returns `actions: result.actions` (the caller's own shape). Only
  `results` changed, and only by becoming complete.

**Arm 2 — the success fold now does all four steps `commitOnceLatched` does.** It was
`recordCommitted → tracker.reset`; it is now
`recordCommitted → applyCommittedToCache → tracker.reset → clearPendingActions`, cache before
reset because the transforms are read live. The same four steps were added to the committed
subset of the partial-commit fold. Both folds are still `await`-free, and both say so.

**Arm 3 — `stampData.delete`** needed no change: with the throw gone it is reached normally
again, and it deliberately stays out of a `finally` so the failure paths leave the stamp tracked
for `rollback(stampId)`.

The `NOTE:` above the old success fold that named this ticket by slug is gone, as is the paragraph
in the test that explained why the outcome was unasserted. One comment was added beyond the
ticket's TODO list: a note at the success return that `actions` (per-batch) and `results` (keyed
by collection id) are **not** positionally aligned when an engine names one collection twice —
join on `collectionId`, never by index. Documentation only, no behaviour.

## Tests: what to poke at

All in `packages/db-core/test/coordinator-latch-span.spec.ts`. A new `logEntries(collection)`
helper reads a collection's log at **entry** granularity (`Log.getFrom(0)`, one array of action
values per entry) — `selectLog` flattens entries together and cannot tell one entry carrying two
actions from two entries carrying one each, which is the exact distinction three of these cases
turn on.

- **`execute takes one span latch and writes one log entry for a collection its actions name
  twice`** — the rewritten case. Was outcome-unasserted; now asserts `result.success`, one latch
  (`order` deep-equals `[span-a]`), storage reached, a fresh handle reading back exactly
  `[['first','second']]`, and revision + lineage agreement between the fresh handle and the
  committing instance. Reaching the assertions at all is still load-bearing: an undeduped span
  self-deadlocks on the non-reentrant latch and the mocha timeout is the only detector, so a
  **timeout here is a real failure, not flake**.
- **`execute coalesces a duplicated collection without dropping its other participant`** — batches
  arrive `span-b`, `span-a`, `span-a`, so grouping order and sorted acquisition have to compose.
  Asserts exactly two latches in sorted order, `span-a` with both actions in one entry, `span-b`
  untouched.
- **`execute clears the pending queue, so a later commit does not re-log its actions`** — `execute`
  one action, then stage a second directly and drive `coordinator.commit`. Log must be
  `[['first'], ['second']]`.
- **`execute folds the committed transforms into the read cache: …not stale`** — commit a first
  revision through `commitOnce` (which already folds correctly), then `execute` a second action,
  then read through the **same** instance.

**Each new arm was mutation-checked**, not just observed green:

| mutation | cases that failed |
| --- | --- |
| drop `applyCommittedToCache` + `clearPendingActions` from the success fold | the pending-queue case (got `[['first'],['first','second']]`) and the stale-read case (got `['first']`) |
| make the grouping last-batch-wins (`batches.set` unconditionally) | both duplicate cases (got `[['second']]`) |

Full run: `yarn workspace @optimystic/db-core test` → **1569 passing**, and `npx tsc --noEmit` in
`packages/db-core` is clean. No pre-existing failures surfaced.

## Known gaps — where to aim the adversarial pass

- **The partial-commit fold's new steps are not directly covered.** The success fold is exercised
  four ways; the `!coordResult.success` branch with a non-empty `committedCollections` is reached
  by no test in this file, and no test anywhere drives `execute` into a *partial* landing with a
  duplicated collection. The edit there is a mechanical mirror of the success fold, and it
  typechecks, but "mirrors a tested thing" is the only evidence it has. The ticket listed
  "duplicate collection on the partial-commit path" as an edge case; it was not written, because
  forcing a genuine partial commit through `execute` needs a transactor that commits one
  collection and permanently fails another, and no existing test double in
  `src/testing/test-transactor.ts` does that. Worth deciding whether that double is worth building
  or whether the gap is acceptable for a dormant path.
- **Three or more batches for one collection** is asserted only indirectly — the fold is written as
  a `push(...)` accumulation, and the two-batch cases would not catch a pairwise-merge regression
  that loses a third. Cheap to add if the reviewer wants it.
- **A batch with an empty `actions` array** is likewise unasserted. The grouping registers such a
  collection as a participant (`batches.set(id, [])`) and `applyActionsToCollection` appends its
  entry from the live tracker, which is the intended behaviour — but nothing pins it.
- **`results` contents are still empty.** `applyActionsToCollection` returns `results: []`
  unconditionally (standing TODO there about collecting handler return values), so the duplicate
  case asserts the map's *shape* (one key, nothing overwritten) and says so in a comment. Do not
  read the empty array as a leftover defect from this ticket.
- **No shipped code calls `execute`** — only tests. The whole change is dormant-path hardening, so
  the tests are the only thing that can prove any of it. Judge them accordingly.
- **`execute` is still not snapshot/restore-wrapped** the way `commit` is. Unchanged by this
  ticket and still described by the existing NOTE above the apply loop; out of scope here, but a
  reviewer re-reading that NOTE should know it was left standing deliberately.

No tripwires were parked in code by this ticket; the one new explanatory comment (the
`actions`/`results` alignment note at the success return) is documentation of existing shape, not
a deferred concern.
