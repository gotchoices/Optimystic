----
description: A group of db-p2p storage, cluster, and rebalance tests wait fixed amounts of time for mock-network activity to settle; replace those fixed waits with bounded "wait until the expected state appears" polls.
prereq: test-wait-helpers
files: packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/dispute.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/unify-tracked-block-set.spec.ts, packages/db-p2p/test/ring-selector.spec.ts, packages/db-p2p/test/peer-reputation.spec.ts, packages/db-p2p/test/peer-reputation-review.spec.ts
difficulty: medium
----

The db-p2p unit/mock-transport specs that sleep to let mock-network or in-process async activity settle. These run against mock transports (mesh-harness / mocks), not real libp2p, so a fixed sleep is masking an observable state change — the ideal condition-poll target.

## Mechanism

Default to **condition-poll** via `waitFor` from `@optimystic/db-core/test`. For each sleep:

- Identify the state the sleep was implicitly waiting for (a block appearing in storage, a rebalance reaction firing, an invalidation propagating, a dispute resolving, a reputation score updating).
- Replace `await delay(N)` / `await new Promise(r => setTimeout(r, N))` with `await waitFor(() => <that state>, { description })`.

Where a spec exercises code that already accepts an injectable clock/timer (check `rebalance-monitor` / `rebalance-reaction` — monitors often have a poll interval), prefer driving that clock over condition-polling. Verify per file; do not assume.

`rebalance-monitor.spec.ts` (~6 sleeps) and `unify-tracked-block-set.spec.ts` (~3, defines its own `delay`) are the heavier ones; the rest are 1–4 sleeps each.

## Edge cases & interactions

- **What the sleep guarded.** Every conversion must assert the settled state, not merely drop the sleep. A rebalance sleep becomes "wait until the monitor reported the imbalance / issued the move".
- **Bounded timeout.** A broken condition must fail fast via the helper's throw, not hang to the runner idle-timeout.
- **Injectable-clock opportunities.** `rebalance-monitor` likely runs on a poll interval — if that interval is injectable, a fake clock is stronger than polling; check before defaulting to `waitFor`.
- **Mock-transport ordering.** Some mocks resolve synchronously; a sleep there may be entirely removable (the state is already settled by the time the next line runs). Confirm with the predicate rather than keeping a poll "to be safe".
- **peer-reputation decay/windows.** Reputation scoring may use time windows (`Date.now`); a fixed sleep advancing a window should become an injected clock advance if available, else a bounded poll on the score.
- **Determinism.** Re-run the touched files repeatedly.

## TODO

- For each listed spec, classify sleeps: settle-for-mock-async (→ `waitFor` on state), or time-window/interval-driven (→ injected clock advance if available).
- Convert, asserting the previously-implicit settled state.
- Remove unused private `delay` (e.g. `unify-tracked-block-set.spec.ts:76`).
- Check `rebalance-monitor` and `peer-reputation` for injectable clocks; prefer fake-clock there.
- Run the touched db-p2p specs repeatedly; confirm determinism and preserved assertions.
