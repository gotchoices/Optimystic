description: One way of running a transaction reports an error even though the write succeeded, whenever a single transaction touches the same data collection twice. Fix that path so it succeeds, and bring the rest of its post-commit bookkeeping in line with the path that ships today.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute`, line ~600 — the apply loop ~688, the partial-commit fold ~731, the success fold ~756; `commitOnceLatched`, line ~317, is the reference implementation)
  - packages/db-core/src/collection/collection.ts (`recordCommitted` 819, `applyCommittedToCache` 798, `clearPendingActions` 719, `getNextRev` 803 — reference only, no change)
  - packages/db-core/test/coordinator-latch-span.spec.ts (duplicate-collection case, line ~206)
difficulty: medium
----

# Harden `TransactionCoordinator.execute`: one fold per collection, and the same fold `commitOnce` does

## Decision taken

Option **A** from the plan ticket — harden `execute`, do not delete it. Rationale: the fix is
small and local; the `execute` cases in `coordinator-latch-span.spec.ts` document real latch
ordering constraints worth keeping; and the pure-translator engine contract in `transaction.ts`
(`ITransactionEngine`, model (a)) names `execute` as the caller for that model, so a near-term
caller is plausible. No shipped code calls it today — only tests — so the whole change is
dormant-path hardening, and the tests are the only thing that can prove it.

## The shape of the fix: group batches by collection, once

`execute` receives `CollectionActions[]` from the engine — a flat list of `{ collectionId,
actions }` batches. Nothing stops two batches naming the same collection; with the built-in
`ActionsEngine` that is just two statements against one table.

Everything after staging is written as if the list were already one batch per collection. It is
not, so with a duplicate:

- the apply loop calls `applyActionsToCollection` twice for that collection, appending **two log
  entries stamped with the same revision** (the revision only advances at `recordCommitted`);
- `actionResults`, `collectionTransforms` and `criticalBlocks` are `Map`s keyed by collection id,
  so the second `set` **discards the first batch's entry**;
- both folds (the `!coordResult.success` one and the success one) call `recordCommitted` twice for
  that collection; the second call is one revision behind what the collection now expects and
  **throws — after the transaction already committed durably**.

The fix is to make the list distinct once, up front, rather than patching three loops:

    // after the empty-actions guard and after applyActions(), before the latch acquisition
    const batches = new Map<CollectionId, unknown[]>();
    for (const { collectionId, actions } of result.actions) {
      const existing = batches.get(collectionId);
      if (existing) existing.push(...actions);
      else batches.set(collectionId, [...actions]);
    }

Then `allCollectionIds`, the latch acquisition, the apply loop, and both folds all iterate
`batches` — one entry per collection, in first-appearance order, with that collection's actions
concatenated in the order the engine emitted them.

This matches `commitOnceLatched` exactly: it appends **one** log entry per collection carrying
`collection.getPendingActions()` — all of that collection's actions for the transaction. One log
entry per collection per transaction is the established invariant; two entries at one revision is
not a state the log or sync path is meant to accept, so coalescing is the answer to the plan
ticket's open question about the apply loop, not a per-batch log entry.

Two details that are deliberate and must not be "simplified":

- **Keep `applyActions(result.actions, ...)` on the ORIGINAL, un-coalesced list.** Staging order is
  what a re-executing validator reproduces, so leave it exactly as the engine emitted it.
  Coalescing is only for the log-append and fold phase downstream. (Nothing breaks if this is
  violated today — actions apply per-collection and cannot observe each other across collections —
  but there is no reason to introduce the divergence.)
- **Keep returning `actions: result.actions` (the original batches) in the success result.** The
  field is documented as "actions produced by executing the transaction"; the caller's own shape is
  the honest answer. Only `results` changes shape, and only by becoming complete.

With `batches` in place, the latch loop's `[...new Set(allCollectionIds)].sort()` de-duplication
becomes redundant — `allCollectionIds` is already distinct. Simplify it to a plain `.sort()` of the
keys, but **keep the comment explaining that the sort spelling must match `commitOnce`'s
comparator**, and keep the de-duplication *fact* stated (the latch is non-reentrant; distinctness
is now guaranteed upstream instead of at the acquisition).

## The second arm: `execute`'s success fold is missing two steps `commitOnce` does

Found on the same loop while confirming the fix. `commitOnceLatched`'s success fold
(`coordinator.ts` ~465) does four things per participant:

    recordCommitted → applyCommittedToCache → tracker.reset → clearPendingActions

`execute`'s success fold does two: `recordCommitted → tracker.reset`. Both omissions are real, both
are dormant for the same reason (nothing calls `execute`), and both live at the exact lines this
ticket is already editing:

- **Missing `applyCommittedToCache`.** The tracker is reset but the read cache still holds
  pre-commit blocks, so a collection with prior committed state keeps serving the stale revision
  after a successful `execute` — `update()` sees its revision is already current and refetches
  nothing. This is the precise failure `applyCommittedToCache`'s doc comment exists to describe.
  Note the required order: cache **before** `tracker.reset`, because the transforms are read live.
- **Missing `clearPendingActions`.** The actions stay in the collection's pending queue after a
  successful `execute`. `commitOnce` selects participants by non-empty tracker transforms, so the
  stale queue is invisible until the same collection is staged again — at which point
  `getPendingActions()` returns the old actions plus the new ones and re-logs the already-durable
  ones. Same double-apply hazard the NOTE at `coordinator.ts` ~416 warns about, reached through
  `execute`-then-`commit` on one coordinator instead of through a retry.

Apply both to the success fold **and** to the committed subset in the partial-commit fold, where
`commitOnce` applies them too. Keep both folds `await`-free: the NOTE above `commitOnce`'s fold
records that session-mode publish relies on it being event-loop-atomic across collections, and the
same reasoning applies here.

`collectionTransforms.get(collectionId)!` is the transforms argument for `applyCommittedToCache`,
and `recordCommitted` returns the revision to pass alongside it — exactly as `commitOnce` does.

## Third arm: `stampData` cleanup on the throwing path

With the throw gone, `this.stampData.delete(transaction.stamp.id)` after the success fold is
reached normally again. No code change needed — but do not move it into a `finally`: the failure
paths deliberately leave the stamp tracked so `rollback(stampId)` still has something to unwind.

## Edge cases & interactions

- **Two batches, one collection, single-collection transaction** — the headline case. Commits at
  one revision, one log entry carrying both actions, `execute` returns `success: true`.
- **Two batches for one collection *and* a second collection in the same transaction** — the
  multi-collection coordination path (GATHER runs) with a duplicate mixed in. Latch acquisition
  must still be sorted and must take exactly two latches.
- **Interleaved duplicates** (batches for A, then B, then A again) — grouping must not reorder a
  collection's own actions and must not drop the middle batch. Latch order stays sorted regardless
  of arrival order.
- **Three or more batches for one collection** — the concatenation is a fold, not a pairwise merge;
  the third batch must not be lost.
- **Duplicate collection on the partial-commit path** — a multi-collection transaction where the
  duplicated collection is in `committedCollections` and another participant failed. The committed
  subset gets the full success-path local treatment exactly once.
- **Self-deadlock** — the latch is non-reentrant. The existing duplicate-collection test exists
  because a regression here *hangs* rather than failing an assertion; the mocha timeout is the
  detector. Keep that property: the test must still reach its assertions at all.
- **`execute` then `commit` on the same coordinator and collection** — the `clearPendingActions`
  arm. The second, session-mode commit must log only the second set of actions.
- **`execute` on a collection with prior committed state, then read through the same instance** —
  the `applyCommittedToCache` arm. The read must serve the new revision, not the cached prior one.
- **Empty and single-batch transactions** — the ordinary case must be untouched. The
  `result.actions.length === 0` short circuit stays ahead of the grouping.
- **A batch with an empty `actions` array** — grouping must still register the collection as a
  participant (it is one; `applyActionsToCollection` appends its entry from the live tracker) and
  must not crash on the spread.

## Tests

Home is `packages/db-core/test/coordinator-latch-span.spec.ts` — the duplicate-collection case
already builds exactly this transaction, and `transaction.spec.ts` is already flagged as oversized
(`debt-transaction-spec-oversized`), so do not grow it.

- **Rewrite the existing duplicate case's outcome from unasserted to asserted.** Its long comment
  explaining why the outcome is deliberately unasserted, and why the coordinator is "poisoned"
  afterwards, both go away. What it must keep: the acquisition-order assertion (`order` deep-equals
  `[collectionA]` — one latch, deduped) and the "reaching this line at all" property. What it
  gains: `result.success` is true; a freshly opened `Collection` over the same storage reads back
  **one log entry carrying both actions** — `selectLog()` yields `['first', 'second']` in that
  order, not `['first']` and not `['first', 'first', 'second']`; and the fresh handle and the
  committing instance agree on revision and lineage (`committedRevision()`, `committedActionId()`),
  same shape as the multi-collection case above it.
- **`results` is complete.** `result.results` has exactly one entry for the collection.
  `applyActionsToCollection` still returns `results: []` unconditionally (there is a standing TODO
  there about collecting handler return values), so assert the map's *shape* — one key, no batch's
  entry overwritten — not its contents. Say so in a comment, so the next reader does not mistake
  the empty array for the bug.
- **Duplicate mixed with a second collection.** Two batches for `span-a` plus one for `span-b`,
  built so `allCollectionIds` arrives b-then-a; assert success, sorted acquisition order
  `[span-a, span-b]`, exactly two latches, and both collections durable with `span-a`'s two actions
  in one entry.
- **`execute` then `commit` re-logs nothing.** Run `execute` with one action on a collection, then
  stage a second action directly and drive `coordinator.commit`. The collection's log must hold two
  entries with one action each — not a second entry replaying the first action. Fails before the
  `clearPendingActions` fix.
- **A read after `execute` is not stale.** Use a collection that already has committed state (commit
  once, then `execute` a second action through the same instance) and read through that same
  instance. It must observe the second action. Fails before the `applyCommittedToCache` fix.

## TODO

- Group `result.actions` by collection id in `execute` after `applyActions`, preserving
  first-appearance collection order and per-collection action order; derive `allCollectionIds`, the
  latch set, the apply loop and both folds from that grouping.
- Simplify the now-redundant `[...new Set(...)]` in the latch acquisition, keeping the sort and the
  comment about matching `commitOnce`'s comparator.
- Add `applyCommittedToCache` (before `tracker.reset`) and `clearPendingActions` to `execute`'s
  success fold and to the committed subset of its partial-commit fold; keep both folds await-free.
- Delete the `NOTE:` above the success fold that points at this ticket by slug, and the matching
  paragraph in the duplicate-collection case in `coordinator-latch-span.spec.ts`.
- Rewrite the duplicate-collection case to assert the outcome, and add the four new cases above.
- Run `yarn workspace @optimystic/db-core test` in the foreground with no redirection, plus a type
  check (`yarn workspace @optimystic/db-core build`, or `tsc --noEmit` in that package). The latch cases
  detect regressions by hanging, so a timeout there is a real failure, not flake.
