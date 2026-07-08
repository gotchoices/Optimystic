description: The db-p2p tests that paused for a fixed number of milliseconds to let background activity settle now wait only until the thing they check for actually happens, so they finish faster and fail with a clear message instead of hanging.
files: packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/unify-tracked-block-set.spec.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/dispute.spec.ts, packages/db-p2p/test/peer-reputation.spec.ts, packages/db-p2p/test/peer-reputation-review.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-core/src/testing/async-wait.ts
difficulty: medium
----

# What landed

Replaced fixed-duration settle sleeps in the db-p2p mock/in-process unit specs with bounded
condition polls (`waitFor` from `@optimystic/db-core/test`) on the state the sleep was implicitly
waiting for. Where the sleep guarded a **negative** ("nothing fires") or an **either-outcome race**
that a poll cannot express, the implementer kept a small bounded `delay()` from the same shared
helper, documented at the site with a "Residual bounded sleep" / `NOTE:` comment explaining why it
stays. `waitFor` polls every 10ms up to a 2s default and throws (message includes the caller's
`description`) on timeout, so a broken condition fails fast instead of hanging to the runner idle
timeout.

The shared helper (`waitFor`/`waitForValue`/`delay` in `packages/db-core/src/testing/async-wait.ts`)
is **pre-existing** — it came from the `test-wait-helpers` ticket and was not modified here; this
ticket only consumes it.

# Review findings

Adversarial pass over the implement diff (commit `08a9fc8`), read before the handoff summary.

## Checked

- **Build/lint/tests (must pass):**
  - `packages/db-p2p`: `tsc --noEmit` → exit 0.
  - `eslint` on all 11 touched specs → exit 0.
  - The 11 touched specs together → **269 passing**, 0 failing.
  - Full db-p2p unit suite (`yarn test`) → **1306 passing, 36 pending, 0 failing** — no regressions
    introduced beyond the touched files.
- **Poll-early-return hazard (the main risk of sleep→poll migration):** every converted
  `waitFor(() => count >= 1)` is immediately followed by an exact assertion (`length(1)` /
  `<= 1`). Confirmed this is safe: both `RebalanceMonitor` (`src/cluster/rebalance-monitor.ts:149`)
  and `SpreadOnChurnMonitor` (`src/cluster/spread-on-churn.ts:174`) debounce with a **single**
  `debounceTimer` that is `clearTimeout`-reset on each topology change, so at most one event can ever
  fire per test. The added `>= 1` liveness check is therefore a genuine strengthening over the
  original `<= 1`-only (0-tolerated) assertion, and the upper bound cannot be violated by a late
  second event under the current implementation.
- **Async predicate support:** `cluster-repo.spec.ts` polls an `async` predicate
  (`await stateStore.wasExecuted(hash)`); `waitFor` awaits the predicate, so this is correct.
- **Ordering in `unify-tracked-block-set.spec.ts`:** verified the two-`waitFor` split cannot race —
  the second topology emit fires only after the first `gained` event is observed, so
  `wasResponsible` is established before the lost event is derived (would otherwise just reset the
  debounce timer).
- **Timeout headroom:** all polled conditions occur within tens of ms (debounce 10–50ms, decay
  half-lives 10–100ms, dispute window 25ms) — comfortably inside the 2s default.
- **Residual `delay()` audit:** grepped every remaining sleep in the 11 touched files; all are the
  documented negative/either-outcome residuals (block-storage:357, cluster-repo:1079,
  invalidation:764-765, rebalance-monitor:288,355, spread-on-churn:348,753, storage-repo:574,658,701)
  with an inline reason. No undocumented fixed sleep survives.
- **Scope:** `block-transfer.spec.ts` (work/latency simulation) and `ring-selector.spec.ts` (already
  clock-injected) intentionally untouched — confirmed neither is a settle-wait case. Out-of-list
  files (`libp2p-key-network`, `circuit-relay-long-lived`, etc.) were not in this ticket's scope.

## Found

- **Minor — none requiring inline fix.** The implementation is clean; assertions, comments, and
  residual justifications all hold up.
- **Major — none.** No new tickets filed.
- **The handoff's "confirm desirable" flag (coalesce tightening):** resolved — the `>= 1` addition
  is correct and desirable, not a masked regression, per the single-timer debounce analysis above.

## Tripwires (parked, not filed)

Concurred with the implementer's tripwires; all are recorded as `NOTE:` comments at their sites (no
tickets):

- **Wall-clock-dependent polls** — `dispute.spec.ts:191`, `peer-reputation.spec.ts:62`,
  `peer-reputation-review.spec.ts:164`. `EngineHealthMonitor` and `PeerReputationService` have no
  injectable clock, so these polls advance on real wall-clock. Fine now (bounded, return early,
  deterministic in practice). *If* they flake under CI load, the escalation is to add an injectable
  `now` to those services and drive it — a production change, out of scope for a test migration.
- **Residual bounded `delay()` for negatives/races** — the sites listed under "Residual `delay()`
  audit". A condition poll cannot express "X does NOT happen" or "either outcome is valid"; a bounded
  window is the honest tool. Same injectable-clock escalation applies if they ever become a flake
  source.

# End
