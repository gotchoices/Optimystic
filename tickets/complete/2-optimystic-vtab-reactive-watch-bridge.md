description: COMPLETE — optimystic Quereus vtab bridges collection-change notifications to Quereus watch invalidation (Database.notifyExternalChange), so reactive consumers wake on commits without polling. Reviewed; implementation sound; one error-isolation regression test added inline; two follow-ups filed to backlog. 197 passing, 0 failing.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md
----

# Complete: optimystic vtab → Quereus reactive-watch bridge

Closes the loop: a commit on an optimystic-backed collection (local or remote)
wakes Quereus `Database.watch` consumers through the normal reactive path.

Flow: `StorageRepo.commit → CollectionChangeEvent → transactor.onCollectionChange
→ OptimysticVirtualTable listener → Database.notifyExternalChange(table) → watchers`.

## What shipped

### `collection-factory.ts`
- **Network transactor wiring.** `createNetworkTransactor` reads
  `(node as any).blockChangeNotifier` (the hosting node's `StorageRepo`, exposed by
  `libp2p-node-base` at line 524) and passes it as `localChangeNotifier` into the
  `NetworkTransactor` config. Cached on `nodeInfo` so it survives node reuse.
- **Local/test transactors are now `IBlockChangeNotifier`s** — both add
  `onCollectionChange: storageRepo.onCollectionChange.bind(storageRepo)`, making
  single-process multi-collection scenarios reactive without libp2p.
- **`getCollectionId(options)`** — public helper returning
  `parseCollectionId(collectionUri)`; equals `header.collectionId` and therefore
  `CollectionChangeEvent.collectionId` (pinned by a test).
- **`subscribeToCollectionChanges(options, collectionId, listener)`** — resolves
  the transactor, feature-detects `isBlockChangeNotifier`, registers, returns an
  (idempotent) unsubscribe; logged no-op when the transactor isn't a notifier.
- **`mesh-test` left unwired** (sanctioned): its `NetworkTransactor` gets no
  `localChangeNotifier`, so `onCollectionChange` is an inert no-op.

### `optimystic-module.ts` (`OptimysticVirtualTable`)
- `doInitialize` calls `ensureChangeSubscription()` after init (self-isolating —
  a wiring failure never blocks init). Subscribe-once guard (`changeSubscribed`),
  skips `tree://optimystic/schema`, subscribes only to the main collection id.
- `handleCollectionChange` → `db.notifyExternalChange(tableName, schemaName)` with
  full error isolation (sync try/catch + `.catch` on the returned promise).
- `teardownChangeSubscription()` called from `OptimysticModule.destroy`
  (DROP TABLE) — deliberately NOT from per-statement `disconnect()`.

## Review findings

Adversarial pass over the implement diff (`415e098`), read before the handoff
summary. Scrutinized from SRP, DRY, modularity, scalability, resource cleanup,
error handling, and type-safety angles, and cross-checked the prereq APIs
(`change-notifier.ts`, `StorageRepo.emitCollectionChanges`/`internalCommit`,
`NetworkTransactor.localChangeNotifier`, `Database.notifyExternalChange`) in
source. Build + typecheck + tests green at handoff.

### MINOR (fixed inline)

- **Error-isolation path was untested — now covered.** `handleCollectionChange`
  defends against both a *synchronous throw* and an *async rejection* from
  `db.notifyExternalChange`, but no test exercised either branch (the implementer
  flagged this as an adversarial angle). Added
  `isolates a throwing/rejecting notifyExternalChange from the storage commit` to
  `test/reactive-watch.spec.ts`: monkeypatches `notifyExternalChange` to throw
  synchronously, then to return a rejected promise, drives an external commit
  through each, and asserts (a) the storage commit still resolves and (b) no
  `unhandledRejection` escapes (tracked via a `process` listener). Both branches
  are confirmed hit — the run emits the `threw for 't': boom (sync)` and
  `failed for 't': boom (async)` log lines and passes. No production code changed.

### MAJOR (filed as new backlog tickets — out of this ticket's scope)

- **db-close listener leak** → `tickets/backlog/optimystic-vtab-watch-db-close-teardown.md`.
  The subscription is released on DROP TABLE but not on `Database.close()`. A db
  closed with tables still defined leaves the storage listener attached to the
  factory-cached `StorageRepo` until GC; each subsequent external commit drives a
  caught-and-logged `notifyExternalChange → checkOpen` throw (benign but noisy, and
  the listener set never shrinks). A clean fix needs a Quereus-side close hook or
  module-level connection tracking — genuinely out of scope here. Benign, low
  priority; filed to backlog rather than fixed inline.
- **Network/libp2p path has no end-to-end test** →
  `tickets/backlog/optimystic-network-reactive-watch-integration-test.md`. The
  network plumbing (`node.blockChangeNotifier` → `localChangeNotifier` →
  `NetworkTransactor.onCollectionChange` → vtab) is verified *structurally* in
  source + dist and shares the exact vtab→Quereus code the in-process specs cover,
  but no `OPTIMYSTIC_INTEGRATION` case drives a real libp2p commit to a watcher.
  Filed as a follow-up integration test.

### Checked and found sound (no action)

- **Teardown hook (destroy, not disconnect).** Agree with the implementer's
  intentional deviation from the ticket TODO: `disconnect()` is a per-statement
  no-op that keeps the table initialized across scans, so unsubscribing there would
  kill reactivity after the first scan. `destroy()` (DROP TABLE) is the correct
  lifetime boundary. Confirmed there is exactly one `OptimysticVirtualTable` per
  `schema.table` (the `tables` map reuses instances), so no orphaned duplicate
  subscriptions.
- **Subscribe-once guard.** `changeSubscribed = true` is set before the await, and
  `ensureChangeSubscription` is only reachable from `doInitialize`, which is
  serialized by `initializationPromise` and short-circuits on `isInitialized` — so
  no concurrent double-subscribe is possible. The failure reset to `false` is inert
  (init won't re-run) but harmless.
- **collectionId mapping.** Verified in source: `StorageRepo.internalCommit`
  returns `newBlock?.header.collectionId ?? priorBlock?.header.collectionId`, which
  is what `emitCollectionChanges` keys on; equals `parseCollectionId(uri)` =
  `getCollectionId(options)`. Also pinned empirically by the
  `maps the collection URI to the canonical collection id` spec.
- **Scoping.** Main collection only; index sub-collections (`<uri>/index/<name>`)
  carry their own ids and aren't separately watched (whole-table invalidation
  re-queries them); schema tree skipped. A data write mutates the main tree, so the
  main-collection event always fires — no missed wake.
- **Error isolation (StorageRepo side).** `emitCollectionChanges` already snapshots
  listeners and isolates a throwing listener (log + continue); the vtab's own
  try/catch + `.catch` is a correct second line of defence against the *async*
  `notifyExternalChange` rejection that the storage funnel can't see. Fire-and-forget
  (never awaited) — the commit is never blocked by watch dispatch.
- **Feature detection.** A transactor lacking `onCollectionChange` (e.g. the
  `catalog-hydration.spec.ts` mock, custom transactors, `mesh-test`'s notifier with
  no `localChangeNotifier`) degrades to a logged no-op; the expected `console.debug`
  lines in test output are not regressions.
- **Type safety.** `as any` is confined to the two untyped libp2p-node extension
  reads (`node.blockChangeNotifier`, `node.coordinatedRepo`) — unavoidable given
  the node's dynamic property surface; the transactor objects are typed
  `ITransactor & IBlockChangeNotifier`.
- **Redundant self-wakeup (#4)** and **`mesh-test` no-op (#5)** — reviewed; both are
  documented, accepted v1 limitations (over-firing only re-queries; no loop). No
  action.

### Docs

Read every touched doc against the new reality — both are accurate and complete:
- `docs/internals.md` — "Change Notification (Reactive Wake)" + "Reactive Watch
  Bridge (Quereus vtab)" sections correctly describe the flow, transactor wiring,
  subscription identity, coarse invalidation, redundant self-wakeup, lifetime
  (incl. the db-close leak), and host requirement.
- `packages/quereus-plugin-optimystic/README.md` — "Reactive Watching" section
  matches the shipped behavior (coarse whole-table invalidation, host requirement,
  transactor support / graceful degradation).

### Validation performed

> `dist` is gitignored; tests import from `../dist/`, so build first.

- `yarn build` (tsup, regenerates dist) — clean.
- `yarn typecheck` (`tsc --noEmit`, includes test files) — clean.
- `yarn test` — **197 passing, 4 pending, 0 failing** (~2m). The +1 over the
  implement handoff's 196 is the new error-isolation case. The 4 pending are the
  `OPTIMYSTIC_INTEGRATION`-gated libp2p specs. No pre-existing failures surfaced.
- Lint — repo `lint` script is an unconfigured `echo` no-op; nothing to run.

## Out of scope (unchanged from handoff)
- Edge/client nodes that don't host blocks (no push; still poll).
- Push/replication-path emission (`optimystic-churn-rereplication-persist-handlepush`).
- Per-row precise invalidation (Quereus API is coarse by design).
- Sereus `StrandWatcher` migration (separate `cadre-core` repo).

## End
