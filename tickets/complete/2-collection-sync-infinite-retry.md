description: A collection's save routine used to retry forever when storage kept rejecting it, freezing every other operation on that collection; it now caps retries, backs off between tries, and throws a clear error when it gives up.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/test-transactor.ts, packages/db-core/docs/collections.md
difficulty: medium
---

## Summary

`Collection.syncInternal` previously ran an unbounded `while` loop that, on a persistent
`StaleFailure` lacking a `pending` field (a `reason` commit failure or an unclearable `missing`
conflict), retried with **zero delay** — hammering the transactor and holding the collection latch
forever, freezing every other `act`/`update`/`sync`/`updateAndSync` on that collection.

The fix bounds the loop with a consecutive-no-progress retry budget (`maxAttempts`, default 10),
exponential backoff on *every* stale failure, an optional abort `signal`, and an optional wall-clock
`deadlineMs`. Exhaustion throws the new catchable `SyncRetryExhaustedError`. Options are threaded
through `ICollection.sync` / `updateAndSync` via the new `SyncOptions`; all existing callers pass no
args and inherit the default budget.

See the implement commit (`git show 9a7b22e`) for the full change.

## Review findings

**Scope reviewed:** the implement diff (`collection.ts`, `struct.ts`, `collection.spec.ts`,
`test-transactor.ts`), all `ICollection` implementors and `sync`/`updateAndSync` callers, and the
collections documentation.

### Correctness — no defects found
- **Retry-budget arithmetic** verified: `consecutiveFailures++` then `>= maxAttempts` throws exactly
  N commit attempts (matches the tests' `attempts === maxAttempts` and `commitAttempts === maxAttempts`).
- **Reset-on-progress** verified: counter resets to 0 only on a successful `transact`, so a healthy
  large multi-batch sync never trips the cap (covered by the guard test).
- **Latch release** verified: every throw path (exhaustion, abort, deadline) unwinds through the
  `finally` in `sync()`/`updateAndSync()`; three tests prove a follow-up latched op does not hang.
- **Abort race** verified: `backoffSleep` clears its timer and removes its listener on both paths
  (`{ once: true }` + explicit `removeEventListener`); no timer or listener leak. `makeAbortError`
  yields `name === 'AbortError'` whether or not the signal's `reason` is an `Error`.
- **Signature compatibility** verified: `Collection` is the only `ICollection` implementor; `Tree`
  and `Diary` *wrap* a `Collection` and call `updateAndSync()` with no args (`tree.ts:75,91`,
  `diary.ts:35`). Widening to optional `SyncOptions` breaks nothing. The former infinite hang in
  those callers now surfaces as a thrown `SyncRetryExhaustedError` — a strict improvement.

### Minor — fixed inline this pass
- **Missing `deadlineMs` test** (flagged as a gap by the implementer). Added
  `'should give up with SyncRetryExhaustedError when the wall-clock deadline is exceeded'`:
  always-fail transactor, fast backoff, unreachable `maxAttempts`, small `deadlineMs` → proves the
  deadline stops the loop independently of the attempt cap, and the latch is released. Suite now
  **1099 passing** (was 1098).
- **Stale documentation** (`packages/db-core/docs/collections.md`). The illustrative `sync()` snippet
  and its "Key aspects" list showed the *old unbounded loop* — the exact bug pattern — as the design.
  Updated the snippet to show the consecutive-failure cap, `SyncRetryExhaustedError`, and abortable
  exponential backoff, and added a "Bounded retry" bullet documenting `SyncOptions`. (The snippet is
  illustrative pseudocode and retains pre-existing cosmetic drift like `trxContext`/`this.update()`
  that predates this ticket and is out of scope.)

### Tripwires — recorded as `NOTE:`, not ticketed
- **Backoff-on-`missing`/`reason` latency** — pre-existing `NOTE:` at the backoff site (added by the
  implementer). The conflict paths now pay a base backoff they previously retried with zero delay.
- **`pending`-wait give-up (added this pass).** `NOTE:` at the give-up site in `collection.ts`.
  The default `maxAttempts: 10` now also bounds the legitimate `pending`-wait case (retry the same
  action while another commit is in flight), which previously retried indefinitely — ≈21s of
  exponential backoff before giving up. Conditional and configurable (raise `maxAttempts` per caller);
  only matters if a high-contention workload legitimately needs to wait longer for a pending commit
  to clear. Knowledge, not queued work — hence a code comment, not a ticket.

### Major — none
No findings warranting a new fix/plan/backlog ticket.

### Speculative / out of scope — noted, not actioned
- **`maxAttempts` `>=` vs `>` semantics.** The implementer chose the tighter `>= maxAttempts` (attempt
  count equals the configured budget) over the ticket prose's looser "exceeds". Confirmed the tests
  and the tighter reading are self-consistent and the clearer contract. Kept as-is.
- **Abort test wall-clock timing.** The abort test relies on a real 25 ms timer to reach the 60 s
  backoff sleep before aborting. Robust because the backoff dwarfs the delay; flagged only in case it
  flakes under a heavily loaded CI. Not changed.
- **`actionId` reuse across retries and batches** — pre-existing, untouched by this fix, out of scope.

## Validation

- `yarn build` (tsc) in `packages/db-core` → clean, exit 0.
- `yarn test` in `packages/db-core` → **1099 passing**, no failures (streamed to `/tmp/db-core-test.log`).
- No `.pre-existing-error.md` written — suite was green.
