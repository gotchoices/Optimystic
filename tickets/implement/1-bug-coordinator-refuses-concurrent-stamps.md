description: Two database transactions can currently be open at once against the same data, and saving one of them silently writes the other's unsaved changes into permanent storage. Make the system refuse the second transaction with a clear error instead, since it cannot keep the two apart.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` decl ~63-92; `applyActions` ~109-125; `commit` ~204; `commitOnceLatched` success fold + NOTE ~522-540; `execute` ~696, partial-commit delete + NOTE ~900-920, success delete ~950; `applyActionsToCollection` ~1003 — the whole-tracker transforms read that rules out a tag-scoped fix)
  - packages/db-core/src/transaction/errors.ts (add `CoordinatorConcurrentStampError` beside `CoordinatorPartialCommitError` / `CoordinatorStaleLossError`)
  - packages/db-core/src/transaction/index.ts (line 37 — the errors barrel export)
  - packages/db-core/test/coordinator-single-stamp.spec.ts (new)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (multi-stamp tests to remove/convert — see below)
  - packages/db-core/test/transaction.spec.ts (~3387 and ~3437 — the two multi-session tests)
  - packages/db-core/test/coordinator-latch-span.spec.ts (~438-470 — two coordinators over shared instances; must KEEP passing)
  - docs/transactions.md (~137-162, "One writer at a time on the shared TransactionBridge")
difficulty: hard
repro: verified
----

# The decision

`TransactionCoordinator` now permits **at most one open transaction stamp at a time.**
A second stamp is refused with a new `CoordinatorConcurrentStampError`. Callers that
genuinely need two concurrent writers must give each writer its own `Collection`
instances — which is exactly what `docs/transactions.md` already tells them ("each
writer needs its **own** bridge").

This is a narrowing of a public, exported API. It is the right narrowing, and the
rest of this ticket says why.

# What is broken today

A `Collection` holds exactly **one** staged state: its tracker transforms plus one
pending-action queue, shared by every open stamp. The coordinator's `stampData` map
pretends otherwise — it records per-stamp snapshots and per-stamp action batches over
state that belongs to the collection, not to any stamp.

Verified against `TestTransactor`, one coordinator, one collection, reading the durable
log through a fresh reader after each step:

```
stage action 'A' under stamp A   (coordinator.applyActions)
stage action 'B' under stamp B   (coordinator.applyActions)

coordinator.commit(A)      -> durable log reads ['A','B']   <- B's action written under A's id
coordinator.rollback(B)    -> log still ['A','B']; the collection's pending queue now
                              holds A's already-durable action again
stage action 'C', commit   -> durable log reads ['A','C']   <- A written twice, B's record gone
```

Two symptoms, one representational cause:

- **Committing a stamp writes the sibling's work durably.** `commitOnceLatched`'s append
  loop builds each log entry from `collection.getPendingActions()` — the collection's
  *whole* queue.
- **Rolling the sibling back afterwards rewinds past the commit.** The commit fold
  deletes only its own `stampData` entry, so the sibling's snapshot still describes the
  pre-commit world and restoring it re-queues an already-durable action.

# Why refusal, and not one of the repairs

## Tag-scoped commit is dead on arrival

Every staged action carries its stamp id (`applyActionsRaw` sets `Action.transaction`),
so filtering the pending queue by tag looks tempting. It does not work, and it makes
things worse.

`applyActionsToCollection` (coordinator.ts ~1003) reads `collection.tracker.transforms`
— the **whole** tracker — and that transform set is the payload that gets pended and
durably committed to the cluster. Transforms carry no stamp tag and cannot be
decomposed by one. So a queue filter would still commit the sibling's *data* while
omitting its actions from the recorded log entry: the durable transforms would no
longer match what a validator gets by re-executing the recorded actions, which is a
worse failure than the one being fixed.

Two further blockers for tag-scoping, either of which is fatal on its own:

- On the shipping (Quereus) path the pending actions are **untagged**. `Tree.stage`
  (`packages/db-core/src/collections/tree/tree.ts:164`) calls `collection.act(...)`
  directly with no `transaction` field; the coordinator only sees an empty-actions
  `applyActions` call acting as a pre-stage barrier. A tag filter would commit nothing.
- Tombstoning the committed stamp's `stampData` entry (the option the existing `NOTE:`
  in `execute` proposes) fixes only the stale-snapshot half, for the same reason.

## Per-stamp staged state is an adapter change, not a coordinator change

Giving each stamp its own tracker and queue would make the bad state unrepresentable,
but it forces every read to be stamp-scoped, and reads have no stamp: `Tree.get` and
the scans read through `Collection.tracker`, and `Tree.stage` has no stamp at all.
Reaching stamp-scoped reads means per-stamp `Collection` instances, hence per-stamp
`Tree` instances, hence a per-writer table cache — which *is* "own bridge per writer".
The answer therefore lives in the Quereus adapter, not in `TransactionCoordinator`.

## Concurrent stamps are not a capability worth preserving

The machinery today does isolate rollback across stamps, and there are passing tests
for it. But two stamps staging into one shared tracker read each other's uncommitted
rows — `transaction.spec.ts:3387` shows both sessions reading the same `usersTree`
through the same tracker. So what concurrent stamps on one coordinator actually offer
is: cross-transaction dirty reads, no isolation, and no commit that can ever be
correct. Refusing the configuration removes a hazard, not a feature.

**Tradeoff, stated honestly:** this deletes tested behaviour and retires roughly a
hundred lines of carefully hardened replay code (two landed bug fixes' worth). It is
still the right call — that code exists only to serve a configuration that can never
legally commit. The retirement itself is the follow-on ticket
`coordinator-drop-multi-stamp-replay-machinery`.

# What to build

## The error

`CoordinatorConcurrentStampError` in `packages/db-core/src/transaction/errors.ts`,
carrying the already-open stamp id and the rejected stamp id. Message must name both
and state the recovery: the open stamp has to be committed or rolled back first.
Export it from `packages/db-core/src/transaction/index.ts` (line 37 already exports the
other two coordinator errors).

## Three guards

- **`applyActions` (~109)** — before creating the entry and before `captureUncaptured`:
  if `stampData` holds any key other than `stampId`, throw. This must sit inside the
  method's existing **await-free prologue**; `captureUncaptured` is synchronous-by-contract
  and the first `await` is `applyActionsRaw`, so the check, the entry creation and the
  capture stay one atomic step.
- **`commit` (~204)** — before the retry loop: if any tracked stamp key differs from
  `transaction.stamp.id`, throw. Not retryable; it escapes immediately like any hard
  failure. This guard is what catches a caller that stages through `Tree.stage` and
  commits without ever calling `applyActions`, while a sibling stamp is tracked.
- **`execute` (~696)** — before the pre-stage snapshot loop: same check, but **return
  `{ success: false, error }`** rather than throwing. That matches `execute`'s local
  convention (it converts `applyActions`' "Collection not found" throw into a failure
  result).

Resulting invariant, which the follow-on ticket depends on:
**`stampData.size <= 1` at all times.**

## Release and the wedge hazard

Entries are dropped on commit success (~540), partial commit (~493), `execute` success
(~950), `execute` partial commit (~920), and `rollback` (~564). A **clean commit
failure deliberately keeps the entry** so `rollback(stampId)` stays a valid and
complete recovery — so an abandoned failed commit now wedges the coordinator against
new stamps until someone calls `rollback`. That is a real behaviour change; put the
recovery in the error message.

Do **not** add expiry-based auto-eviction: `applyActions` receives only a stamp id,
not the stamp, so it cannot test expiry. Adding a stamp argument is out of scope.

## Comments that must change

- `commitOnceLatched` success fold (~533-540) — the `NOTE:` naming this ticket as a
  latent defect. Replace with the enforced invariant.
- `execute` partial-commit delete (~908-919) — the `NOTE:` proposing a tombstone.
  Replace likewise; the tombstone is no longer the plan.

# Tests

New file `packages/db-core/test/coordinator-single-stamp.spec.ts`. Model the fixtures
on `coordinator-rollback-pending.spec.ts` (its `stage` helper mints a fresh stamp per
call, which is exactly the shape these tests need).

- **The repro, now refused.** Stage `'A'` under stamp A; `applyActions` under stamp B
  rejects with `CoordinatorConcurrentStampError`. Commit A → a fresh reader on the same
  storage sees the durable log as `['A']`. Stage `'C'` under a fresh stamp and commit →
  `['A','C']`. This is the ticket's acceptance case.
- **`commit` with an untracked stamp** while another stamp is tracked → throws.
- **`execute`** while another stamp is tracked → `{ success: false }` whose error names
  the open stamp.
- **Release paths reopen the coordinator**: after `rollback(A)`, and separately after a
  successful `commit(A)`, a new stamp is accepted.
- **Same stamp, many batches** — repeated `applyActions` under one stamp id must not
  trip the guard. Include the empty-actions call the Quereus pre-stage barrier makes.

Remove or convert the tests that assert the retired behaviour. The mechanical signal is
**more than one `stage(coordinator, …)` call on the same coordinator** — each call mints
a fresh stamp:

- `coordinator-rollback-pending.spec.ts` ~220 (`leaves a survivor exactly one queued
  action`), ~234 (`keeps every survivor once when a lower-order stamp staged after a
  higher-order snapshot`), ~434 (`drops only the rolled-back stamp when a survivor
  staged into the late collection first`), ~461 (`drops the rolled-back stamp in the
  mirror direction`), ~522 (`rewinds the late collection on a SECOND rollback`) —
  delete.
- `coordinator-rollback-pending.spec.ts` ~257 (`clears the rolled-back stamp from every
  collection it touched, leaving a survivor alone`) — **convert**, don't delete: drop
  the survivor stamp and keep the multi-collection half, which is still worth covering.
- `transaction.spec.ts` ~3387 (`should only rollback the given session transforms,
  preserving other sessions`) and ~3437 (`should preserve interleaved batches from
  lower-order stamp when higher-order stamp is rolled back`) — delete. Add one
  replacement asserting that a second `TransactionSession` on the same coordinator fails
  its first `execute`. Note `TransactionSession.execute` **catches** and returns
  `{ success: false, error }`, so assert on the returned result, not on a throw.

`coordinator-latch-span.spec.ts` ~438-470 uses two coordinators over the same collection
instances on purpose. It must keep passing — see the edge cases below.

# Edge cases & interactions

- **Same stamp, repeated calls.** The normal path calls `applyActions` once per
  statement. The guard keys on "a *different* stamp is tracked", never on "a stamp is
  tracked".
- **The Quereus pre-stage barrier.** `txnBridge.addStatement` drives
  `applyActions(<empty array>, stampId)` purely to trigger capture. That still creates a
  `stampData` entry with no batches, and it correctly counts as "open" — meaning a second
  bridge trips the guard at its first *statement*, not at `BEGIN`. Say so in the error
  message so the failure is diagnosable.
- **Two coordinators over one collection set.** The guard is per-coordinator, so it does
  not catch this, and `coordinator-latch-span.spec.ts` ~438 depends on it not catching
  this. That hole is the caller's contract ("own bridge per writer"), unchanged and
  out of scope. Do not try to close it here.
- **Untracked staging.** A caller using only `Tree.stage` + `coordinator.commit` creates
  no `stampData` entry at all, so two such callers are invisible to every guard. Also
  out of scope — the coordinator has no handle on staging it never saw.
- **Abandoned failed commit.** Covered above; the wedge is intentional and must be
  spelled out in the error message.
- **Partial commit then a new stamp.** The partial-commit branch drops the entry, so a
  new stamp is accepted while the collection state is degraded. Unchanged; the bridge's
  degraded latch is what refuses reads there.
- **`rollback` of an untracked stamp** stays a no-op — `coordinator-rollback-pending.spec.ts`
  ~339 locks this and must keep passing.
- **Interleaving during a commit.** The `applyActions` guard must be in the await-free
  prologue (above), so a stamp cannot be registered between the commit guard's check and
  the log append.

# Docs

`docs/transactions.md`, alongside "One writer at a time on the shared TransactionBridge"
(~137-162): add a subsection stating the coordinator's actual contract — at most one open
stamp; a second is refused with `CoordinatorConcurrentStampError`; a stamp is released by
commit (success or partial) or by rollback; a failed commit keeps its stamp open until
rolled back; concurrent writers need their own `Collection` instances. Be explicit that
this is a per-coordinator guard and two coordinators sharing collection instances are
still the caller's problem.

# TODO

- Add `CoordinatorConcurrentStampError` to `errors.ts`, carrying both stamp ids and the
  recovery instruction; export it from `transaction/index.ts`.
- Guard `applyActions` in its await-free prologue.
- Guard `commit` before the retry loop (throws).
- Guard `execute` before the pre-stage snapshot loop (returns a failure result).
- Rewrite the two `NOTE:` blocks that name this ticket (`commitOnceLatched` success fold,
  `execute` partial-commit delete) to state the enforced invariant.
- Add `packages/db-core/test/coordinator-single-stamp.spec.ts` with the cases above.
- Delete the five multi-stamp tests in `coordinator-rollback-pending.spec.ts`; convert the
  sixth (~257) to single-stamp.
- Delete the two multi-session tests in `transaction.spec.ts`; add the refusal replacement.
- Update `docs/transactions.md`.
- Run the db-core build and test suite in the foreground; confirm
  `coordinator-latch-span.spec.ts` and the surviving `coordinator-rollback-pending.spec.ts`
  cases still pass.
