----
description: A handful of db-core coordinator and transaction tests use short real-time sleeps around retry/backoff and abort behavior; tighten them to use the injectable backoff config and a bounded poll so they stay deterministic.
prereq: test-wait-helpers
files: packages/db-core/test/transaction.spec.ts, packages/db-core/test/coordinator.spec.ts, packages/db-core/test/collection.spec.ts, packages/db-core/src/coordinator/coordinator.ts, packages/db-core/src/utility/backoff.ts
difficulty: easy
----

The db-core coordinator/transaction tests use a few short real sleeps (e.g. `transaction.spec.ts` `await new Promise(r => setTimeout(r, 25))` before aborting an in-flight commit; `coordinator.spec.ts:25` and `collection.spec.ts` private `delay`). These are small (tens of ms), so they are the lowest-risk / lowest-payoff batch — but they still introduce real-time nondeterminism and belong in the sweep.

The commit path is already largely time-parameterized: `coordinator.commit(...)` accepts `baseBackoffMs`, `maxBackoffMs`, `maxAttempts`, `deadlineMs`, and an abort `signal` (see the abort/deadline tests in `transaction.spec.ts` ~line 4321), and `packages/db-core/src/utility/backoff.ts` exposes `jitteredBackoffMs` with an injectable `rand`.

## Mechanism

- **Abort-mid-backoff sleeps** (`await setTimeout(25)` then `controller.abort()`): the sleep exists to ensure the commit is *parked in its backoff wait* before aborting. Rather than sleeping a fixed 25ms and hoping, poll for observable evidence the commit has entered backoff (e.g. a flaky-transactor attempt counter reaching ≥1) via `waitFor` from `@optimystic/db-core/test`, then abort. This removes the "hope 25ms was enough" race.
- **`coordinator.spec.ts` / `collection.spec.ts` `delay`**: identify what each waits for; convert to `waitFor` on the observable, or delete if the awaited state is already settled synchronously.
- Do **not** introduce an injectable clock into the coordinator's backoff sleep unless it is already abstracted — the existing `baseBackoffMs`/`deadlineMs` knobs plus condition-polling are sufficient for these short cases. If the backoff sleep is a raw `setTimeout` with no injection point and a test needs to assert exact backoff timing (not just "it retried"), note it as a possible follow-up rather than expanding this easy ticket.

## Edge cases & interactions

- **Abort must beat exhaustion.** The abort test asserts the error is `AbortError`, not `CoordinatorStaleLossError` — the poll-then-abort must fire while the commit is still retrying (huge `maxAttempts`, long `baseBackoffMs`), so wait for entry-into-backoff, not for a wall-clock guess.
- **Deadline test unchanged.** The `deadlineMs` test (`deadlineMs: 30`) asserts the deadline stops retries; it already relies on the injectable deadline, not a sleep — leave it unless it holds a stray sleep.
- **`backoff.spec.ts` is not a sleep test.** Its `delay = jitteredBackoffMs(...)` is a computed value, not a wait — do not "migrate" it. Only touch genuine `setTimeout`-based waits.
- **Bounded poll.** As everywhere, the `waitFor` throw bounds a broken condition.
- **Determinism.** Re-run `db-core` test repeatedly.

## TODO

- Convert the abort-mid-backoff sleeps in `transaction.spec.ts` to `waitFor(entered-backoff)` then abort; assert `AbortError` unchanged.
- Convert or remove the `delay` usages in `coordinator.spec.ts` / `collection.spec.ts` per what each awaits.
- Leave `backoff.spec.ts`'s computed `delay` and the `deadlineMs` test alone (no real sleep there).
- Run `db-core` test repeatedly; confirm assertions preserved and determinism.
