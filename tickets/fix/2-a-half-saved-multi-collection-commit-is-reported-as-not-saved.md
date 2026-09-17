description: When one change touches several collections and its retry ends up saving some of them but not others, the caller is told only that the change failed. It is not told that part of it is permanently saved, so the application rolls back as if nothing had happened and its view no longer matches what is stored.
files:
  - packages/db-core/src/transaction/coordinator.ts (`TransactionCoordinator.commit` — the retry loop and its inter-attempt refresh; this is the one site)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError` — the existing "some saved, some not" report and its reconcile contract; `CoordinatorStaleLossError`)
  - packages/db-core/src/collection/collection.ts (`update` / `updateInternal` — already returns a value when the refresh finished this write's own entry, but the public `update()` discards it; `completeOwnEntry`, `consumeOwnEntry`)
  - packages/db-core/src/collection/struct.ts (`TornActionError`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (~676: only `CoordinatorPartialCommitError` latches the degraded state; every other commit failure takes the "nothing durably committed" clean-rollback branch)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts (the case "one participant finished and another torn for good" reaches the state and is written to accept either error shape)
  - docs/internals.md ("A half-landed write that cannot be finished is refused by name"), docs/correctness.md (Theorem 3), docs/transactions.md
difficulty: medium
repro: static
----

# What is wrong

A multi-collection commit (`TransactionCoordinator.commit`) promises, as its documented guarantee (docs/correctness.md Theorem 3), that when some collections end up saved and others do not, the caller is **told which** — that is what `CoordinatorPartialCommitError` is for, and its reconcile contract says the catcher must not treat the outcome as a clean abort. The Quereus bridge relies on exactly that: only `CoordinatorPartialCommitError` makes it latch its "degraded" state and skip the snapshot rollback; every other failure is handled as "nothing was saved, roll back cleanly".

The retry loop can now make a participant durable **between attempts**, outside the single-attempt code that builds `CoordinatorPartialCommitError`:

- A participant whose log tail landed although its commit was reported as failed is *finished* by the refresh between attempts (`Collection.completeOwnEntry`) and its log entry consumed. From then on that collection is saved, permanently.
- Before that finishing step existed, the refresh already *consumed* such an entry on sight, so this half of the problem predates it.

Any terminal failure after that point is reported as if nothing were saved:

1. **Another participant is torn for good.** Its refresh throws `TornActionError` (`rival-holds-revision`, or `completion-refused` once the budget is spent). It escapes `commit()` bare. It names only the torn collection.
2. **Another participant keeps losing cleanly until the budget runs out.** `commit()` throws `CoordinatorStaleLossError`, whose contract is "nothing durably committed, every tracker restored, safe to re-drive" — untrue here, and a whole-transaction re-drive would apply the saved participant's actions a second time.
3. **Any other error out of a later attempt or a later refresh** (expired transaction, unreachable cluster, `CollectionHeaderVanishedError` from the blanket refresh) — same.

In all three the caller cannot learn that part of the transaction is durable, and the bridge performs a clean rollback and does not latch the degraded state.

# How to see it

`packages/db-core/test/coordinator-own-action-replay.spec.ts`, case "one participant finished and another torn for good", drives arm 1 deterministically: two participants both land only their log tail, a rival then commits to B alone. After `commit()` rejects, A's blocks all hold the transaction (it is saved) and B's do not. The rejection is the bare `TornActionError` for B. The case deliberately asserts only what stays true after a fix (it looks for the torn error on the rejection or on its `reason`), so it should keep passing; add assertions for the corrected report. Arm 2 is inferred from the code (`throw err` on `staleLosses >= maxAttempts`) and the existing case "one participant tearing while another cleanly loses" is the fixture to extend: let the losing participant lose until the budget runs out.

`repro: static` because the misreport was read from the code path, not observed at the bridge; confirming it means asserting the rejection type in those two cases and, at the bridge tier, that the degraded latch is set.

# Expected behaviour

Once any participant of a commit has been made durable under this transaction's id — by a single attempt, or by a refresh finishing or consuming its own entry — **every** way `commit()` can fail from then on reports a partial landing: the saved collections and the unsaved ones are both named, and the underlying failure (the `TornActionError`, the stale loss, whatever it was) is carried as the cause. A commit in which nothing was made durable keeps today's errors unchanged.

The coordinator has to *know* which participants a refresh finished rather than infer it. `Collection.updateInternal` already returns a value exactly when the refresh finished this write's own entry; the public `update()` drops it. Do not infer it from `committedActionId()` — that accessor is documented as diagnostic-only and must not be branched on. Note the consumed-without-a-re-send path (`completeOwnEntry`'s status-read fallback) returns `undefined` today even though the entry was recognised as saved, so "returned a durability" is not yet the same thing as "this participant is now durable"; the signal needs to cover both.

Local state for the partial report should match what `CoordinatorPartialCommitError` already promises its catcher: saved participants hold nothing staged and read at the saved revision (the refresh's consume already leaves them so); unsaved participants keep their staged actions.

# Out of scope

Making the multi-collection commit all-or-nothing (`backlog/feat-cross-collection-atomic-commit`), and reporting durability from `commit()` (`backlog/feat-multi-collection-commit-reports-durability`).
