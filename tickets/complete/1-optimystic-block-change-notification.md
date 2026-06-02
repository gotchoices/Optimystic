description: Per-collection change notification originated at the StorageRepo commit funnel (db-core contract + db-p2p origination/routing + NetworkTransactor delegation) — implemented and reviewed
files: packages/db-core/src/transactor/change-notifier.ts, packages/db-core/src/transactor/index.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md
----

# Block/collection change notification at the storage commit funnel

## What shipped

A lowest-level "this collection changed" signal so reactive consumers (the Quereus
vtab bridge, downstream tickets) can be woken on commits without polling. This ticket
delivered the db-core contract + db-p2p origination/routing + the `NetworkTransactor`
delegation option. It deliberately does **not** wire Quereus or the plugin.

1. **db-core contract** — `packages/db-core/src/transactor/change-notifier.ts`:
   `CollectionChangeEvent { collectionId, blockIds, actionId, rev }`,
   `CollectionChangeListener`, `IBlockChangeNotifier.onCollectionChange(...)`,
   `isBlockChangeNotifier(x)` guard. Re-exported via `transactor/index.ts`. Kept
   separate from `ITransactor`/`IRepo` so it is opt-in / feature-detected.

2. **db-p2p origination** — `StorageRepo implements IRepo, IBlockChangeNotifier`:
   per-collection listener registry, idempotent unsubscribe with empty-set pruning;
   `internalCommit` returns the affected `CollectionId` (`newBlock.header` →
   `priorBlock.header` fallback for deletes → `undefined` skips); `commit` aggregates
   `{collectionId → blockIds[]}` and emits one event per distinct collection after the
   lock `finally`, only on `success: true`, only for newly-committed blocks. Listeners
   are snapshotted; throwing listeners are isolated + logged.

3. **Node exposure** — `libp2p-node-base.ts` sets
   `(node as any).blockChangeNotifier = storageRepo`.

4. **Transactor delegation** — `NetworkTransactor implements IBlockChangeNotifier`
   with an optional `localChangeNotifier?` ctor option; delegates when present, else a
   logged no-op with inert unsubscribe. Backward-compatible (no caller changed).

5. **Breadcrumb** — `// TODO: emit CollectionChangeEvent here once replicas persist`
   in `BlockTransferService.handlePush` (tracked by
   `optimystic-churn-rereplication-persist-handlepush`).

## Validation

- Build: `packages/db-core` and `packages/db-p2p` both `yarn build` clean (tsc; no
  separate lint script in the repo).
- `packages/db-p2p` full suite: **466 passing, 8 pending, 0 failing** (~20s). The
  previously-flagged flaky `fresh-node-ddl-multi.spec.ts` Scenario B passed this run;
  its triage already landed in commit 441c8fa and `.pre-existing-error.md` is gone.
- Focused: `storage-repo.spec.ts` → `describe('change notification (IBlockChangeNotifier)')`,
  now **8 cases** (7 from implement + the delete-path case added in review).

## Review findings

Adversarial pass over commit `781a085`. Scrutinized SPP/DRY/modularity, scalability,
maintainability, performance, resource cleanup, error handling, and type safety.

**Checked & clean (no action):**
- **Type safety** — `CollectionId = BlockId = string`; `header.collectionId` (typed
  `BlockId`) flows correctly into `CollectionChangeEvent.collectionId`. `ActionId`
  import path (`collection/action.js`) is correct. No `any` introduced beyond the
  pre-existing `(node as any)` exposure pattern, which is consistent with the existing
  `coordinatedRepo`/`storageRepo` surface and is feature-detected via the guard.
- **Concurrency / re-entrancy** — `emitCollectionChanges` runs after locks release and
  is fully synchronous (no `await`), so it is atomic w.r.t. the event loop; the
  `Array.from(listeners)` snapshot makes subscribe/unsubscribe-during-emit safe. The
  unsubscribe closure is guarded idempotent and prunes empty sets — no leak.
- **Idempotency / no double-fire** — `alreadyDone` (`continue`) and stale
  (`missedCommits` early return) partitions never populate `collectionBlocks`;
  verified by the re-commit test.
- **Listener isolation & error handling** — throwing listener is caught + logged and
  does not break the commit or sibling listeners (test confirms). Matches AGENTS.md
  "don't eat exceptions w/o logging".
- **`NetworkTransactor` delegation** — passes through when `localChangeNotifier` set,
  logged inert no-op otherwise; optional ctor field, no existing caller affected. The
  plugin (`CollectionFactory.createNetworkTransactor`) correctly does **not** yet pass
  it — out of scope, consumer ticket owns the wiring.

**Found & fixed inline (minor):**
- **Docs were stale.** `docs/internals.md` had no mention of the notifier. Added a
  "Change Notification (Reactive Wake)" subsection under the Commit Path documenting
  origination, ordering/fire-and-forget semantics, the success-only/newly-committed
  guarantee, node exposure, and the known silent-drop paths.
- **Delete path was untested** (implementer-flagged). Added
  `makeDeleteTransforms` + an insert-then-delete test asserting the event fires with
  the **prior** block's `collectionId` (exercises the `newBlock === undefined`
  fallback in `internalCommit`). Suite now 28 cases in that file, all green.

**Found & deferred to new ticket (major):**
- **Change events can be silently dropped on two recovery paths** → filed
  `tickets/fix/optimystic-change-event-silent-drops.md`. (1) `get()`-driven promotion
  ignores `internalCommit`'s return so a block committed during a *read* emits nothing
  (implementer-flagged). (2) **New in review:** a failed partial multi-block commit
  lands blocks `1..N-1` durably but returns before emitting; the idempotent retry
  treats them as `alreadyDone`, so their event is lost permanently. Not fixed inline
  because the right behavior (emit eagerly vs. success-only + consumer reconcile) is a
  design call that depends on the not-yet-built reactive consumer's tolerance; the
  ticket lays out both options and is gated behind `optimystic-vtab-reactive-watch-bridge`.

**Acknowledged, no action (consumer/integration scope, correctly out of this ticket):**
- No end-to-end consumer yet — `NetworkTransactor.onCollectionChange` is inert until a
  caller supplies `localChangeNotifier`; that wiring belongs to the vtab bridge ticket.
- Remote-author path is unit-modeled (direct repo commit) rather than exercised through
  a live `ClusterMember.handleConsensus → StorageRepo.commit` cluster; an integration
  test is reasonable future work but outside this contract-level ticket.
- Replica-persist landing path (`BlockTransferService.handlePush`) is a distinct origin
  tracked by `optimystic-churn-rereplication-persist-handlepush`.
- Fire-and-forget / unordered-across-collections semantics are intentional and now
  documented; any consumer needing ordering or async completion must arrange it itself.
