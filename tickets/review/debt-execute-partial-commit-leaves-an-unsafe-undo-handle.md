description: When a transaction saved to some data collections but permanently failed on another, one of the two ways of running a transaction used to hand the caller an "undo" button that would have corrupted the data that already saved, and left the failed half half-written. That path now behaves like the other one; this ticket is the code-review pass over the change.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` — pre-stage snapshot ~659-676, rewritten step-2 comment ~682-696, partial-commit branch ~771-805)
  - packages/db-core/src/collection/collection.ts (`snapshotPending` / `restorePending` — read only, unchanged)
  - packages/db-core/test/transaction.spec.ts (partial-commit describe block: 1 updated case + 3 new cases)
  - packages/db-core/test/coordinator-latch-span.spec.ts (unchanged; regression surface for `coordinator.execute()` failures)
  - docs/transactions.md ("Honest-reporting contract" block)
difficulty: medium
----

# What landed

`TransactionCoordinator.execute()` now gives a **partial landing** — some collections durably
committed, at least one permanently lost its commit race — the same local disposition
`commit()` (`commitOnceLatched`) already gave it. Three code changes plus docs and tests.

**1. Pre-staging snapshot (coordinator.ts ~659-676).** Immediately before the
`await this.applyActions(result.actions, transaction.stamp.id)` call in step 1b, and after the
empty-actions guard, `execute()` captures one `snapshotPending()` per **distinct** participating
collection into `preStageSnapshots`, keyed by collection id with first-appearance dedupe. No
`await` sits between the capture loop and `applyActions` — an interleaved stage would otherwise
land inside the snapshot. Unregistered collections are skipped (`applyActions` throws on them a
moment later and the existing `catch` converts that to a failure result, so the map is never
read on that path).

**2. Partial-commit branch gets an `else` arm and drops the stamp (~771-805).** The existing
await-free fold loop over `batches.keys()` was restructured to `if (!collection) continue;` then
`if (committed.has(id)) { …unchanged four-step success fold… } else { restorePending(preStage) }`.
After the loop — still inside `if (committed.size > 0)` —
`this.stampData.delete(transaction.stamp.id)`.

The delete is deliberately **inside** the `committed.size > 0` guard. The empty-committed
(nothing-durable) failure keeps its stamp, because `rollback(stampId)` is a valid *and complete*
recovery there — it also replays other in-flight stamps, which a targeted restore cannot.

**3. Stale comment rewritten (~682-696).** The old block claimed `execute()` is deliberately not
snapshot/restore-wrapped *because* `rollback(stampId)` can unwind it. It now states the actual
two-way split: failure-before-anything-durable keeps its tracker state and its stamp
(`rollback` is the recovery); partial landing folds the winner, restores the loser to
pre-staging, and drops the stamp.

**4. `docs/transactions.md`.** The one-sentence `coordinator.execute()` claim in the
honest-reporting block was replaced with the real behaviour plus a new paragraph on the
**caller-recovery difference**: re-driving `commit()` for the same transaction re-attempts only
the failed collection (the winner's pending queue was cleared), while re-driving the *same*
transaction through `execute()` would double-apply the winner, because `execute()` re-runs the
engine and re-stages every collection it names. An `execute()` caller reconciling a partial
landing must build a **new** transaction naming only the failed collections.

## Why pre-staging, not pre-append

`commitOnceLatched` restores to "staged but not yet log-appended" because its caller re-drives
`commit()`, which re-reads `getPendingActions()` and *needs* the actions still staged.
`execute()` re-stages from the engine on every call, so restoring only to pre-append would leave
this attempt's actions in the pending queue and a re-drive would stage them twice. Pre-staging is
also exactly the state `rollback()` would have restored to — which is what makes dropping the
stamp lossless rather than a downgrade.

## Explicitly not changed (per the plan ticket's settled decisions)

- `TransactionCoordinator.rollback` is untouched. A scoped "skip the landed collections" rollback
  cannot be done from inside the latched span (replay goes `applyActionsRaw` → `collection.act` →
  `Latches.acquire`, the same non-reentrant latch already held → deadlock).
- The apply-loop early return and the empty-committed coordination failure got **no** restores.
- `restorePending` still does not roll `source.actionContext` back; context advance stays
  monotonic on purpose.

# Validation

**Full db-core suite: 1574 passing, 0 failing.**
`cd packages/db-core && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min`

**Workspace typecheck: clean.** `yarn typecheck` (Done in 7s). `packages/db-core/tsconfig.json`
includes `test`, so the new tests are typechecked too.

**`coordinator-latch-span.spec.ts` stays green** — all 12 cases pass, including the four that
drive `coordinator.execute()` into failures (`execute releases the span when the commit fails
inside it`, the coalescing cases, `execute clears the pending queue…`).

**Non-vacuity check (done, then reverted).** I temporarily neutered both halves of the fix
(replaced the `restorePending` call with a no-op, deleted the `stampData.delete` line) and re-ran
the three new tests: **2 failing, 1 passing** — exactly the expected split. The two
partial-landing tests genuinely bite; the empty-committed test passes either way *by design*
(it asserts the case the change must NOT alter). The file was restored from a scratchpad copy
and re-verified by grep before the full run above.

## Test cases (all in the `Multi-collection partial commit honest reporting` describe block of `packages/db-core/test/transaction.spec.ts`)

- **`execute() drops the undo handle on a partial landing, so a later rollback() cannot corrupt
  the winner`** (new). `FailCollectionNTimesTransactor(inner, 'posts', Infinity)`, a prior
  users-only commit to give the winner durable state, then the partial `execute()`. Asserts
  `stampData.has(stamp.id)` is `false`, calls `await coordinator.rollback(stamp.id)`, then
  asserts the winner is untouched: `usersTree.get(1)` is Alice, `get(0)` is Zero,
  `getPendingActions()` is `[]`, tracker staged-change count is 0.
- **`execute() restores the failed collection to its pre-staging state on a partial landing (and
  leaves it readable)`** (new). Captures `prePosts = postsCollection.snapshotPending()` before
  the partial `execute()`; asserts `tracker.transforms` and `getPendingActions()` deep-equal the
  snapshot, `postsTree.get(100)` is `undefined`, and a read through the invented (never-synced)
  `posts` collection still works — the structural baseline survived, which is the whole reason
  the restore uses `restorePending` and not a reset-to-empty.
- **`a clean (empty-committed) execute() failure keeps its undo handle, and rollback() unwinds
  every tracker`** (new). `FlakyCommitTransactor(inner, Infinity)`. Asserts `success` false with
  `committedCollections` `undefined`, `stampData.has(stamp.id)` still `true`, then rollback and
  both trackers' transforms match their pre-staging snapshots. Deliberately does **not** assert
  pending queues (see the known gap below).
- **`execute() surfaces the partition on ExecutionResult…`** (existing, at the old line 4033).
  Its "The execute() path is NOT snapshot/restore-wrapped" comment was rewritten to the current
  truth, and a `stampData.has(...)` is `false` assertion was added.

# Known gaps / things a reviewer should push on

- **No test covers the "engine names one collection twice, and that collection is the loser"
  path.** The dedupe logic (`if (preStageSnapshots.has(collectionId)) continue;`) is exercised
  only indirectly — `coordinator-latch-span.spec.ts` has duplicate-batch cases, but they all
  *succeed*, so they never reach the new `else` arm. A test that both duplicates a collection
  and makes it lose would close this. I judged it low-risk (the dedupe is three lines and mirrors
  the `batches` grouping directly above) but it is a genuine hole.
- **The blind-overwrite hazard is documented, not defended.** The `NOTE:` at the `else` arm says
  another stamp's work staged on the loser between snapshot and restore is discarded. That is the
  same assumption `rollback()` already carries, and it cannot be softened under the latch — but
  nothing detects or asserts it. Recorded as a tripwire at the code site, not filed.
- **`coordinator.rollback` still does not restore pending queues** — pre-existing, tracked by
  `bug-coordinator-rollback-leaves-pending-queue-populated`. Directly relevant to a reviewer here:
  the empty-committed test asserts only tracker transforms after rollback, *not* pending queues,
  and that omission is load-bearing rather than sloppiness. The pre-staging restore on the
  `execute()` partial path *does* restore pending queues, and that case does assert them.
- **`execute()` is still test-only.** Nothing in `src/` calls `coordinator.execute` (the
  `engine.execute` call at coordinator.ts:613 is a different method on a different object), so
  every claim here is confirmed by reading code plus the new tests, not by a production repro.
- **`preStageSnapshots` is captured unconditionally, even on the overwhelmingly common
  all-succeed path.** `snapshotPending()` deep-copies transforms and `structuredClone`s the
  action context per participant, so this is real work done on every `execute()` to serve a rare
  branch. Not measured. `commitOnceLatched` already pays the identical cost on every commit, so
  this is symmetry rather than a new class of overhead — but a reviewer with a profile in hand
  may disagree.
- **The two `docs/transactions.md` sentences about `execute()` now sit ~30 lines apart** (the
  rewritten honest-reporting paragraph, and the older "intentionally not retry-wrapped" line
  further down). The second is still accurate and is about *retry*, not recovery, so I left it —
  but it now partly restates the first.
