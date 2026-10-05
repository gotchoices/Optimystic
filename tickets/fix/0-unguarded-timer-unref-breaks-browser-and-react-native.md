description: No db-p2p node can start in a browser or on React Native, because `ClusterMember` calls `.unref()` directly on timer handles, which are plain numbers outside Node, and two of those calls run in its constructor. Must land before the next release.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (every site: the constructor's `expirationInterval` / `cleanupInterval`, the `pendingUpdates` delete timer in `update`'s `finally`, `withReconcileTimeout`, `setupTimeouts`)
  - packages/db-p2p/src/network/relay-reservation.ts, packages/db-p2p/src/repo/under-replication-drain.ts (each defines its own private `unref` helper; fold into one shared helper)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts, src/cohort-topic/cold-quorum-wait.ts, src/cohort-topic/host.ts, src/reactivity/push-state-gossip.ts, src/reactivity/rotation-rereg-scheduler.ts, src/repo/cluster-coordinator.ts, src/rpc-deadline.ts (the inline `(t as { unref?: () => void }).unref?.()` idiom, repeated)
  - eslint.config.js (the `no-restricted-syntax` list that already bans class static blocks for the same platform reason)
  - packages/rn-bundle-check/readme.md, tickets/backlog/feat-rn-bundle-runs-under-hermes.md
difficulty: easy
repro: verified
severity: crash
likelihood: certain

# Unguarded timer `.unref()` breaks every node outside Node

GitHub issue #28: https://github.com/gotchoices/Optimystic/issues/28

## What happens

In a browser and on React Native, `setTimeout` / `setInterval` return a number. `createLibp2pNodeBase` builds a
`ClusterMember` on every node, and its constructor calls `this.expirationInterval.unref()`, so `createLibp2pNode`
throws `TypeError: this.expirationInterval.unref is not a function` on those platforms, even though db-p2p ships a
`react-native` export condition. Reporter confirmed on 1.8.1 and 1.9.0 (and 0.27.0).

## Verified against HEAD

`grep -rnE "\.unref\(" packages/*/src`, minus the guarded idiom, leaves exactly six unguarded calls, all in
`packages/db-p2p/src/cluster/cluster-repo.ts`:

- constructor: `this.expirationInterval.unref()` and `this.cleanupInterval.unref()`
- `update`'s `finally`: `setTimeout(() => this.pendingUpdates.delete(...), 100).unref()`
- `withReconcileTimeout`: `timer.unref()`
- `setupTimeouts`: two `setTimeout(...).unref()` calls

Every other timer under `packages/*/src` is already guarded, but by the same idiom repeated in nine modules, two of
which define their own private `unref` helper.

## Fix

- Add one exported helper (e.g. `unrefTimer(handle)`) and route all six `cluster-repo.ts` sites through it.
- Replace the duplicated inline idiom and the two private helpers with it.
- Add a lint rule so it cannot recur: a `no-restricted-syntax` selector banning a non-optional `.unref()` call
  (e.g. `CallExpression[optional=false] > MemberExpression[property.name='unref']`), in the style of
  `NO_STATIC_BLOCK`, with an exemption only for the helper itself. `rn-bundle-check` cannot catch this: it bundles
  and compiles but never executes (its readme says so). `feat-rn-bundle-runs-under-hermes` would catch it; the lint
  rule is the cheap gate until then.
- Test: construct `ClusterMember` (ideally a whole node) with `setTimeout`/`setInterval` stubbed to return numbers,
  asserting no throw. Keep Node behaviour: timers still unref'd so test processes exit.
