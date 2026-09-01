description: One way of running a transaction used to report an error even though the write had already succeeded, whenever a single transaction touched the same data collection twice. That path now succeeds, and its post-commit bookkeeping matches the path that ships today.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` ~600: the grouping ~663, the latch acquisition ~697, the apply loop ~710, the partial-commit fold ~751, the success fold ~772)
  - packages/db-core/test/coordinator-latch-span.spec.ts (`logEntryRecords`/`logEntries` helpers ~146; the duplicate case ~224 and five cases after it)
  - packages/db-core/test/transaction.spec.ts (`execute() surfaces the partition on ExecutionResult …` ~4033)
  - tickets/backlog/debt-execute-partial-commit-leaves-an-unsafe-undo-handle.md (filed by this review)
----

# What landed

`TransactionCoordinator.execute` receives a flat `CollectionActions[]` from the engine. Nothing
stopped two entries naming the same collection, but everything after staging was written
per-participant, not per-batch — so a duplicate produced two log entries stamped with the same
revision, an id-keyed map that silently dropped the first batch, and a post-commit fold that
called `recordCommitted` twice, the second throwing *after* the transaction had already committed
durably.

Option **A** from the plan: harden `execute` rather than delete it. Three arms, all in
`packages/db-core/src/transaction/coordinator.ts`.

**Arm 1 — group the engine's batches by collection, once.** Right after `applyActions`, `execute`
folds the list into `const batches = new Map<CollectionId, unknown[]>()` — first-appearance
collection order, each collection's own actions concatenated in emission order — and
`allCollectionIds`, the latch acquisition, the apply loop and both folds all derive from it. The
`[...new Set(...)]` at the acquisition became a plain sort, with the distinctness *fact* restated
as now guaranteed upstream.

Two deliberate non-changes, both commented so a later "simplification" does not undo them:
`applyActions` still runs on the original, un-coalesced list (staging order is what a re-executing
validator reproduces), and the success result still returns `actions: result.actions` (the
caller's own shape). Only `results` changed, by becoming complete.

**Arm 2 — both folds now do all four steps `commitOnceLatched` does.** Success and
partial-commit-committed-subset alike went from `recordCommitted → tracker.reset` to
`recordCommitted → applyCommittedToCache → tracker.reset → clearPendingActions`, cache before
reset because the transforms are read live. Both folds are still `await`-free.

**Arm 3 — `stampData.delete`** needed no change on the success path: with the throw gone it is
reached normally again, and it stays out of a `finally` so the failure paths leave the stamp
tracked for `rollback(stampId)`. (The review found that *same* decision is unsafe on the
partial-commit path — see findings.)

# Review findings

Reviewed by reading the implement diff (`c4fde250`) against the surrounding code before the
handoff summary. Full validation from a clean tree: `yarn lint` clean, `yarn lint:docs` clean
(45 documents, 71 anchored citations, 572 file mentions, 307 links — all resolve), `yarn
typecheck` clean across all workspaces, `yarn test` **5395 passing, 0 failing** across all 11
workspaces. No pre-existing failures surfaced.

## Verified — the handoff's load-bearing claims, re-derived from source

- **The grouping is correct for the log entry.** `applyActionsToCollection` uses
  `collectionActions.actions` only for `log.addActions`; the transforms it returns come from the
  *live tracker*, which already carries both batches' effects from staging. So coalescing the
  batch list changes the log entry and nothing else — exactly the claimed boundary.
- **Staging must stay un-coalesced, and does.** `applyActionsRaw` iterates batch-by-batch calling
  `collection.act` per action; a validator re-executes the same statements. Grouping there would
  change nothing observable *today* but would decouple two orders that must agree.
- **`commitOnceLatched` really is the model.** Both of its folds (`:421` partial, `:468` success)
  are the same four calls in the same order, and both are `await`-free. `execute`'s two folds now
  match call-for-call.
- **`committedCollections` is keyed by collection id**, not block id (`commitPhase:1181`), so the
  partial fold's `committed.has(collectionId)` guard against `batches.keys()` is sound.
- **No other consumer had this defect.** `CollectionActions[]` reaches only three places:
  `validator.ts:150` and `session.ts:101` both hand it straight to `applyActions`, which is
  order-preserving and per-batch — correct with duplicates. `execute` was the sole per-participant
  consumer, so this is a genuine one-off, not an instance of a class. (Architecture-first was
  considered: making duplicates *unrepresentable* — engines returning a `Map` instead of a list —
  was rejected because the flat list is the right representation for the staging order the
  validator reproduces. The invariant belongs at the one site that needs it, which is where it
  now is.)
- **Docs were re-read, not assumed.** `docs/transactions.md`'s honest-reporting block already said
  the coordinator gives committed collections "fold to read cache + reset the tracker + drop
  pending" and that `execute()` mirrors it. Before this ticket that was *generous* — `execute`
  did only two of the three. Arm 2 made the existing doc true, so no doc edit was needed. The
  one gap it still has is recovery, not reporting, and is carried by the new backlog ticket.

## Corrected — one handoff claim that was wrong

The handoff states the partial-commit branch "is reached by no test in this file, and no test
anywhere drives `execute` into a *partial* landing", and proposes building a new test double for
it. Both halves of that are wrong: `transaction.spec.ts:4033` —
`execute() surfaces the partition on ExecutionResult …` — has driven `execute` into a partial
landing since the honest-reporting work, using `SelectiveCommitFailTransactor` defined in that
same block. The real gap was narrower: that case asserted only `tracker.reset`, so the two steps
Arm 2 *added* went unpinned. No new double was needed.

## Fixed in this pass — four gaps, each mutation-verified

Every assertion added below was checked by mutating the source to break exactly the thing it
claims to pin, confirming the failure, and restoring. An assertion that passes under its own
mutation is decoration, and one was found and rewritten on that basis (see the third bullet).

- **The partial-commit fold's two new steps** (`transaction.spec.ts:4033`, renamed to say it
  covers the *full* treatment). Mutation: drop `clearPendingActions` → the pending-queue
  assertion fails with the winner's queue still holding its durable `replace`.
- **The partial-commit fold's cache step.** Mutation: drop `applyCommittedToCache` → the log read
  through the committing instance sees 1 entry instead of 2.
- **That cache assertion had to be rebuilt to bite.** As first written (`usersTree.get(1)` after
  the partial landing) it passed *with the mutation applied* — a `Tree.get` falls through to
  storage, so it proves durability, not the fold. It now gives the winning collection **prior
  committed state** (an extra `execute` before the partial one) and reads its log through the same
  instance: a pristine collection's log tail lives in its own tracker, so a stale cache has
  nothing to serve in its place and the assertion is vacuous without it. The test's transactor was
  swapped to `FailCollectionNTimesTransactor(inner, 'posts', Infinity)` — the same permanent-loss
  behaviour, but it records which collections landed, which the now-two-transaction case needs to
  keep claiming "`users` is the only collection that ever committed".
- **Three batches for one collection** (`coordinator-latch-span.spec.ts`). The fold accumulates
  with `push(...)`; two-batch cases cannot distinguish that from a pairwise merge. Mutation: merge
  only while the group holds fewer than two actions → the new case fails, both two-batch cases
  still pass, which is exactly the discrimination it was added for.
- **A batch whose `actions` array is empty** — flagged unasserted by the handoff and now pinned:
  the collection stays a participant, takes a latch, and gets an entry carrying no actions (which
  is what makes its pristine header/log blocks durable). Mutation: `continue` on an empty batch →
  the case fails. Behaviour confirmed empirically before pinning, not assumed.
- **The participant list persisted *on the log entry*.** `allCollectionIds` is written into
  `ActionEntry.collectionIds`, which an invalidation cascade reads as "the collections this action
  is conditional on" — a repeated id there is a duplicate conditional, not cosmetic. Arm 1 fixed
  this as a side effect and nothing asserted it. Mutation: pass the un-coalesced ids to
  `applyActionsToCollection` → the new assertion fails.

Test helper change: `logEntries` was split so `logEntryRecords` returns the raw entries and
`logEntries` reduces them to action values — the `collectionIds` assertion needs the entry, the
other four call sites do not.

## Filed — one major finding

**`tickets/backlog/debt-execute-partial-commit-leaves-an-unsafe-undo-handle.md`**. On a partial
landing, `commitOnceLatched` deletes the transaction's `stampData` entry ("neither cleanly
retryable nor cleanly abortable"); `execute`'s partial branch does not. `rollback(stampId)` is
all-or-nothing across every collection — it rewinds each to a pre-transaction snapshot — so
running it after a partial landing re-stages the winner's already-durable changes, the exact
corruption `commitOnceLatched`'s comment exists to prevent. And that handle is `execute`'s *only*
offered recovery for the half that did not land, so the reasonable caller is the one that trips
it.

Pre-existing, not introduced here (the partial branch shipped with the honest-reporting work; this
ticket only added steps *inside* the fold). Filed rather than fixed inline because the fix is a
choice with a real cost either way — match `commit` and lose the failed half's unwind, or teach
`rollback` which collections landed — and because `execute` has no shipped caller, so nothing
forces the decision now. Root cause is a single site, so it is one ticket, not two: the failed
half's missing unwind and the winner's unsafe unwind are the same `stampData` lifetime decision.
Site-claim grep over the open board found nothing touching `stampData` or `execute`'s rollback
path; `feat-cross-collection-atomic-commit` is about *preventing* partial landings, a different
problem.

## Tripwires parked

None. Everything found was either definite (fixed or filed) or already documented. In particular
the empty-batch behaviour, which would have been the natural tripwire candidate, was pinned by a
test instead — cheaper and it cannot rot.

## Considered and not filed

- **`coordinator.ts` is 1312 lines** (`wc -l`), `execute` about 210 of them. Long, but the
  majority is load-bearing explanation in the file's established style, and this diff added ~35
  net lines. Splitting it is a real refactor with real merge cost against a file three tickets
  have touched recently; not worth a ticket on this evidence.
- **`results` is still `[]`** for every collection — `applyActionsToCollection` returns it
  unconditionally, under its own standing TODO about collecting handler return values. Unrelated
  to this ticket and already marked at the site.
- **`execute` is not snapshot/restore-wrapped** the way `commit` is. The handoff flagged the
  existing NOTE as deliberately left standing; re-read and agreed — the NOTE states the reasoning
  and names the condition that would change it (`execute` becoming retryable). It is now partly
  superseded by the filed ticket, which is cross-referenced from that ticket rather than
  duplicated here.
