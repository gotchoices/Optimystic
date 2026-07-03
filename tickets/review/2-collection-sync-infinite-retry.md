description: Review the fix that stops a collection's save routine from retrying forever when storage keeps rejecting it — it now caps retries, backs off between tries, and throws a clear error when it gives up.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/test-transactor.ts
difficulty: medium
---

## What changed

`Collection.syncInternal` previously drove an unbounded `while` loop: on a persistent `StaleFailure`
it retried with **no delay** whenever the failure lacked a `pending` field (a `reason` commit failure
or an unclearable `missing` conflict), holding the collection latch forever and freezing every other
`act`/`update`/`sync`/`updateAndSync` on that collection. This fix bounds the loop.

### Implementation (packages/db-core/src/collection/collection.ts)

- **Consecutive-no-progress retry budget.** A `consecutiveFailures` counter increments on every
  `StaleFailure` and **resets to 0 on every successful `transact`**. When it reaches `maxAttempts`
  (default 10) the loop throws `SyncRetryExhaustedError`. This is deliberately *not* a total-iteration
  cap — a legitimate large multi-batch sync iterates many times making forward progress and must not
  trip. The reset-on-success is the load-bearing part of that distinction.
- **Exponential backoff on every stale failure.** The backoff sleep now runs on *any* `StaleFailure`
  (`reason`/`missing`/`pending`), growing `baseBackoffMs * 2^(n-1)` capped at `maxBackoffMs`. The old
  "sleep only if `pending`" was exactly what made the persistent-`reason` case a hot spin.
- **Abortable.** `signal?.aborted` is checked at the top of each iteration, and the backoff sleep is
  raced against the signal's `abort` event (`backoffSleep`), so an aborted sync rejects promptly with
  an `AbortError` instead of finishing the sleep. `makeAbortError` prefers the signal's own `reason`
  when it is an `Error`.
- **Optional wall-clock deadline** (`deadlineMs`), a progress-agnostic ceiling measured from sync
  start; throws `SyncRetryExhaustedError` when exceeded.
- **Options threaded through.** `ICollection.sync` / `updateAndSync` widened to accept optional
  `SyncOptions`; concrete `sync()` / `updateAndSync()` pass it to `syncInternal`. All existing callers
  (`tree.ts:75,91`, `diary.ts:35`, plugin callers) pass no args and get the default budget.

### New public surface (packages/db-core/src/collection/struct.ts)

- `SyncOptions { maxAttempts?, deadlineMs?, baseBackoffMs?, maxBackoffMs?, signal? }`
- `SyncRetryExhaustedError extends Error` — carries `collectionId`, `attempts`, `lastReason`.

Both re-export automatically through `collection/index.ts` (`export * from "./struct.js"`) and
`packages/db-core/src/index.ts` (`export * from "./collection/index.js"`) — verified importable in the
spec.

### Semantics decision worth a reviewer's eye

`maxAttempts` = **exactly N consecutive failed commit attempts allowed, then throw** (`>= maxAttempts`
after incrementing). With `maxAttempts: 3` the transactor sees exactly 3 commit attempts and
`err.attempts === 3`. The ticket's prose said "when the counter *exceeds* maxAttempts" (which would be
N+1); I chose the tighter `>=` so the attempt count equals the configured budget. If the reviewer
prefers the looser reading, only the comparison and the two asserting tests change.

## Tests (this is the floor, not the ceiling)

New `describe('bounded sync retry')` in `packages/db-core/test/collection.spec.ts`, plus a reusable
`FlakyCommitTransactor` in `test-transactor.ts` (wraps `TestTransactor`, fails the first N commits —
`Infinity` = always — counts `commitAttempts`, delegates everything else):

- **Exhaustion** — always-fail transactor → `sync({ maxAttempts: 3 })` rejects with
  `SyncRetryExhaustedError` (`collectionId`, `attempts === 3`, `lastReason === 'always stale'`),
  `commitAttempts === 3` (bounded), and a follow-up `update()` proves the latch was released.
- **Abort** — always-fail transactor, `baseBackoffMs: 60_000`, aborted after 25ms → rejects with an
  `AbortError` (not `SyncRetryExhaustedError`); follow-up `update()` proves latch release.
- **Recovery** — fails first 2 commits then delegates → `sync({ maxAttempts: 5 })` succeeds and the
  action lands (proves the counter resets on progress).
- **Guard** — 100 actions, 10-action batches, `updateAndSync({ maxAttempts: 2 })` against a healthy
  transactor, all land (proves the cap counts consecutive failures, not iterations).

**Validation run:** `yarn build` (tsc) clean; `yarn test` in `packages/db-core` → **1098 passing**, no
failures (streamed to `/tmp/db-core-test.log`). No `.pre-existing-error.md` written — suite was green.

Run the whole suite (or pair with `collection-type-registry.spec.ts` first) when spot-checking — the
ticket's noted import-order quirk means a single collection spec in isolation fails with
`Cannot access 'collectionTypes' before initialization`. Not in scope.

## Known gaps / things to probe (treat my work as a starting point)

- **`deadlineMs` has no dedicated test.** The code path exists and typechecks but is unexercised by a
  test. A reviewer should add one (e.g. always-fail transactor + `deadlineMs` shorter than the first
  backoff → rejects with `SyncRetryExhaustedError`) or confirm it is acceptable to ship untested. Note
  the deadline is measured from `syncInternal` start, so in `updateAndSync` it does **not** include the
  preceding `updateInternal()`.
- **Abort test timing.** It relies on a real 25ms timer to let sync reach the (60s) backoff sleep
  before aborting. Robust in practice because the backoff dwarfs the delay, but it is wall-clock
  dependent — flagging in case it flakes under a loaded CI.
- **Backoff-on-`missing` latency (tripwire, parked as `NOTE:` at the backoff site in collection.ts).**
  The `missing`/`reason` conflict paths now pay a base backoff (default 100ms) they previously retried
  with zero delay — the deliberate cost of killing the hot spin. If a high-contention workload ever
  shows this as recovery latency, lower `baseBackoffMs` for that caller rather than reintroducing the
  zero-delay retry. Recorded as a code comment, not a ticket.
- **`actionId` reuse (pre-existing, unchanged).** A single `actionId` is generated once per
  `syncInternal` and reused across every retry *and* across multiple successful batches within one
  call. Untouched by this fix and out of scope, but a reviewer glancing at the success branch's
  `actionContext.committed` push may want to confirm it is intended.
