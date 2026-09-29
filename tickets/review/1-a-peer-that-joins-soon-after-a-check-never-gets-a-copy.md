description: When a new machine joined a group shortly after the group last checked its replicas, the group never sent the newcomer copies of the existing data until some unrelated connection happened later. The check that should have done it was skipped for being too soon and then forgotten; it is now postponed to the end of the waiting period instead.
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`maybeRebalance`, new `deferCheck` + `deferredCheckTimer`, `handleTopologyChange` NOTE, `stop`, `RebalanceMonitorConfig.minRebalanceIntervalMs` doc)
  - packages/db-p2p/test/rebalance-monitor.spec.ts (`debounce behavior` → "a topology change landing inside the throttle window is deferred, not dropped")
  - docs/internals.md (§ Cluster Health Monitors → RebalanceMonitor, the "Throttled to one scan per" sentence)
----
# A throttled rebalance check is deferred, not dropped

## What changed

`RebalanceMonitor.maybeRebalance` used to return silently when the last check was less than `minRebalanceIntervalMs` (60 s default) ago. The trigger was then lost: the debounce had already fired, and the growth re-check timer only arms for growth work already outstanding. A peer joining a block's cohort within 60 s of the founder's previous check was never reported `grown`, so it never received the founder's pre-existing blocks until some later connection event landed outside the window — on relay-only deployments, possibly never.

Now:

- `maybeRebalance` computes `wait = lastRebalanceAt + minRebalanceIntervalMs − now`; if positive it calls `deferCheck(wait)` and returns.
- `deferCheck` arms one `deferredCheckTimer` (unref'd) that calls `maybeRebalance` again. While armed, further refusals fold into it (it returns early). The armed timer is never due later than a newer refusal would ask for, because `lastRebalanceAt` only moves forward; if it fires early because a check ran in between (re-check timer, `checkNow`), `maybeRebalance` just defers again.
- `stop()` clears `deferredCheckTimer`.
- `pendingTopologyChange` is now cleared when a check actually *runs* (in `maybeRebalance`), not in the debounce callback. So triggers folded into a deferred check keep the earliest one's `topologyChangeTimestamp`.
- The throttle's default is unchanged.

I used a separate timer, not the re-check timer's slot. `updateRecheckTimer` disarms its timer whenever no growth work is outstanding, and a shared slot would have needed a flag to stop it cancelling a pending deferral. A throttled re-check is still covered: the deferral lives in `maybeRebalance`, which the re-check timer calls.

## Small behaviour changes a reviewer should weigh

- **`RebalanceEvent.triggeredAt` for a check with no pending topology change** (one fired by the growth re-check timer) is now `now`. It used to be the stale timestamp of the last topology change ever seen (`topologyChangeTimestamp || now`). No `src/` code reads `triggeredAt`; it is informational.
- **The debounce callback now handles rejections** (`void this.maybeRebalance().catch(log)`). It used to leave the promise floating.
- **More checks run on a live node.** A connection event inside the window used to cost nothing. Now it costs one check at the window's end, still at most one scan per `minRebalanceIntervalMs`. When the re-check timer and a deferral are both armed, the one that fires second gets deferred again, so the cadence stays at one scan per interval.

## Tripwires recorded (not tickets)

- `NOTE:` on `deferCheck`: the worst case before a joiner gets its copy is `debounceMs + minRebalanceIntervalMs`. A joiner that detaches sooner still leaves without a copy; that belongs to `a-restarted-node-forgets-which-peers-serve-its-network`. If a deployment needs a shorter delay, add a growth-only fast path for newly reported peers rather than shortening the full-scan throttle.
- The NOTE in `handleTopologyChange` is updated. It no longer claims nothing re-checks until an event outside the window. It still says that a joiner FRET (the ring-routing layer) has not admitted by check time is missed until the next connection event, which remains true.

## Known gaps I did not close (reviewer's call)

- **Partition suppression still drops a trigger.** If `partitionDetector.detectPartition()` is true when the (possibly deferred) check runs, `performRebalanceCheck` returns `null` without re-arming anything, and `pendingTopologyChange` is already cleared. This was already true before this ticket and is suppression by design, but it is the same "trigger forgotten" shape. It only bites if a partition is flagged at the exact moment the deferred check fires.
- **Overlapping checks.** `lastRebalanceAt` is set only at the *end* of `performRebalanceCheck`, which awaits a `findCluster` per tracked block. Two triggers landing while a check is in flight can both pass the throttle and run concurrently. This was also true before; the deferral adds one more trigger source that could overlap. `UnderReplicationDrain` has a `passInFlight` guard that could be mirrored if this ever matters.

## Tests

- Added `rebalance-monitor.spec.ts` → `debounce behavior` → "a topology change landing inside the throttle window is deferred, not dropped". It reproduces the bug: `debounceMs: 20, minRebalanceIntervalMs: 300`, the founder runs a self-only `checkNow()`, the cohort grows to `[self, peer]`, and `connection:open` fires. It asserts exactly one `grown: block-1 → [peer]`. I confirmed it **failed at HEAD** (waitFor timed out after 2 s) and passes after the change (~312 ms).
- The existing `throttling` spec still passes. Its second change is now deferred to about 200 ms, but the spec asserts at 50 ms and `stop()` clears the deferral.

## Validation run

- `yarn test` in `packages/db-p2p`: 3130 passing, 63 pending, 0 failing.
- `rebalance-*.spec.ts` (monitor, reaction, node-wiring, committed-holders, push-holders): 60 passing.
- `OPTIMYSTIC_INTEGRATION=1` `small-deployment-lifecycle.integration.spec.ts`: 7 passing (phase 3, "B joins, holds A's blocks locally", took about 11.5 s, as before).
- `yarn lint:docs`: clean.
