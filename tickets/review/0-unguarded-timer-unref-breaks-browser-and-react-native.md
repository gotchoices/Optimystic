description: No db-p2p node could start in a browser or on React Native, because the cluster member code called a Node-only timer method directly while the node was being built. Every such call now goes through one guarded helper, and a lint rule stops a direct call from coming back.
files:
  - packages/db-p2p/src/unref-timer.ts (new `unrefTimer` helper)
  - packages/db-p2p/src/cluster/cluster-repo.ts (the six formerly unguarded sites)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts, src/cohort-topic/cold-quorum-wait.ts, src/cohort-topic/host.ts, src/reactivity/push-state-gossip.ts, src/reactivity/rotation-rereg-scheduler.ts, src/repo/cluster-coordinator.ts, src/rpc-deadline.ts, src/network/relay-reservation.ts, src/repo/under-replication-drain.ts (inline idiom / private helpers replaced)
  - eslint.config.js (`NO_TIMER_UNREF`, helper-file override, NOTE updated)
  - packages/db-p2p/readme.md (§ React Native polyfill table row, "own code" paragraph)
  - packages/db-p2p/test/numeric-timer-handles.spec.ts (new)
difficulty: easy
repro: verified
----
# Guard every timer `.unref()` behind one helper — review handoff

GitHub issue #28. In browsers and on Hermes, `setTimeout`/`setInterval` return a number, so `.unref` is `undefined`; the `ClusterMember` constructor called `this.expirationInterval.unref()` unguarded, so `createLibp2pNode` threw on those platforms.

## What changed

- `unrefTimer<T>(handle: T): T` in `packages/db-p2p/src/unref-timer.ts` does the guarded call and returns the handle, so call sites keep their expression shape (`unrefTimer(setTimeout(...))`).
- All six `cluster-repo.ts` sites (constructor's two intervals, the `pendingUpdates` delete timer in `update`'s `finally`, `withReconcileTimeout`, both timers in `setupTimeouts`) go through it. Field types (`NodeJS.Timeout`) unchanged — the generic return preserves them.
- The inline `(x as { unref?: () => void }).unref?.()` idiom in seven modules is replaced; the private `unref` helpers in `relay-reservation.ts` and `under-replication-drain.ts` are deleted and their call sites call `unrefTimer` directly.
- `eslint.config.js`: `NO_TIMER_UNREF` (`MemberExpression[property.name='unref']`) added to the `packages/*/src/**/*.ts` list and to the `logger.ts`/`cli.ts` override; a new override for `packages/db-p2p/src/unref-timer.ts` re-declares the list minus that selector. The "too pervasive to ban" NOTE no longer names timer `.ref()`/`.unref()` (`.ref()` has no first-party call site — grepped).
- Readme: the polyfill row for timer `.ref()`/`.unref()` now names only `undici`; the "Optimystic's own code also does not call…" paragraph states the `unrefTimer` rule.

## Test

- `packages/db-p2p/test/numeric-timer-handles.spec.ts` — stubs `setTimeout`/`setInterval` (and the matching clears) to return numbers, delegating to the real timers and clearing them in `afterEach`; asserts `new ClusterMember(dummy, dummy, dummy, dummy)` does not throw. Confirmed it fails with `this.expirationInterval.unref is not a function` when the constructor line is reverted, and passes with the fix.

## Validation run

- `yarn lint` clean; a deliberate `setTimeout(f, 1).unref()` probe file under `packages/db-p2p/src/` was flagged with the new message (probe deleted).
- `yarn lint:docs` clean.
- `yarn workspace @optimystic/db-p2p build` clean.
- db-p2p `yarn test`: 3204 passing, 65 pending, 0 failing.

## Known gaps

- Not run: `yarn check:rn`, integration suites, other packages' tests (no other package touched; no other `src/` calls `.unref`).
- The spec only covers `ClusterMember` construction — the other sites run later (on demand), and are covered by the lint rule rather than a runtime test. A full on-device run is still `feat-rn-bundle-runs-under-hermes`'s job.
- The lint rule bans any property named `unref` in `packages/*/src`, including a non-timer object that happened to have one; none exists today.
