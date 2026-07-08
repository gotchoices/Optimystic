description: The cluster-coordinator retry test used to burn up to 4.5 seconds per case on real timers; the coordinator's timers are now injectable so the test drives a fake clock and runs in milliseconds. Reviewed, one coverage gap closed.
prereq:
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/cluster-coordinator.spec.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts
difficulty: hard
----

## What shipped

`ClusterCoordinator` gained an optional 8th constructor arg — a `ClusterCoordinatorClock` seam (`{ now?, setTimer? }`) mirroring `reactivity/rotation-rereg-scheduler.ts`. Production leaves it undefined and gets `Date.now` + an unref'd one-shot `setTimeout`; the test injects a `FakeScheduler` (virtual `now` + a queued timer list driven by `advance(ms)`), so the four `Date.now()` reads and three `setTimeout` sites run in virtual time. The slowest db-p2p test (real sleeps of 2500/4500 ms × several cases) now runs in ~24 ms.

- `CommitRetryState.timer?: NodeJS.Timeout` → `cancel?: TimerCancel`; both `clearTimeout` sites → `cancel?.()`.
- Backoff assertions tightened from `greaterThanOrEqual` to **exact** equality (250 → 500 → 1000 → 2000, with sub-interval `advance` proving each boundary).
- All three `this.timeout(...)` overrides removed; the suite runs under the default mocha timeout.

The production call site (`coordinator-repo.ts:129`, 7 positional args, no clock) is unchanged and stays green.

## Review findings

Reviewed the implement diff (`916ad41`) with fresh eyes, then the handoff. Checked correctness (SPP/DRY/type-safety), the fake-clock/flush design, resource cleanup (the injected cancel handle actually removes the timer), parity with the mirror scheduler, docs, lint, and the full test suite.

### Verified correct
- **Timer-seam mechanics** — `retryCommits` awaits a single `Promise.all` whose mock peers resolve on microtasks. `flush()` (one `setImmediate`) crosses a macrotask boundary, which drains **all** pending microtasks first, so the async retry's continuation (commit merge + arming the next backoff timer) has fully settled before each assertion. Exact-boundary backoff timing (`advance(499)` fires nothing, `advance(1)` fires) checks out against `scheduleCommitRetry`'s `now + interval` arming.
- **No residual real-time reads** — grep confirms every `Date.now()`/`setTimeout` in the source is now either the `this.now()`/`this.setTimer` seam or lives inside the production `defaultSetTimer` binding.
- **Parity with the mirror** (`rotation-rereg-scheduler.ts`) — `defaultSetTimer` (unref'd), `TimerCancel`, and the `?? Date.now` / `?? defaultSetTimer` defaulting match line-for-line in intent.
- **Full suite green** — `tsc --noEmit` exit 0; `eslint` on both changed files clean; `yarn test` in db-p2p = **1306 passing, 36 pending, 0 failing** (~37 s).

### Fixed inline (minor — coverage gap closed)
- **`recoverTransactions` clock read was untested.** It was the only one of the four `this.now()` swaps with zero behavioral coverage (the retry-path specs never reach it). Added `describe('ClusterCoordinator recovery clock seam')` with a minimal in-memory `ITransactionStateStore`. The test seeds a `broadcasting` state whose `expiration` (50 000) is **live against the fake clock** (`now = 0`) but would read as **expired against a real wall clock** (~1.7e12 ms): asserting the state is recovered — not deleted — proves the injected clock, not `Date.now()`, drives the expiration cutoff. It also asserts the recovered broadcast re-arms its retry on the injected timer (`clock.pending > 0`) and that the genuinely-expired sibling is deleted from the store. (+1 test → 11 in this spec, 1306 suite-wide.)

### Accepted, not a defect (recorded, no ticket)
- **The `unref()` default is a deliberate behaviour change from HEAD**, not the "byte-for-byte parity" the implement ticket's prose claimed — HEAD's three `setTimeout` calls were **not** unref'd (verified via `git show HEAD:`). The implementer followed the ticket's dominant, repeated design intent and the mirror source. Net effect: a lone pending commit-retry / deferred-cleanup timer no longer pins an otherwise-idle Node event loop. Benign in a real node (the libp2p stack keeps the loop alive regardless) and the correct, consistent choice. Rationale also lives in the `defaultSetTimer` code comment. **Confirmed acceptable.**

### Tripwire (conditional — no code change)
- `flush()` relies on the retry-path mock resolving within the microtask queue. A single `setImmediate` boundary drains *all* microtasks, so it is robust to multiple **synchronously-resolving** await hops — but a future mock that adds a **real** async hop (a timer/IO await) could under-flush and need a loop-until-the-timer-queue-stabilises drain. Parked at the `flush` doc-comment in `cluster-coordinator.spec.ts` (the site a future reader edits). Not a ticket.

### Observed, out of scope (no action)
- `ClusterTransactionState.promiseTimeout?/resolutionTimeout?` (declared `NodeJS.Timeout`) are dead — never assigned anywhere in `cluster-coordinator.ts`; the live timeout logic lives in `cluster/cluster-repo.ts`'s separate state type. Pre-existing dead fields, untouched by this change; not worth a ticket.
- `docs/cluster.md` — its `Date.now()` references are all cluster-**member** (`cluster-repo`) pseudocode; none describe the coordinator retry seam or a clock injection, so nothing is stale. The clock seam is an internal test affordance with no doc surface.

## How it was validated

```
cd packages/db-p2p
node_modules/.bin/tsc --noEmit                                              # exit 0
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/cluster-coordinator.spec.ts" --reporter spec                        # 11 passing (~22ms)
yarn test                                                                    # 1306 passing, 36 pending, 0 failing (~37s)
../../node_modules/.bin/eslint src/repo/cluster-coordinator.ts test/cluster-coordinator.spec.ts   # clean
```
