description: When one change touches several collections and its retry ends up saving some of them but not others, the caller is told only that the change failed, so the application rolls back as if nothing had been saved and its view no longer matches storage. Make every failure after part of the change is saved report that split by name.
files:
  - packages/db-core/src/transaction/coordinator.ts (`TransactionCoordinator.commit`: the retry loop and the refresh between attempts. This is the site to change.)
  - packages/db-core/src/collection/collection.ts (`update`, `updateInternal`, `completeOwnEntry`, `consumeOwnEntry`: the refresh has to tell the coordinator that it finished this transaction's own entry)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError` and its reconcile contract, `CoordinatorStaleLossError`)
  - packages/db-core/src/collection/struct.ts (`TornActionError`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (around line 676: only `CoordinatorPartialCommitError` sets the degraded latch; nothing to change there if the coordinator reports correctly)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts (the cases "one participant finished and another torn for good" and "one participant tearing while another cleanly loses")
  - docs/internals.md (around line 842, "A half-landed write that cannot be finished is refused by name"), docs/correctness.md (Theorem 3, line 132), docs/transactions.md (around lines 72 and 115)
difficulty: medium
repro: verified
----

# The problem

`TransactionCoordinator.commit` commits one transaction that touches several collections (the participants). The guarantee in docs/correctness.md Theorem 3 is that when some participants end up saved and others do not, the caller is **told which ones**. `CoordinatorPartialCommitError` carries that report. Its contract says the catcher must not treat the outcome as a clean abort. The Quereus bridge (`txn-bridge.ts`) relies on this: only `CoordinatorPartialCommitError` sets the degraded latch and skips the snapshot restore. Every other error goes down the "nothing was saved, roll back cleanly" path, including the step that maps an error to a unique-constraint error.

Today that error is only built inside one attempt (`commitOnceLatched`). A participant can also become permanently saved in the **refresh between attempts**, in this sequence:

- An attempt reports a stale loss even though that participant's log tail was stored.
- The blanket `collection.update()` loop in `commit()` finds this transaction's own log entry.
- `Collection.completeOwnEntry` finishes the participant's remaining blocks, and `consumeOwnEntry` drops its staged actions.

From then on, any failure out of `commit()` hides the fact that this participant is saved:

1. **Another participant can never be finished.** The refresh throws `TornActionError`, either `rival-holds-revision` at once or `completion-refused` once the budget runs out. It leaves `commit()` bare and names only the torn collection.
2. **Another participant keeps losing cleanly until the budget runs out.** `commit()` rethrows `CoordinatorStaleLossError`. That error's contract ("nothing durably committed, safe to re-drive") is false here, and re-driving the whole transaction would apply the saved participant's actions a second time. The deadline check (`throw lastLoss`) has the same problem.
3. **Any other failure after that point.** Examples: an expired transaction, an unreachable cluster, a hard error from a later `commitOnce`, `CollectionHeaderVanishedError` from the blanket refresh, or an abort-signal error. A later `CoordinatorPartialCommitError` names only the participants that attempt committed, not the ones a refresh already finished.

## Verified reproduction

I ran the case "one participant finished and another torn for good" with a temporary log line. `commit()` rejects with a bare `TornActionError` (`reason: 'rival-holds-revision'`, collection B), while every block of participant A holds the transaction. The case already passes and is written to accept either error shape: it looks for the torn error on the rejection itself or on its `reason`.

Arm 2 is inferred from the code (`if (staleLosses >= maxAttempts) throw err;` after an earlier refresh finished a participant). The fixture to extend is `TearsOneLosesOtherTransactor`, used by "one participant tearing while another cleanly loses": make the losing participant lose on every attempt.

# Expected behaviour

Once any participant of the commit has been made durable under this transaction's id, whether by an attempt or by a refresh that finished or consumed its own entry, **every** way `commit()` can then fail throws `CoordinatorPartialCommitError`:

- `committedCollections`: every participant saved so far. This includes the ones finished by a refresh and, if the final failure is itself a partial commit, that attempt's committed set.
- `failedCollections`: the participants of this transaction that are not in the saved set.
- `reason`: the underlying error object (the `TornActionError`, the `CoordinatorStaleLossError`, the abort error, and so on). `reason` is typed `unknown`, so an Error instance fits.

A commit in which nothing was made durable keeps today's errors exactly. That includes a bare `TornActionError` when the *only* torn participant never had anything saved: arm 1 with no other participant finished stays as it is.

Local state must match what `CoordinatorPartialCommitError` already promises:

- Saved participants hold nothing staged and read at the saved revision. The refresh's consume and replay already do this.
- Unsaved participants keep their staged actions. `completeOwnEntry` throws before changing anything, and `commitOnceLatched` restores the others.
- The stamp is released with `this.stampData.delete(transaction.stamp.id)`, as the existing partial-commit path does, because the transaction can no longer be cleanly rolled back.

# Design

## The refresh must *tell* the coordinator it finished an entry

Do not infer this. `committedActionId()` is documented as diagnostic-only, and its value must not drive a branch. Today `updateInternal` returns a `WriteDurability` only when `completeOwnEntry` re-sent and succeeded. The status-read fallback in `completeOwnEntry` (no retained attempt, but every block already holds the action) returns `undefined` even though the entry is then consumed as saved. So "returned a durability" does not mean the same thing as "this participant is now durable".

Recommended shape: make the fact explicit on the value `updateInternal` returns. For example, `{ ownEntryConsumed: boolean; durability?: WriteDurability }`, or any equivalent that separates "consumed our own entry" from "who holds it". Then:

- `syncInternal` keeps its current behaviour, reading `durability` as it reads `completed` today (around collection.ts:1386).
- Give the coordinator its own entry point that returns the value. Either `update()` returns it or a new method (for example `refreshInFlight()`) does. Readers calling `update()` keep ignoring the result. Keep the latch handling that `update()` already has.

## Coordinator bookkeeping

In `commit()`, keep a `Set<CollectionId>` of saved participants (call it `landed`) and a set of every participant seen across attempts. `commitOnce` computes its participants from collections whose trackers hold transforms. Expose that set, for example through the `inFlightDisposers`-style out-parameter pattern that `commitOnce` already uses, or through a small attempt-state object passed in. Collections that no attempt ever included are not participants and must not appear in either list.

Wrap the whole retry loop's body, or its throw sites, so that any error escaping while `landed.size > 0` is rethrown as `CoordinatorPartialCommitError([...landed ∪ attempt's committed], [participants − landed], err)`. Do not wrap a `CoordinatorPartialCommitError` twice: merge its sets instead. Release the stamp on that path. Wrapping in one place, rather than at each `throw`, is what stops a future exit from forgetting.

## Refresh every participant before reporting

The blanket refresh visits collections in `Map` insertion order and stops at the first throw. If the torn participant comes before one that could be finished, that participant is never finished. Its log tail stays stored with its other blocks unlanded, which is the silent-loss shape `completeOwnEntry` exists to prevent. The existing test passes only because A is registered before B. On a terminal refresh error (anything except `completion-refused`, which is already retried), keep refreshing the remaining collections, record every one that consumed its own entry, then throw the first terminal error (wrapped as above if anything landed). For `completion-refused` rounds, the existing retry loop already re-runs the refresh over all collections. Add a test with the registration order reversed (B before A) to lock this in.

## Bridge

No bridge change is expected. `txn-bridge.ts` already treats `CoordinatorPartialCommitError` correctly. One interaction to check: `mapCommitRefusal` looks for a `TreeKeyTakenError` in the cause chain coming out of the refresh. Once wrapped in a partial report, that refusal no longer becomes a plain unique-constraint error. That is intended, because the partial report is not a clean refusal. Confirm no bridge test depends on it.

# Out of scope

- Making the multi-collection commit all-or-nothing (`backlog/feat-cross-collection-atomic-commit`).
- Reporting durability from a successful `commit()` (`backlog/feat-multi-collection-commit-reports-durability`).
- Faster detection of a revision that is permanently taken (`backlog/debt-multi-collection-retry-cannot-see-the-taken-revision`), which touches the same loop and may conflict at merge.

# TODO

- Change `Collection.updateInternal` so its return value states explicitly that it consumed this write's own entry, covering both the re-send path and the status-read fallback. Update `syncInternal`'s use of it, and the NOTE in `completeOwnEntry`'s fallback, which currently says a whole-but-unreported write answers `undefined`.
- Give `TransactionCoordinator.commit` a way to refresh that returns this value, keeping the latch handling `update()` has.
- In `commit()`, track the participants seen across attempts and the set saved so far. When anything escapes while that set is non-empty, rethrow it as `CoordinatorPartialCommitError` carrying the original error as `reason`. Merge instead of double-wrapping a later attempt's partial error, and release the stamp.
- Keep refreshing the remaining collections after one throws a terminal error, so that every participant that can be finished is finished before reporting.
- Tests in `coordinator-own-action-replay.spec.ts`:
  - Strengthen "one participant finished and another torn for good" to expect `CoordinatorPartialCommitError` with `committedCollections` = [A], `failedCollections` = [B], and `reason` a `TornActionError`.
  - Add the same case with B registered before A.
  - Add a case where one participant is finished and the other loses cleanly until `maxAttempts` runs out: expect a partial report whose `reason` is a `CoordinatorStaleLossError`, and no second log entry for the saved participant.
  - Add a case where nothing landed and the error is unchanged, for example the single-collection "refuses by name" case, which should still be a bare `TornActionError`.
- Update the docs: the `CoordinatorStaleLossError` doc comment ("nothing durably committed" now holds because partial states are routed away from it), the `commit()` doc comment, docs/internals.md around line 842, and docs/transactions.md around lines 72 and 115. Say that a refresh-finished participant counts as committed in the partial report.
- Run `yarn test` in packages/db-core and the quereus-plugin-optimystic tests (the bridge is a consumer).
