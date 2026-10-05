description: No db-p2p node could start in a browser or on React Native, because the cluster member code called a Node-only timer method directly while the node was being built. Every such call now goes through one guarded helper, and a lint rule stops a direct call from coming back.
files:
  - packages/db-p2p/src/unref-timer.ts (new `unrefTimer` helper)
  - packages/db-p2p/src/cluster/cluster-repo.ts (the six formerly unguarded sites)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts, src/cohort-topic/cold-quorum-wait.ts, src/cohort-topic/host.ts, src/reactivity/push-state-gossip.ts, src/reactivity/rotation-rereg-scheduler.ts, src/repo/cluster-coordinator.ts, src/rpc-deadline.ts, src/network/relay-reservation.ts, src/repo/under-replication-drain.ts (inline idiom / private helpers replaced)
  - eslint.config.js (`NO_TIMER_UNREF`, helper-file override)
  - packages/db-p2p/readme.md (§ React Native polyfill table row, "own code" paragraph)
  - packages/db-p2p/test/numeric-timer-handles.spec.ts (new)
difficulty: easy
repro: verified
----
# Guard every timer `.unref()` behind one helper

GitHub issue #28. In browsers and on Hermes, `setTimeout`/`setInterval` return a number, so `.unref` is `undefined`; the `ClusterMember` constructor called `this.expirationInterval.unref()` unguarded, so `createLibp2pNode` threw on those platforms.

## What landed (`ticket(implement): unguarded-timer-unref-breaks-browser-and-react-native`)

- `unrefTimer<T>(handle: T): T` in `packages/db-p2p/src/unref-timer.ts` does the guarded call and returns the handle, so call sites keep their expression shape.
- All six `cluster-repo.ts` sites and the inline `(x as { unref?… }).unref?.()` idiom in seven other modules go through it; the two private `unref` helpers are deleted.
- `NO_TIMER_UNREF` (`MemberExpression[property.name='unref']`) bans any other `.unref` access under `packages/*/src`, with an override exempting only the helper file.
- Readme polyfill table and "own code" paragraph updated.
- `test/numeric-timer-handles.spec.ts` reproduces the bug (numeric timer stubs; `ClusterMember` construction must not throw).

## Review findings

- **Diff correctness** — read every site: each replacement preserves the handle (generic return keeps `NodeJS.Timeout` field types), the `finally`-block timer and both `setupTimeouts` timers still return the same handle shape, and no call site lost its `clearTimeout`. No issues.
- **Completeness** — grepped `packages/*/src` for `.unref(`/`.ref(`/`.hasRef(`/timer `.refresh(`, `setImmediate`, `process.nextTick`: none remain outside the helper (the `refresh` hits are unrelated methods). Comment in `src/testing/mesh-harness.ts` saying the intervals are "`.unref()`ed" is still true on Node; left as is.
- **Lint config** — checked every later flat-config block that re-declares `no-restricted-syntax` for `packages/*/src` files: the `logger.ts`/`cli.ts` override carries the new selector, and the helper override drops only it. No block silently loses the rule.
- **Tripwire (parked)** — the rule covers every package but the helper lives in db-p2p, which db-core cannot import. `NOTE:` added beside `NO_TIMER_UNREF` in `eslint.config.js`: move the helper to db-core if a lower package ever needs it.
- **Tests** — the one new spec is the bug's reproduction at the lowest layer (constructor), restores globals and clears real handles in `afterEach`; kept. `dummy as any` matches the existing precedent in `supermajority-coupling.spec.ts`. No tests added or cut.
- **Docs** — readme table row and paragraph read correctly; `yarn lint:docs` clean. `docs/internals.md` names no timer-unref rule, so nothing there to update.
- **Validation** — `yarn lint` clean, `yarn lint:docs` clean, `yarn workspace @optimystic/db-p2p build` clean, db-p2p `yarn test`: 3216 passing, 68 pending, 0 failing.
- **Not run** — `yarn check:rn` and the integration suites. The change only removes a Node-only call, so Metro and `hermesc` see nothing new. An on-device run is still `feat-rn-bundle-runs-under-hermes`'s job.
- **Major / ticket-worthy** — none: nothing found that reaches the filing bar.
