----
description: Originate and route per-collection change notifications from the storage commit funnel so a hosting node detects remote (and local) commits to an optimystic-backed collection
files: packages/db-core/src/transactor/transactor.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/blocks/structs.ts, packages/db-core/src/index.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/test/storage-repo.spec.ts
----

# Block/collection change notification at the storage commit funnel

## Goal

Provide the lowest, most reliable origin of a "this collection changed" signal so
that reactive consumers (the Quereus vtab — see prereq-less sibling ticket
`optimystic-vtab-reactive-watch-bridge`) can be woken on remote commits without
polling. This ticket delivers **only** the db-core contract + db-p2p origination
and routing; it does NOT touch Quereus or the plugin.

The Sereus `StrandWatcher` polls today (`packages/cadre-core/src/strand-watcher.ts`,
a separate repo) precisely because optimystic emits no such signal. This is the
upstream gap.

## Why the storage commit funnel is the right origin

Every committed transaction — regardless of which peer authored it — lands on a
node that hosts the affected blocks through a single funnel:

```
local author:   NetworkTransactor.commit → CoordinatorRepo → StorageRepo.commit
remote author:  cluster consensus → ClusterMember.handleConsensus → StorageRepo.commit
```

`StorageRepo` is constructed once per node in
`packages/db-p2p/src/libp2p-node-base.ts:167-169` and shared by both the
coordinated path and the direct path (the `repoProxy`/`coordinatedRepo` wiring at
`libp2p-node-base.ts:183-200`). So emitting from `StorageRepo.commit` captures
**all** commits a node witnesses, satisfying the ticket requirement that detection
"must not depend on the change having been authored through the local Database
instance."

The commit applies each block's transform and updates its latest revision in
`StorageRepo.internalCommit` (`storage-repo.ts:308-343`), specifically the
`toCommit` loop at `storage-repo.ts:273-285` and `setLatest` at
`storage-repo.ts:342`. The materialized `newBlock` (`storage-repo.ts:329`) carries
`header.collectionId` (`packages/db-core/src/blocks/structs.ts:4-8`), which is the
collection's header block id — the same value the plugin derives from its
collection URI. That gives us collection-scoped routing for free.

## Scope of detection (and explicit non-goals)

- **In scope:** commits that land via `StorageRepo.commit` on a node that hosts
  (is a cluster member for) the collection's blocks. This is exactly the cadre
  use case ("a node hosting a cadre wants to react to strands created or updated
  by peers").
- **Out of scope (note as future, do NOT build here):**
  - Push/sync replication (`BlockTransferService.handlePush`) is a *different*
    landing path and is itself only just being made to persist (see
    `tickets/implement/optimystic-churn-rereplication-persist-handlepush.md`).
    Once `saveReplicatedBlock` persists a replica it should *also* emit a change
    event, but that is a follow-up — leave a `// TODO` breadcrumb there, do not
    wire it in this ticket.
  - Pure edge/client nodes that hold a collection open but do **not** host its
    blocks learn of changes only by fetching; server-push subscriptions for them
    are a separate, larger feature. Out of scope.

## Design

### 1. db-core: the capability contract

Add a standalone capability interface (a new file
`packages/db-core/src/transactor/change-notifier.ts`, re-exported from
`packages/db-core/src/index.ts`). Keep it **separate** from `ITransactor`/`IRepo`
so implementations opt in and consumers feature-detect — most transactors
(test/local stubs that are single-process) can still support it, but a bare
`ITransactor` is not forced to.

```ts
import type { BlockId, CollectionId } from '../index.js';
import type { ActionId } from '../collection/action.js';

/** A commit landed on this node mutating one collection's blocks. */
export type CollectionChangeEvent = {
  /** Header/collection id of the affected collection (block.header.collectionId). */
  readonly collectionId: CollectionId;
  /** Blocks within that collection mutated by this commit. */
  readonly blockIds: readonly BlockId[];
  readonly actionId: ActionId;
  readonly rev: number;
};

export type CollectionChangeListener = (event: CollectionChangeEvent) => void;

export interface IBlockChangeNotifier {
  /**
   * Subscribe to commits that mutate the given collection. Returns an
   * idempotent unsubscribe. Listeners are invoked AFTER the commit's critical
   * section (locks released), synchronously in commit order; a throwing
   * listener must not break the commit or other listeners (log + continue).
   */
  onCollectionChange(collectionId: CollectionId, listener: CollectionChangeListener): () => void;
}

export function isBlockChangeNotifier(x: unknown): x is IBlockChangeNotifier {
  return !!x && typeof (x as IBlockChangeNotifier).onCollectionChange === 'function';
}
```

(Confirm the existing `CollectionId`/`BlockId`/`ActionId` export paths while
wiring — `CollectionId` lives in `packages/db-core/src/collection/index.ts`,
`ActionId` in `packages/db-core/src/collection/action.ts`.)

### 2. db-p2p: `StorageRepo` originates events

`StorageRepo` (`storage-repo.ts:22`) implements `IBlockChangeNotifier`.

- Hold a registry `Map<CollectionId, Set<CollectionChangeListener>>`. `onCollectionChange`
  adds/removes; cleaning up empty sets on unsubscribe.
- `internalCommit` (`storage-repo.ts:308-343`) currently returns `void`. Change it
  to return the affected `collectionId` for that block: read it from the
  materialized `newBlock.header.collectionId` (`storage-repo.ts:329-331`); for a
  delete (`newBlock` undefined) fall back to `priorBlock?.header.collectionId`
  (`storage-repo.ts:322-325`). If neither is available, return `undefined` and
  skip that block (defensive — should not happen for a real committed block).
- In `commit` (`storage-repo.ts:193-293`), aggregate `{ collectionId → blockIds[] }`
  across the `toCommit` loop (`storage-repo.ts:273-285`). Emit ONE
  `CollectionChangeEvent` per distinct `collectionId` **after** the `finally`
  releases the latches (`storage-repo.ts:287-290`) and only when
  `success: true`. Do not emit for the idempotent-`alreadyDone` / stale-conflict
  partitions (those blocks were not newly committed here).
- Wrap each listener call in try/catch and log (project rule: never eat
  exceptions silently). Emission is fire-and-forget synchronous; do not `await`
  listeners inside the commit path.

Note: a single commit's `actionId`/`rev` are shared across all its blocks
(`request.actionId`, `request.rev`), so one event per collection per commit is
correct.

### 3. db-p2p: expose the notifier on the node and surface it on the transactor

- `createLibp2pNodeBase` already stashes `coordinatedRepo` on the node
  (`libp2p-node-base.ts:520`). Also expose the underlying `storageRepo` as the
  change notifier: `(node as any).blockChangeNotifier = storageRepo;`. (It is the
  same `storageRepo` the cluster/coordinator paths commit into.)
- `NetworkTransactor` (`packages/db-core/src/transactor/network-transactor.ts`)
  should optionally implement `IBlockChangeNotifier` by delegating to a
  **local** notifier supplied at construction. Add an optional
  `localChangeNotifier?: IBlockChangeNotifier` to its constructor options and
  implement `onCollectionChange` as a pass-through when present (no-op
  unsubscribe + a `console.debug`/log when absent). This keeps the capability
  uniformly on the transactor so the plugin can feature-detect on the transactor
  it already holds, rather than reaching into node internals.

  The plugin's `CollectionFactory.createNetworkTransactor`
  (`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:106-158`)
  will pass `node.blockChangeNotifier` into this option — that wiring belongs to
  the prereq plugin ticket, not here, but design the option so it slots in.

## Key tests (db-p2p)

Add `packages/db-p2p/test/storage-repo.spec.ts` coverage (or a new spec) proving
the origin works against a real `StorageRepo` + `MemoryRawStorage`:

- **Fires on commit:** subscribe to collection C; pend+commit a block whose
  `header.collectionId === C`; assert exactly one `CollectionChangeEvent` with the
  committed `blockIds`, `actionId`, `rev`.
- **Collection scoping:** a commit to collection D does NOT notify a C subscriber.
- **Two collections, one repo (models "remote author"):** open two `Collection`s
  on the **same** `StorageRepo`-backed transactor; commit through collection A;
  assert a listener registered for B's id is *not* called and one for A's id *is*
  — demonstrating that a writer the local Database never drove still emits.
- **Idempotent re-commit:** committing the same `(actionId, rev)` again (rollforward
  path) does NOT re-emit (it hits the `alreadyDone` partition).
- **Unsubscribe** stops further events and is idempotent.
- **Throwing listener** is isolated: a second listener still fires and the commit
  still returns `success: true`.

Run streamed: `cd packages/db-p2p && yarn test 2>&1 | tee /tmp/db-p2p-test.log`.

## TODO

- [ ] Add `packages/db-core/src/transactor/change-notifier.ts` with
      `CollectionChangeEvent`, `CollectionChangeListener`, `IBlockChangeNotifier`,
      `isBlockChangeNotifier`; export from `packages/db-core/src/index.ts`.
- [ ] Make `StorageRepo` implement `IBlockChangeNotifier`: listener registry +
      `onCollectionChange`; have `internalCommit` return the block's
      `collectionId`; aggregate and emit one event per collection after the lock
      critical section, only on `success: true`, only for newly-committed blocks;
      isolate throwing listeners.
- [ ] Expose `node.blockChangeNotifier = storageRepo` in `libp2p-node-base.ts`.
- [ ] Add optional `localChangeNotifier?: IBlockChangeNotifier` to
      `NetworkTransactor` options + delegating `onCollectionChange`.
- [ ] Leave a `// TODO: emit CollectionChangeEvent here once replicas persist`
      breadcrumb in `BlockTransferService.handlePush` (do not implement).
- [ ] Add db-p2p tests (see Key tests).
- [ ] `yarn build` for db-core + db-p2p; `yarn test` green for db-p2p (streamed).
