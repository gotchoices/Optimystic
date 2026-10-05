description: No db-p2p node can start in a browser or on React Native, because the cluster member code calls a Node-only timer method directly and two of those calls run while the node is being built. Route every such call through one guarded helper and add a lint rule so it cannot come back. Must land before the next release.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (six unguarded sites: constructor `expirationInterval` / `cleanupInterval`, the `pendingUpdates` delete timer in `update`'s `finally`, `withReconcileTimeout`, two in `setupTimeouts`)
  - packages/db-p2p/src/network/relay-reservation.ts, packages/db-p2p/src/repo/under-replication-drain.ts (private `unref` helpers to delete)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts, src/cohort-topic/cold-quorum-wait.ts, src/cohort-topic/host.ts, src/reactivity/push-state-gossip.ts, src/reactivity/rotation-rereg-scheduler.ts, src/repo/cluster-coordinator.ts, src/rpc-deadline.ts (inline `(t as { unref?: () => void }).unref?.()` idiom to replace)
  - packages/db-p2p/src/unref-timer.ts (new helper)
  - eslint.config.js (new `no-restricted-syntax` entry; update the "timer `.ref()`/`.unref()`" NOTE near `NO_MODULE_SCOPE_TEXT_DECODER`)
  - packages/db-p2p/readme.md (§ React Native polyfill table row "Timer `.ref()` / `.unref()`")
  - packages/db-p2p/test/supermajority-coupling.spec.ts (shows how to construct a bare `ClusterMember` with dummies)
difficulty: easy
repro: verified
----
# Guard every timer `.unref()` behind one helper

GitHub issue #28: https://github.com/gotchoices/Optimystic/issues/28

## The defect

In a browser and on React Native (Hermes), `setTimeout` / `setInterval` return a number, not a Node `Timeout` object, so `.unref` is `undefined` there. `createLibp2pNodeBase` builds a `ClusterMember` on every node, and the `ClusterMember` constructor in `packages/db-p2p/src/cluster/cluster-repo.ts` calls `this.expirationInterval.unref()` unguarded, so `createLibp2pNode` throws `TypeError: this.expirationInterval.unref is not a function` on those platforms. Reporter confirmed on 1.8.1, 1.9.0 and 0.27.0.

Reproduced at HEAD with a throwaway spec that replaced `globalThis.setInterval` with a wrapper returning an incrementing number and constructed `new ClusterMember(dummy, dummy, dummy, dummy)` (the same construction `supermajority-coupling.spec.ts` uses): it threw `this.expirationInterval.unref is not a function`.

`grep -rnE "\.unref" packages/*/src` finds exactly six unguarded calls, all in `cluster-repo.ts`. Every other site in db-p2p is already guarded, by one idiom repeated in nine modules, two of which (`relay-reservation.ts`, `under-replication-drain.ts`) define their own private `unref` helper. No other package's `src/` calls `.unref`.

## Why nothing caught it

- `rn-bundle-check` bundles and compiles but never executes (its readme says so); `feat-rn-bundle-runs-under-hermes` would catch it.
- `packages/db-p2p/readme.md`'s React Native polyfill table lists "Timer `.ref()` / `.unref()`" as a required host polyfill naming `@optimystic/db-p2p` among the needers, and the NOTE in `eslint.config.js` beside `NO_MODULE_SCOPE_TEXT_DECODER` declined a lint rule for the same reason. That made the RN crash "the host's missing polyfill", but browsers have no such polyfill convention, and a library should not demand one for something it can guard in one line. After this fix db-p2p no longer needs it; the row stays only for `undici` (and any other dependency listed).

## Fix

- New module `packages/db-p2p/src/unref-timer.ts` exporting one helper, e.g.

  ```ts
  /** Keep a pending timer from holding a Node process open. Browsers and React Native return a number, which has no `unref`. */
  export function unrefTimer<T>(handle: T): T {
  	(handle as { unref?: () => void }).unref?.();
  	return handle;
  }
  ```

  Returning the handle lets `setupTimeouts` and the `update` `finally` keep their expression shape (`unrefTimer(setTimeout(...))`). Typing: the existing fields are `NodeJS.Timeout`; keep whatever types compile, or switch them to `ReturnType<typeof setTimeout>` / `ReturnType<typeof setInterval>` where it is cleaner.
- Route all six `cluster-repo.ts` sites through it.
- Replace the inline idiom in the seven listed modules and delete the two private helpers, importing the shared one instead. Keep each site's existing comment where it explains *why* the timer is unref'd.
- Lint: add a `NO_TIMER_UNREF` entry to `eslint.config.js` banning any `.unref` property access in `packages/*/src/**` — selector `MemberExpression[property.name='unref']` — with a message pointing at `unrefTimer` in `packages/db-p2p/src/unref-timer.ts`. Banning the guarded spelling too (not just a non-optional call) is deliberate: it leaves one site to read and one place to change. Add it to the `packages/*/src/**/*.ts` `no-restricted-syntax` list, and add a narrow override block for `packages/db-p2p/src/unref-timer.ts` that re-declares `no-restricted-syntax` with the other selectors minus this one (flat config replaces the whole rule config — see the existing `logger.ts` override for the pattern). Confirm with `yarn lint` that the rule fires on a deliberate `setTimeout(f, 1).unref()` and that the tree is clean.
- Update the NOTE in `eslint.config.js` (drop timer `.ref()`/`.unref()` from the "too pervasive to ban" list; `.ref()` has no first-party call site today — check with grep) and the readme polyfill table row so it no longer names `@optimystic/db-p2p`. Add one sentence to the readme's "Optimystic's own code also does not call…" paragraph saying db-p2p guards every `unref` through `unrefTimer`, enforced by the lint rule.
- Test (the reproduction, at the lowest layer): one spec, e.g. `packages/db-p2p/test/numeric-timer-handles.spec.ts`, that stubs `globalThis.setInterval` and `globalThis.setTimeout` to return numbers (delegating to the real ones and clearing them in `afterEach`, so nothing leaks) and asserts `new ClusterMember(dummy, dummy, dummy, dummy)` does not throw. Restore the globals in `finally`/`afterEach`. Do not add a separate test for the helper itself — the lint rule and this spec cover it. Node behaviour is unchanged (handles are still unref'd), so existing suites exiting cleanly is the check there.

## TODO

- Add `packages/db-p2p/src/unref-timer.ts` with `unrefTimer`.
- Route the six `cluster-repo.ts` sites through it.
- Replace the inline idiom in rebalance-monitor, cold-quorum-wait, host, push-state-gossip, rotation-rereg-scheduler, cluster-coordinator, rpc-deadline; delete the private helpers in relay-reservation and under-replication-drain.
- Add `NO_TIMER_UNREF` to `eslint.config.js` with the helper-file override; update the NOTE.
- Update `packages/db-p2p/readme.md` (polyfill table row + the "own code" paragraph).
- Add the numeric-timer-handle spec for `ClusterMember` construction.
- Run `yarn lint`, `yarn lint:docs`, `yarn workspace @optimystic/db-p2p build`, and the db-p2p test suite.
