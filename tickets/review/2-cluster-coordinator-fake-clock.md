description: The cluster-coordinator test used to spend up to 4.5 seconds per case waiting on real timers; the coordinator's retry timers are now injectable so the test drives them with a fake clock and runs in milliseconds.
prereq:
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/cluster-coordinator.spec.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts
difficulty: hard
----

## What shipped

`ClusterCoordinator` now takes an optional clock/timer seam and its own test drives it with a fake clock. The slowest test in the db-p2p suite (real sleeps of 2500/4500 ms × several cases) now runs in ~24 ms.

### Source change — `packages/db-p2p/src/repo/cluster-coordinator.ts`

- New exports, mirroring `reactivity/rotation-rereg-scheduler.ts`:
  - `export type TimerCancel = () => void;`
  - `function defaultSetTimer(fn, delayMs): TimerCancel` — a one-shot `setTimeout` whose handle is `unref()`'d, returning a `clearTimeout` cancel.
  - `export interface ClusterCoordinatorClock { now?: () => number; setTimer?: (fn, delayMs) => TimerCancel }`.
- Constructor gained an **8th positional optional** arg `clock?: ClusterCoordinatorClock` (after `stateStore?`). Two private fields resolve it:
  - `this.now = clock?.now ?? (() => Date.now())`
  - `this.setTimer = clock?.setTimer ?? defaultSetTimer`
- All four `Date.now()` reads → `this.now()` (`executeClusterTransaction` lastUpdate, `updateTransactionRecord`, `persistCoordinatorState`, `recoverTransactions` expiration check).
- All three `setTimeout` sites → `this.setTimer(...)`; the retry timer's stored handle changed from `CommitRetryState.timer?: NodeJS.Timeout` to `CommitRetryState.cancel?: TimerCancel`, and both `clearTimeout(...)` sites → `existing?.cancel?.()` / `state.retry.cancel?.()`.

### Test change — `packages/db-p2p/test/cluster-coordinator.spec.ts`

- Added a `FakeScheduler` (copied in shape from `test/reactivity/rotation-rereg-scheduler.spec.ts`): a virtual `now`, a `setTimer` that queues `{fireAt, fn}`, a cancel handle that removes the timer, and `advance(ms)` that fires due timers in ascending `fireAt` order.
- Every real `await new Promise(r => setTimeout(r, N))` → `clock.advance(N); await flush()`. `flush()` is `new Promise(resolve => setImmediate(resolve))` — one macrotask boundary that drains the microtasks the **async** `retryCommits` runs on.
- Fixture expirations stamped against the fake clock (`expiration: clock.now + 30000`) instead of `Date.now() + 30000`.
- Backoff assertions tightened from `greaterThanOrEqual` to **exact** (`equal`): e.g. attempt intervals asserted 250 → 500 → 1000 → 2000, and a sub-interval advance (`advance(499)` fires nothing, `advance(1)` fires) proves each interval exactly.
- All three `this.timeout(...)` overrides removed — the suite runs under the default mocha timeout now.

## How to validate

```
cd packages/db-p2p
node_modules/.bin/tsc --noEmit                                      # type-check src + test (clean)
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/cluster-coordinator.spec.ts" --reporter spec                # 10 passing (~24ms)
yarn test                                                            # full suite: 1305 passing, 36 pending
```

Verified: `tsc --noEmit` exit 0; the migrated spec 20×/20 green (deterministic, virtual time); full db-p2p suite 1305 passing / 0 failing (37s, down from the prior ~65s+).

### Behaviours the tests now lock in
- **Retry fires at the exact initial interval** (250 ms) and not one tick before.
- **Recovery cancels the pending retry** — after the peer recovers and the single retry succeeds, advancing 5 s more fires no further update (the injected cancel handle actually removes the timer from the fake queue).
- **Exponential backoff intervals are exact** (250/500/1000/2000, factor 2).
- **In-line broadcast retry** still short-circuits the scheduled retry (no `state.retry` armed).
- **Custom config** (`commitBroadcastRetryInitialMs`, `commitBroadcastImmediateRetries`) still honoured.
- **Undersized-cluster gate** unchanged (fail-closed default; admit under `allowUnvalidatedSmallCluster`).

## Reviewer: treat this as a floor, not a finish line

### Deliberate behaviour change — flag, don't assume parity
The ticket said the default path should stay "byte-for-byte equivalent to today (unref'd setTimeout)". That description is internally inconsistent: **HEAD's three `setTimeout` calls were NOT `unref()`'d** (verified via `git show HEAD:…cluster-coordinator.ts`). I followed the ticket's dominant, repeated design intent — `defaultSetTimer` `unref()`'s — matching the mirror source (`rotation-rereg-scheduler.ts`) and the edge-case rationale ("unref so an idle retry never pins the process"). Net effect: a lone pending commit-retry / deferred-cleanup timer no longer keeps an otherwise-idle Node event loop alive. In a real node the libp2p stack keeps the loop alive regardless, so this is benign — but it **is** a change from HEAD, not parity. Confirm you're comfortable with it. Production call site (`coordinator-repo.ts:129`, 7 positional args, no clock) is unchanged and exercised green by the other coordinator specs.

### Known gaps (tests are a floor)
- **`recoverTransactions` is not exercised by any test.** Its `Date.now()` → `this.now()` swap (the expiration check) is covered only by type-checking and inspection, not a behavioural test. If you want the clock seam proven end-to-end there, a small test that seeds a persisted `broadcasting` state and calls `recoverTransactions()` with a fake clock would close it.
- **`flush()` assumes the mock `update` has no internal awaits.** `retryCommits` awaits a single `Promise.all(...)`; the mock resolves synchronously, so one `setImmediate` boundary drains its continuation. A future mock that adds real internal `await` hops could need a stronger flush (loop until the timer queue stabilises). Noted at the `flush` doc-comment in the spec.
- **`lastUpdate` bookkeeping** (`this.now()` reads) is not asserted by any test — only the retry-timer path is. That was already true before this change.
- **Unused fields untouched:** `ClusterTransactionState.promiseTimeout?/resolutionTimeout?` are declared `NodeJS.Timeout` but never assigned anywhere; left as-is (inert) to keep the diff minimal.

## Review findings
- Parked as a finding (not a ticket): the `unref()` default is a deliberate behaviour change from HEAD, not the "byte-for-byte parity" the ticket claimed — see *Deliberate behaviour change* above; rationale also lives in the `defaultSetTimer` code comment.
- Tripwire (conditional, no code change): `flush()` relies on the mock resolving in one microtask drain; if a future retry-path mock gains real internal awaits, a single `setImmediate` boundary may under-flush. Recorded at the `flush` doc-comment in `cluster-coordinator.spec.ts`.
- Coverage gap (not a defect): `recoverTransactions` clock read is untested — see *Known gaps*.
