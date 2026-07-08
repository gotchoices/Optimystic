description: The db-p2p tests that paused for a fixed number of milliseconds to let background activity settle were changed to instead wait only until the thing they were checking for actually happened, so they finish faster and fail with a clear message instead of hanging.
files: packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/unify-tracked-block-set.spec.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/dispute.spec.ts, packages/db-p2p/test/peer-reputation.spec.ts, packages/db-p2p/test/peer-reputation-review.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-core/src/testing/async-wait.ts
difficulty: medium
----

# What this ticket did

Replaced fixed-duration sleeps (`await new Promise(r => setTimeout(r, N))`, a local `delay`) in the db-p2p mock/in-process unit specs with either a bounded condition-poll (`waitFor` from `@optimystic/db-core/test`) on the state the sleep was implicitly waiting for, or — where the sleep guarded a **negative** ("nothing fires") or an **either-outcome race** that a poll cannot express — a bounded `delay` residual from the same shared helper, documented at the site with why it stays.

`waitFor(predicate, { description })` polls every 10ms up to a 2s default and throws (message includes `description`) on timeout, so a broken condition fails fast instead of hanging to the runner idle-timeout.

## Per-file outcome

**Converted to `waitFor` (positive state polls):**
- `rebalance-reaction.spec.ts` — 2 sleeps → poll the terminal effect of the emit→debounce→handler→coordinator chain: `restoration.restoreCalls.includes('block-1')` (gained/pull) and `peerNetwork.connectCalls.length > 0` (lost/push).
- `rebalance-monitor.spec.ts` — 4 of 6 sleeps → poll emitted-event / handler-call counts (debounce coalesce, throttle first-event, all-handlers-fire, surviving-handler-fires).
- `unify-tracked-block-set.spec.ts` — removed the file-local `delay`; added `gained`/`lost` collector arrays to the onRebalance handler and poll on each. **Ordering matters:** the first `waitFor(gained)` must complete before the second topology change, or the second emit merely resets the debounce timer and no `lost` is ever derived (see the in-file comment).
- `cluster-repo.spec.ts` — 3 of 4 sleeps → poll `stateStore.wasExecuted(hash)` (async predicate) for the fire-and-forget markExecuted / durable-marker writes.
- `dispute.spec.ts` — auto-recover test → `waitFor(() => !monitor.isUnhealthy())` (isUnhealthy() prunes the window on each call).
- `peer-reputation.spec.ts` / `peer-reputation-review.spec.ts` — decay tests → poll `getScore()` past its threshold (getScore recomputes decay from `Date.now()` each call).
- `spread-on-churn.spec.ts` — coalesce test → `waitFor(() => events.length >= 1)`.
- `invalidation.spec.ts` — the `while (!reachedWrite) { await setTimeout(0) }` busy-wait → `waitFor(() => reachedWrite)`.

**Kept as bounded `delay` residuals (condition-poll cannot express them; each has a NOTE/why comment):**
- `rebalance-monitor.spec.ts` — "does not fire after stop" and the throttle-window check (both NEGATIVE assertions).
- `spread-on-churn.spec.ts` — "does not fire after stop" and "enabled:false skips spread" (both NEGATIVE).
- `cluster-repo.spec.ts` — "durable marker must NOT be written on apply-throw" (NEGATIVE).
- `storage-repo.spec.ts` — all 3 sleeps: two held-latch "get/recover must NOT resolve" NEGATIVE windows + one `Promise.race([commit, delay(25)])` either-outcome race window.
- `invalidation.spec.ts` — the two `setTimeout(0)` micro-yields after `reachedWrite` (NEGATIVE: apply must NOT proceed while latched) → `delay(0)`.
- `block-storage.spec.ts` — the `LatchProbeStorage` 5ms yield is a deliberate concurrency-window *widener* (manufactures overlap to expose an unshared latch), not a settle wait → `delay(5)` + NOTE.

**Left untouched (with reason):**
- `block-transfer.spec.ts` — its sleeps (`delayMs` mock knob; the 50ms/200ms inside `restoration.restore`) are deliberate *work/latency simulation* for the concurrency-limit and transfer-timeout tests, not settle waits. Nothing to poll.
- `ring-selector.spec.ts` — already fully driven by an injected `FakeClock` (`now: clock.now`); the line the ticket flagged is a comment, not a sleep.

## Why no fake clocks

The ticket asked to prefer an injected clock over polling where available. Checked the four relevant production classes — `RebalanceMonitor` (raw `setTimeout` + `Date.now`), `SpreadOnChurnMonitor`, `EngineHealthMonitor`, `PeerReputationService` — **none accepts an injectable clock/timer.** Wiring one in is a production change outside a test-migration ticket, so these use bounded polls instead. `ring-selector` already had the injection and needed no change.

# Validation performed

- `packages/db-p2p`: ran the 11 touched specs together **3×** — `269 passing` each run, 0 failing, deterministic. Command:
  ```
  node --import ./register.mjs node_modules/mocha/bin/mocha.js test/rebalance-monitor.spec.ts \
    test/rebalance-reaction.spec.ts test/unify-tracked-block-set.spec.ts test/cluster-repo.spec.ts \
    test/dispute.spec.ts test/peer-reputation.spec.ts test/peer-reputation-review.spec.ts \
    test/spread-on-churn.spec.ts test/invalidation.spec.ts test/storage-repo.spec.ts \
    test/block-storage.spec.ts --reporter spec
  ```
- `node_modules/typescript/bin/tsc --noEmit` in `packages/db-p2p` → exit 0.

## What a reviewer should probe (tests are a floor, not a ceiling)

- **Strengthened assertion (intentional, confirm desirable):** the coalesce tests in `rebalance-monitor.spec.ts` and `spread-on-churn.spec.ts` originally asserted only `events.length <= 1` (0 tolerated). The `waitFor(() => events.length >= 1)` now also *requires* an event, i.e. exactly-1. This is correct — the eligible mock setup provably fires one event (matches the sibling "SpreadEvent emission" test) and a 0-event coalesce would test nothing — but it is a semantic tightening from the original.
- **`unify-tracked-block-set.spec.ts` ordering:** verify the two-`waitFor` split can't race — the second emit fires only after the first `gained` event is observed.
- **Residual `delay()` sites:** confirm each residual is genuinely a negative/either-outcome case and the bound comfortably exceeds the relevant debounce/window (e.g. `delay(100)` vs 50ms debounce; `delay(50)` vs 10ms debounce). These are the only remaining fixed sleeps in the touched files.
- **Determinism at scale:** the 3× local runs were on a fast dev box. See the tripwire below re: wall-clock-dependent polls under CI load.

## Review findings

- **Tripwire — wall-clock-dependent polls (parked as `NOTE:` comments at the three sites):** the `dispute` auto-recover poll and the two `peer-reputation(-review)` decay polls still advance on real wall-clock, because `EngineHealthMonitor`/`PeerReputationService` have no injectable clock. Fine now (bounded, return early, deterministic in practice). *If* they flake under CI load, the escalation is to add an injectable `now` to those services and drive it — a production change, deliberately out of scope here. Parked at each site, not filed as a ticket.
- **Tripwire — residual bounded `delay()` for negatives/races (parked as NOTE/why comments at each site):** rebalance-monitor, spread-on-churn, cluster-repo, storage-repo, invalidation retain small `delay()` calls where the assertion is "X does NOT happen" or "either outcome is valid". A condition-poll cannot express these; the honest tool is a bounded window. Same escalation path (injectable clocks) applies if they ever become a flake source.
- **Scope note — `block-transfer.spec.ts` intentionally unchanged:** its sleeps are work/latency simulation, not settle waits. Flagging so the reviewer doesn't read the untouched file as an oversight.
