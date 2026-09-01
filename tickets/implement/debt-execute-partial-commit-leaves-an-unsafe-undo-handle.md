description: When a transaction saves to some data collections but permanently fails on another, one of the two ways of running a transaction hands the caller an "undo" button that would corrupt the data that already saved, and leaves the failed half in a half-written state. Make that path behave like the other one.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` — staging call ~700, stale comment ~648-657, partial-commit branch ~744-771)
  - packages/db-core/src/collection/collection.ts (`snapshotPending` ~616-635, `restorePending` ~637-643)
  - packages/db-core/test/transaction.spec.ts (existing case at ~4033, in the partial-commit describe block)
  - packages/db-core/test/coordinator-latch-span.spec.ts (other `coordinator.execute()` failure cases — must stay green)
  - docs/transactions.md (the "Honest-reporting contract" block, lines 63-105)
difficulty: medium
----

# Background

A transaction can touch several collections. Normally all of them save or none do. But one
collection can permanently lose a race to a competing writer *after* its siblings already
saved — a **partial landing**. The coordinator does not hide this: it reports which
collections landed and which did not, and the caller reconciles.

Two entry points run a transaction:

- `TransactionCoordinator.commit()` (body: `commitOnceLatched`) — the shipped one.
- `TransactionCoordinator.execute()` — an alternative entry point reached only by tests today
  (`engine.execute` at coordinator.ts:613 is a different method on a different object; nothing
  in `src/` calls `coordinator.execute`).

On a partial landing the two diverge in two ways. Both are confirmed by reading the code; there
is no runtime repro because nothing outside tests reaches `execute()`.

**1. The failed half is never unwound.** `commitOnceLatched` snapshots every participant before
the log-append loop and calls `restorePending(...)` on each collection that did *not* commit.
`execute()` takes no such snapshot and its partial branch has no `else` arm, so the losing
collection keeps a log entry that was appended to its tracker but never stored, plus the
transaction's actions still sitting in its pending queue.

**2. The undo handle survives and is unsafe.** `commitOnceLatched` deletes the transaction's
`stampData` entry on a partial landing. `execute()` does not. `TransactionCoordinator.rollback`
(reached in shipped code via `session.rollback()`) is all-or-nothing: it rewinds every
collection's tracker to a snapshot taken before the transaction's first action, then replays
other in-flight stamps. Run it after a partial landing and the collection that *did* save is
rewound too — re-staging already-durable actions, so tracker memory disagrees with storage.

# Decision (settled — do not re-open)

Take the pre-staging snapshot **and** drop the undo handle. Concretely: options (3) and (1)
from the plan ticket, together. Reasons for the calls that were open:

**Why not teach `rollback` to skip the landed collections (plan option 2).** It cannot be done
from inside `execute()`'s partial branch, which runs with every participant's instance latch
held. Skipping a collection is only half the job — the other in-flight stamps' actions must be
replayed onto the collections that *were* rewound, and replay goes
`applyActionsRaw` → `collection.act` → `Latches.acquire(this.latchId)`, the same non-reentrant
latch we are holding. It would deadlock. A scoped rollback would have to be restructured
outside the latched span, which is a much larger change than this ticket, and the plan's second
complication (other stamps' recorded snapshots being stale for a skipped collection) is real on
top of it. Rejected.

**Which unwind point for the failed half — pre-staging, not pre-append.** `commitOnceLatched`
restores to "staged but not yet written to the log", because its caller re-drives `commit()`,
which re-reads `getPendingActions()` and therefore *needs* the actions still staged. `execute()`
is different: it re-runs `engine.execute(transaction)` and re-stages the returned actions itself
on every call. Restoring only to pre-append would leave this attempt's actions in the pending
queue, so any re-drive would stage them a second time. The failed half must therefore go back to
**exactly the state it was in before `execute()` staged anything** — which is also, not by
coincidence, the state `rollback()` would have restored it to. That is how this change delivers
the useful half of option 2 without touching `rollback`.

# What to build

## `execute()` — capture a pre-staging snapshot

Synchronously, immediately before the `await this.applyActions(result.actions, transaction.stamp.id)`
call in step 1b (~coordinator.ts:700), capture one snapshot per distinct participating collection:

```ts
const preStageSnapshots = new Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>();
for (const { collectionId } of result.actions) {
    if (preStageSnapshots.has(collectionId)) continue;
    const collection = this.collections.get(collectionId);
    if (collection) preStageSnapshots.set(collectionId, collection.snapshotPending());
}
```

- Keyed by `collectionId` with first-appearance dedupe, so an engine that names one collection
  in two `CollectionActions` batches yields one snapshot of the state before *either* batch.
- `snapshotPending()` is synchronous and latch-free. **No `await` may sit between the capture
  loop and the `applyActions` call** — an interleaved stage would end up inside the snapshot.
- An unregistered collection is skipped here; `applyActions` throws on it moments later and the
  existing `catch` converts that to a failure result, so the map is simply never read.

## `execute()` — partial-commit branch

Extend the existing await-free fold loop (~coordinator.ts:748-758) with an `else` arm, then drop
the stamp:

```ts
for (const collectionId of batches.keys()) {
    const collection = this.collections.get(collectionId);
    if (!collection) continue;
    if (committed.has(collectionId)) {
        // ...unchanged four-step success-path fold...
    } else {
        // NOTE: blind overwrite of this collection's staged state — any OTHER stamp's actions
        // staged on it between the pre-stage snapshot above and here are discarded. Same
        // single-call-path assumption rollback() documents. It cannot be softened by replaying
        // the other stamps here: replay goes through collection.act, which takes the same
        // non-reentrant instance latch this span already holds.
        const snapshot = preStageSnapshots.get(collectionId);
        if (snapshot) collection.restorePending(snapshot);
    }
}
this.stampData.delete(transaction.stamp.id);
```

The loop must stay `await`-free, for the same reason the success fold is (session-mode publish
relies on it being event-loop-atomic across collections). `restorePending` is latch-free by
contract — it is named in `commitOnceLatched`'s doc comment as safe to call under the latch.

Note `restorePending` restores tracker transforms and the pending queue but deliberately does
**not** roll `source.actionContext` back to the captured `context`. Leave that as is: context
advance is monotonic on purpose. Do not "fix" it in this ticket.

## `execute()` — rewrite the stale comment

The block at ~coordinator.ts:648-657 currently claims `execute()` is deliberately not
snapshot/restore-wrapped *because* `rollback(stampId)` can unwind it. After this change that
justification is only true for the failure paths where nothing landed durably. Replace it with
the actual split:

- Failure **before** any durable commit (engine failure, log-append failure, a coordination
  failure with an empty committed set): unchanged — the appended-but-uncommitted tracker state
  survives and `stampData` is kept, so `rollback(stampId)` remains the caller's recovery.
- **Partial landing**: the committed half gets the success-path fold, the failed half is
  restored to pre-staging, and the stamp tracking is dropped so no unsafe undo remains.

## Other failure returns — leave alone

Do **not** add restores to the apply-loop early return or the empty-committed coordination
failure. Nothing durable landed on those paths, `rollback(stampId)` is a valid and *complete*
recovery there (it replays other in-flight stamps, which a targeted restore cannot), and adding
a blind restore would introduce the overwrite hazard on paths that do not need it.

## `docs/transactions.md`

The sentence "`coordinator.execute()` mirrors this on its (non-retryable) path by surfacing
`committedCollections`/`failedCollections` on the `ExecutionResult`" overstates what it does and
says nothing about recovery. Replace it with what is now true:

- `execute()` reports the partition on the `ExecutionResult` instead of throwing.
- The committed half gets the success-path fold; the failed half is restored to the state it was
  in before `execute()` staged anything.
- The transaction's rollback tracking is dropped, so `rollback(stampId)` after a partial landing
  from `execute()` is a **no-op**, not a corrupting rewind. This matches `commit()`.
- Caller recovery differs between the two entry points, and the doc should say so plainly:
  re-driving `commit()` for the same transaction re-attempts only the failed collection (the
  winner's pending queue was cleared — locked by the "no double-apply" test at
  transaction.spec.ts:4119). Re-driving the **same** transaction through `execute()` does
  **not** have that property: `execute()` re-runs the engine and re-stages every collection the
  engine names, so the winner's actions would be applied a second time. An `execute()` caller
  reconciling a partial landing must build a new transaction naming only the failed collections.

# Edge cases & interactions

- **Engine names one collection twice.** `result.actions` may carry two batches for the same
  collection; `batches` coalesces them for the log-append. The snapshot map must dedupe by
  collection id (first appearance) so the restore returns to the state before the first batch,
  not between the two.
- **Unregistered collection in `result.actions`.** `applyActions` throws "Collection not found";
  the existing `catch` converts it to a failure result before the snapshot map is ever read.
- **Zero actions.** `execute()` returns `{ success: true }` before staging; the snapshot loop must
  sit after that guard so it never runs on an empty transaction.
- **All collections fail (empty committed set).** Not the partial branch. Behaviour unchanged:
  tracker state survives, `stampData` survives, `rollback` is the recovery. Assert this stays
  true — it is the case the change must NOT alter.
- **Single-collection `execute()`.** With one participant, a non-empty committed set means the
  transaction succeeded, so the partial branch is unreachable and the new `else` arm never fires.
  No special handling; just do not assume the loop always exercises both arms.
- **Brand-new ("invented") collection on the failed side.** Its header/root blocks live in the
  tracker as uncommitted inserts. This is exactly why the restore uses `restorePending` rather
  than a reset-to-empty: a reset would leave the collection unreadable. Cover it with a test that
  reads through the failed collection after the restore.
- **Winner with prior committed state.** The read-cache fold on the committed half only bites
  when that collection already had durable state (a pristine collection's log tail lives in its
  own tracker). The existing test at transaction.spec.ts:4033 sets this up with a prior
  users-only commit — reuse that shape.
- **Interleaved second stamp.** Another stamp staging on the failed collection between the
  pre-stage snapshot and the restore has its work discarded. Recorded as the `NOTE:` above; it is
  the same assumption `rollback()` already carries, not a new one.
- **Latch discipline.** The restore runs inside the latched, await-free fold. Nothing added there
  may acquire a collection latch or await.
- **Pending queues are not restored by `rollback()` itself.** Separately filed as
  `bug-coordinator-rollback-leaves-pending-queue-populated`. Do not assert restored pending
  queues in any test that goes through `coordinator.rollback` — that assertion fails today for
  reasons this ticket does not fix. Assert restored pending queues only on the direct
  `execute()` partial path, which uses `restorePending` and does restore them.

# Tests

All in the partial-commit `describe` block of `packages/db-core/test/transaction.spec.ts`,
reusing the existing helpers (`FailCollectionNTimesTransactor`, `FlakyCommitTransactor`,
`createActionsStatements`, the local `buildTransaction`).

- **Undo after a partial landing cannot corrupt the winner.** Same setup as the case at line
  4033, including the prior users-only commit so `users` has durable state. Drive the partial
  `execute()`, then assert `(coordinator as any).stampData.has(transaction.stamp.id)` is `false`,
  call `await coordinator.rollback(transaction.stamp.id)`, and assert the winner is untouched:
  `await usersTree.get(1)` is still `{ key: 1, name: 'Alice' }`, `get(0)` is still `Zero`,
  `usersCollection.getPendingActions()` is `[]`, and the users tracker carries zero staged
  changes (reuse the inserts+updates+deletes count from the existing case). Without the
  `stampData.delete` this test fails: rollback rewinds `users` and re-stages durable actions.
- **The failed collection is left pre-staging clean.** Capture
  `prePosts = postsCollection.snapshotPending()` *before* the partial `execute()`. Afterwards
  assert `postsCollection.tracker.transforms` deep-equals `prePosts.transforms`,
  `postsCollection.getPendingActions()` deep-equals `prePosts.pending`, and
  `await postsTree.get(100)` is `undefined` — the loser's row is neither stored nor staged.
- **The failed collection is still readable.** In the same case, `posts` is an invented
  collection (created in-test, never synced), so a plain read through `postsTree` after the
  restore proves the structural baseline survived.
- **A clean (empty-committed) `execute()` failure keeps its undo handle.** With
  `FlakyCommitTransactor(inner, Infinity)`, run `execute()`, assert `success` is `false` with
  no `committedCollections`, assert `stampData.has(stampId)` is still `true`, then
  `await coordinator.rollback(stampId)` and assert both trackers' transforms match their
  pre-staging snapshots. Do not assert on pending queues here (see the edge case above).
- **Update the existing case at line 4033.** Its comment says "The execute() path is NOT
  snapshot/restore-wrapped"; that is no longer accurate. Rewrite the comment and add the
  `stampData` assertion to it rather than leaving a contradicting claim in the file.

# TODO

- Add the `preStageSnapshots` capture loop immediately before the `applyActions` call in
  `execute()`, after the empty-actions guard, with no intervening `await`.
- Add the `else` arm restoring the failed half in `execute()`'s partial-commit fold, with the
  `NOTE:` on the blind-overwrite / no-replay-under-latch tripwire.
- Add `this.stampData.delete(transaction.stamp.id)` to `execute()`'s partial-commit branch.
- Rewrite the stale "deliberately NOT snapshot/restore-wrapped" comment at coordinator.ts:648-657.
- Rewrite the `coordinator.execute()` sentences in `docs/transactions.md`'s honest-reporting
  block, including the caller-recovery difference between `commit()` and `execute()` re-drives.
- Add the four new tests and update the comment + assertions on the existing case at line 4033.
- Run the db-core test suite and confirm `test/coordinator-latch-span.spec.ts` stays green —
  several of its cases drive `coordinator.execute()` into failures and may observe post-failure
  tracker state.
- Run the workspace type check.
