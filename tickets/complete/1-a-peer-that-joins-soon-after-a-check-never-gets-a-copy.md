description: When a new machine joined a group shortly after the group last checked its replicas, the group never sent the newcomer copies of the existing data until some unrelated connection happened later. The check that should have done it was skipped for being too soon and then forgotten; it is now postponed to the end of the waiting period instead, and two such checks can no longer run at the same time.
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`maybeRebalance`, `deferCheck`, `deferredCheckTimer`, `checkInFlight`, partition-suppression NOTE in `performRebalanceCheck`, `handleTopologyChange` NOTE, `stop`)
  - packages/db-p2p/test/rebalance-monitor.spec.ts (`debounce behavior`: "a topology change landing inside the throttle window is deferred, not dropped"; "the deferred check and the growth re-check falling due together run one check, not two at once")
  - docs/internals.md (§ Cluster Health Monitors → RebalanceMonitor)
----
# A throttled rebalance check is deferred, not dropped

## What was built

`RebalanceMonitor.maybeRebalance` used to return silently when the last check was less than `minRebalanceIntervalMs` (60 s default) ago. The trigger was then lost: the debounce had already fired, and the growth re-check timer arms only for growth work already outstanding. So a peer that joined a block's cohort within 60 s of the founder's previous check was never reported `grown`, and never received the founder's existing blocks until some later connection event landed outside the window. On relay-only deployments that might never happen.

Now:

- A refused trigger is deferred to the end of the window. `deferCheck` arms one unref'd `deferredCheckTimer`, and later refusals fold into it. `stop()` clears it.
- `pendingTopologyChange` is cleared when a check actually runs, so a check that absorbs several triggers keeps the earliest trigger's `triggeredAt`.
- (Review) A check started by a timer or a connection event never runs alongside another. A trigger that lands while a check is running is served by that check. If a connection event arrived during it, `maybeRebalance` runs again afterwards, and that second run lands on the throttle and is deferred to the end of the window.

The implement-stage commit is `ticket(implement): a-peer-that-joins-soon-after-a-check-never-gets-a-copy`. The throttle's default is unchanged.

## Review findings

**Read first:** the implement diff (monitor, spec, internals doc), then the whole of `rebalance-monitor.ts` around the timers, `PartitionDetector`, and how `UnderReplicationDrain` throttles for comparison.

**Correctness: one defect found and fixed inline.** The handoff claimed that when the re-check timer and a deferral are both armed, "the one that fires second gets deferred again". That is false. A check awaits one `findCluster` per tracked block, which is real async work (peer-store reads, SHA-256), and `lastRebalanceAt` is only set when the check finishes. The two timers fall due at almost the same moment: the deferral at `lastRebalanceAt + minRebalanceIntervalMs`, and the re-check `growthRecheckIntervalMs` (which defaults to the same value) after the end of the same check. So whenever growth was outstanding and a connection event landed inside the window, which is exactly the case this ticket creates, two checks ran concurrently. The cost was duplicate `grown`/`lost` events. Also, the second check could read a block's snapshot before the first had consumed its holder evidence, and then push the block back to peers already known to hold it. This was waste, not corruption, but it contradicted the one-scan-per-interval promise.
  - Fix: a `checkInFlight` guard in `maybeRebalance`, plus a re-run once the check finishes if `pendingTopologyChange` was set while it ran. The flag is cleared at the start of every check, so it still being set at the end means a connection event arrived during the check, possibly after the check had already read the affected blocks. The re-run lands on the throttle and defers, so it costs no extra scan inside the window. `checkNow()` is deliberately left unguarded: it is the explicit "run now" entry and only tests call it.
  - Added test "the deferred check and the growth re-check falling due together run one check, not two at once". It uses a key network whose `findCluster` takes 40 ms. I confirmed it **fails** without the guard (2 lookups in flight at once, expected 1) and passes with it.

**Implementer's gaps, dispositioned:**
- *Partition suppression drops a trigger.* Recorded as a tripwire `NOTE:` at the suppression branch of `performRebalanceCheck`. It is not a ticket: this behaviour predates the change and is suppression by design. It only matters when the detector's 10-second goodbye window runs out with no connection event after it, and the remedy (defer on suppression) is noted there.
- *Overlapping checks.* Fixed (above).

**Edge cases checked by reading:**
- `stop()` while a check is running: the flag is cleared in `finally`, and the re-run is refused by `!running`.
- `minRebalanceIntervalMs: 0`: `wait` is never positive and no timer is armed. The in-flight guard returns without polling, so there is no busy loop.
- A deferred timer that fires early after a check ran in between: it is deferred again, as documented.
- A partition-suppressed check with a trigger arriving during it: it re-runs immediately, because `lastRebalanceAt` did not move. This is bounded by the number of events, since the flag is cleared at the start of each run.
- `unref` on a numeric timer handle (browser, React Native): `?.()` makes it a no-op, the same pattern as the existing re-check timer.

**Tests.** The implementer's reproduction test is kept. It pins the ticket's defect and I confirmed it failed at HEAD. One test was added, for the defect above. No tests were cut: the existing throttling and re-check specs still assert distinct behaviour.

**DRY / modularity.** `UnderReplicationDrain` has its own throttle, deferral and `passInFlight` guard with the same shape. Pulling out a shared throttle helper for two small call sites with different pass types would not pay for itself, so no ticket was filed.

**Docs.** `docs/internals.md` § RebalanceMonitor now also states the no-concurrent-checks rule, and that `checkNow` bypasses it. I also checked `docs/architecture.md` ("throttled to one scan per minute", still true), `docs/debugging.md` (the `rebalance-monitor` namespace row already lists throttling) and the `RebalanceMonitorConfig.minRebalanceIntervalMs` doc comment. None needed a further change.

**Other categories.** No type-safety issues (`let event: RebalanceEvent | null`, and no new `any` in `src`). Resource cleanup is covered: both new pieces of state are cleared by `stop()` or the `finally`. Performance: at most one scan per interval, the same as before. Error handling: the debounce and deferred timer callbacks log rejections.

**Validation run:**
- `yarn test` in `packages/db-p2p`: 3131 passing, 63 pending, 0 failing.
- `OPTIMYSTIC_INTEGRATION=1` `small-deployment-lifecycle.integration.spec.ts`: 7 passing. Phase 3, "B joins, holds A's blocks locally", took about 11.3 s.
- `yarn lint` (root): clean. `yarn lint:docs`: clean. `tsc --noEmit` in db-p2p: clean.
