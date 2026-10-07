description: A writer that keeps losing to writes that already landed now retries at once instead of sleeping, so the slot the storage machines hold for it is not spent asleep.
prereq: slot-hold-for-an-aged-writer
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-core/src/collection/collection.ts (`retryBackoffMs`, and its call in `syncAttempts` with `confirmedLosses` / `latestConfirmed`)
  - packages/db-core/src/collection/struct.ts (`SyncOptions.baseBackoffMs` / `maxBackoffMs` docs)
  - packages/db-core/src/transaction/transaction.ts (`SlotHoldAfterLosses` doc)
  - packages/db-core/test/collection.spec.ts (`bounded sync retry` → `backoff once a member holds the slot`)
  - docs/correctness.md (Theorem 9, slot-hold paragraph), docs/transactions.md (retry policy bullet)
  - tickets/backlog/debt-multi-collection-retry-cannot-see-the-taken-revision.md (arm for the coordinator loop)
----
# A writer that lost to committed rivals stops backing off

## What landed

`Collection.syncAttempts` sleeps before each retry through `retryBackoffMs`. It returns `0` once `SlotHoldAfterLosses` (3) of the write's refused attempts carried a confirmed committed revision (`StaleFailure.staleAt`) **and** the latest refusal is one of them; otherwise it is the usual jittered backoff. That is the point at which cohort members grant the write a slot hold (`noteStaleLoss` in `packages/db-p2p/src/cluster/cluster-repo.ts`), so the writer no longer spends the hold asleep. A refresh refused with `TornActionError('completion-refused')` — a race against a rival still in flight — clears the "latest confirmed" flag, so the next sleep in that inner loop is jittered again. Abort and deadline handling are unchanged (the zero sleep still goes through `abortableDelay`).

`TransactionCoordinator.commit` keeps backing off: its loop loses the confirmed revision before it can decide (backlog `debt-multi-collection-retry-cannot-see-the-taken-revision`, which carries an arm for applying the same rule).

## Review findings

**Read first:** the `ticket(implement): a-writer-that-lost-to-committed-rivals-stops-backing-off` diff, then the member side (`noteStaleLoss`, `staleLosses`) it is meant to agree with.

**Correctness — found and fixed (major, fixed inline).** The implemented rule zeroed the sleep when `consecutiveFailures >= SlotHoldAfterLosses` and the latest refusal carried `staleAt`. A member, though, counts only its *stale* refusals of the action, per action id, never reset (`staleLosses` in `cluster-repo.ts`). So a write that lost twice to pending rivals (`held`, no `staleAt`) and then once to a committed one stopped sleeping after its third failure while no member had counted more than one stale refusal — no hold stood, and the zero-sleep retries spent the budget early with nothing gained. Fixed: `syncAttempts` keeps `confirmedLosses` (refusals carrying their own `staleAt`, counted over the whole write and never reset, mirroring the member's count) and `retryBackoffMs(failures, confirmedLosses, latestConfirmed, …)` compares that against the constant. The NOTE on `retryBackoffMs` now also names "a member the refused pends did not reach" among the cases where no hold stands.

**Tests.** The implementer's two tests used a transactor refusing the same way every time, so they could not tell "consecutive failures" from "confirmed losses" — the defect above passed them. Replaced with a sequenced-refusal double and three cases, each pinning one branch: all-confirmed (sleeps only after failures 1–2), two pending-rival races then confirmed losses (sleeps after 1–4 — the regression for the defect), and a pending-rival race after the hold point (sleeps again after it, then zero). Dropped the `expect(SlotHoldAfterLosses).to.equal(3)` constant assertion; the tests are written in terms of the constant.

**Docs.** `docs/correctness.md` Theorem 9, `docs/transactions.md` retry-policy bullet, the `SyncOptions` backoff field docs and the `SlotHoldAfterLosses` doc comment said "consecutive" losses; all now state the corrected rule. The backlog arm on `debt-multi-collection-retry-cannot-see-the-taken-revision` was rewritten to the same rule and to cite tickets by slug. `docs/internals.md` does not describe the writer-side backoff and needs no change.

**Edge cases checked, no change.**
- Successful batch / own-entry completion resets `consecutiveFailures` but not `confirmedLosses` — consistent with the member, whose per-action count also survives; multi-batch syncs are dormant today anyway.
- Stall check (`maxStalledAttempts`): its strike count is unchanged; with zero sleep it simply fires sooner in wall-clock time. Same outcome.
- Abort/deadline: unaffected; checks at the top of the loop and in the inner catch are untouched.
- Member-side hold expiry (`slotHoldWindowMs`, 3 s) vs. writer's never-reset count: after the window lapses a member re-grants only on a fresh stale refusal, which the writer also counts, so after a lapse the writer may retry once without sleeping into a slot nobody holds; bounded by the attempt budget and accepted under the existing NOTE on `retryBackoffMs`.

**Gaps left, deliberately.**
- The `completion-refused` inner-loop flag clear has no dedicated test (it needs a half-landed-write double as in `own-entry-completes-the-action.spec.ts`); it is a one-line assignment and the flag's other effect is covered. No tripwire needed.
- No new tickets filed; the coordinator-loop counterpart is already an arm on the existing debt ticket.

**Validation.** `packages/db-core`: build + `yarn test` — 1882 passing. `packages/db-p2p`: `test/aged-writer-slot-hold.spec.ts` — passing (control arm pending, env-gated as designed). `yarn lint:docs` clean. eslint over the four changed source/test files clean. Not run: full `yarn lint` from root (the prior run's combined command stalled under the idle timer), full db-p2p suite after the review fix (the review change touches only the client-side sleep decision in db-core; implement stage ran it green), `yarn test:integration`.
