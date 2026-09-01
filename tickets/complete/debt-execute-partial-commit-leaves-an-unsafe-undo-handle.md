description: When a transaction saved to some data collections but permanently failed on another, one of the two ways of running a transaction used to hand the caller an "undo" button that would have corrupted the data that already saved. That path now behaves like the other one, and this ticket records the code-review pass that confirmed it.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` — pre-stage snapshot, partial-commit branch)
  - packages/db-core/src/transaction/transaction.ts (`ExecutionResult.committedCollections` docstring)
  - packages/db-core/test/transaction.spec.ts (partial-commit describe block: 4 new/updated cases)
  - docs/transactions.md ("Honest-reporting contract" block)
----

# What landed

`TransactionCoordinator.execute()` now gives a **partial landing** — some collections durably
committed, at least one permanently lost its commit race — the same local disposition
`commit()` (`commitOnceLatched`) already gave it:

- A **pre-staging snapshot** per distinct participating collection is captured immediately before
  `applyActions()` (no `await` in between, so an interleaved stage cannot land inside it).
- The partial-commit branch gained an `else` arm: the collections that did **not** land are
  restored to that snapshot, while the winners keep the existing four-step success fold.
- `stampData` is dropped on that branch, so `rollback(stampId)` becomes a deliberate no-op rather
  than an all-or-nothing rewind that would re-stage the winner's already-durable actions.

The empty-committed (nothing-durable) failure is deliberately **unchanged**: it keeps its stamp,
because `rollback(stampId)` is a valid *and complete* recovery there — it also replays other
in-flight stamps, which a targeted restore cannot.

The unwind point is "before `execute()` staged anything", not "before the log append", because
`execute()` re-runs the engine and re-stages on every call; restoring only to pre-append would
leave this attempt's actions pending and a re-drive would stage them twice.

# Validation

- `yarn lint` — clean.
- `yarn lint:docs` — 45 documents, 71 anchored citations, 572 file mentions, 307 links, all resolve.
- `yarn typecheck` — clean (`packages/db-core/tsconfig.json` includes `test`, so the new cases are typechecked).
- `yarn test` (full workspace) — **all green, 0 failing**: 1575 + 2492 + 692 + 258 + 125 + 76 + 58 + 53 + 52 + 12 + 6 passing.

# Review findings

## Checked and clean (nothing found)

- **Restore completeness.** Verified `Collection.getNextRev()` is pure
  (`(source.actionContext?.rev ?? 0) + 1`) — it does not advance a counter — so the loser's log
  append and pend leave nothing behind for `restorePending` to miss. Tracker transforms plus the
  pending queue really are the whole of what `execute()` did to a loser locally.
- **Latch discipline.** The partial branch runs inside the latched span, before the `finally` that
  releases; `restorePending` is synchronous and latch-free by its documented contract, so the
  branch stays await-free and cannot self-deadlock. No new acquisition or replay was introduced.
- **Snapshot capture point.** Confirmed no `await` sits between the snapshot loop and
  `applyActions()`.
- **Set alignment.** `batches.keys()` is a subset of `result.actions`' collection ids, so every
  collection the fold loop visits has a snapshot. The `if (snapshot)` guard is defensive only —
  the coordinator's `collections` map is injected and never mutated (no `.set`/`.delete` on it
  anywhere in any `src/`). Left as-is: silently skipping is safer inside a latched span than a
  non-null assertion that would throw mid-fold.
- **Regression surface.** `coordinator-latch-span.spec.ts` (12 cases, four of which drive
  `execute()` into failures) stays green.

## Minor — fixed in this pass

- **The dedupe comment claimed a correctness rationale it does not have.** It read "dedupe is
  first-appearance ... so an engine naming one collection in two batches yields the state before
  EITHER batch". Disproved by mutation: deleting the
  `if (preStageSnapshots.has(collectionId)) continue;` line left the entire suite green, because
  the snapshot loop runs to completion *before any staging happens*, so every dedupe policy
  captures the identical state. The dedupe is a **cost** guard (`snapshotPending` deep-copies the
  transforms and `structuredClone`s the action context per entry), not a correctness one.
  Comment rewritten to say so.
- **The handoff's named test gap, closed — and reframed.** The handoff asked for a case where a
  collection is named twice *and* loses. Added
  `execute() restores a DUPLICATED failed collection to the state before EITHER of its batches`
  (`posts`, `users`, `posts` — non-adjacent duplicate). It does not lock the dedupe policy (see
  above, that is unobservable); what it locks is the composition the suite genuinely never
  covered: batch **coalescing** meeting the **restore arm**, unwinding both batches out of the one
  coalesced log entry. Non-vacuity verified — replacing the `restorePending` call with a no-op
  fails it; the source file was restored from a scratchpad copy and the suite re-run.
- **The caller-facing type said nothing about the behaviour change.**
  `ExecutionResult.committedCollections` in `transaction.ts` told a caller only that a non-empty
  set means "reconciliation is required" — while the most obvious next move, calling
  `rollback(stampId)` to clean up, now silently no-ops. Docstring extended: the stamp is dropped,
  `rollback` is a deliberate no-op on this branch, and reconciliation means a **new** transaction
  naming only the failed collections (re-driving *this* one would re-apply the winner).
- **Redundant docs sentence.** The trailing `coordinator.execute()` line in `docs/transactions.md`
  restated the honest-reporting paragraph ~30 lines above it. Trimmed to its actual subject
  (retry), which the paragraph above does not cover.

## Tripwires — recorded at the code site, not filed as tickets

- **Snapshot cost on the all-succeed path.** `preStageSnapshots` is captured unconditionally, so
  the common success case pays one deep transforms copy plus one `structuredClone` per participant
  to serve a rare branch. Unmeasured, and symmetric with `commitOnceLatched`. `NOTE:` at the
  snapshot loop naming the revisit condition (execute() showing up hot in a profile) and the way
  out (copy-on-first-stage, not dropping the restore).
- **`stampData.delete` shrinks another stamp's replay set.** `rollback()` rebuilds state by
  resetting to the earliest surviving `preSnapshot` and replaying the remaining stamps' batches.
  Deleting this stamp's entry removes its batches from that walk, so with a *second* stamp in
  flight whose snapshot was taken after this one staged, `rollback(otherStampId)` would reset to a
  snapshot still carrying this transaction's transforms — re-staging the winner's durable actions,
  the very corruption the delete prevents on the direct path. It is conditional (needs concurrent
  stamps on one coordinator, which nothing does today) and pre-existing — `commitOnceLatched`'s
  delete has the identical shape, so this diff mirrored it rather than introduced it. `NOTE:` at
  the delete site with the fix sketch (a tombstone entry keeping the snapshot for the replay walk,
  at both sites).

## Considered and not filed

- **Winner's `clearPendingActions()` discards unrelated staged actions.** A winner collection that
  carried pending actions from earlier, unrelated staging loses them, even though only the
  engine's batch actions were logged. Real, but pre-existing on both the success fold and the
  `commit()` path and completely untouched by this diff — not this ticket's finding.
- **No restores on the apply-loop early return or the empty-committed branch.** Settled by the
  plan ticket and now stated in the rewritten step-2 comment, which explicitly says "do not add
  blind restores to these paths". Left alone.
- **`restorePending` does not roll `source.actionContext` back.** Documented as monotonic by
  design.
- **`rollback()` does not restore pending queues.** Already tracked by
  `bug-coordinator-rollback-leaves-pending-queue-populated`; not re-filed. The empty-committed
  test's decision to assert only tracker transforms after rollback is correct and load-bearing
  because of it, and the partial-landing test *does* assert pending queues, since that path
  restores them.

## No new tickets

Nothing rose to major. Every finding was either fixed inline, parked as a tripwire at its code
site, or already tracked by an open ticket.

## Standing caveat carried forward from implement

Nothing in any `src/` constructs a `TransactionCoordinator` at all — it is instantiated only in
test files across `db-core`, `db-p2p`, and `quereus-plugin-optimystic`. So every claim here, in
both stages, rests on reading the code plus the tests, not on a production repro.
