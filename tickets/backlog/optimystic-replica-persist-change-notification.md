description: The churn replica-persist path (StorageRepo.saveReplicatedBlock → BlockStorage.saveReplica) lands a durable block but emits no CollectionChangeEvent, so a Database.watch consumer on the new owner is not woken by a churn-replicated block. Decide whether to emit on this distinct (non-commit-funnel) origin and implement.
prereq: optimystic-churn-rereplication-persist-handlepush
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-core/src/transactor/change-notifier.ts
----

# Emit CollectionChangeEvent on the replica-persist landing path

## Problem

Per-collection change notification (`optimystic-block-change-notification`) originates
events at the `StorageRepo.commit` funnel: `internalCommit` reports the affected
`CollectionId` and `commit` fires one `CollectionChangeEvent` per distinct collection.
That is the **only** origin today.

The churn re-replication landing path is a *distinct* origin. A block arrives via
`BlockTransferService.handlePush` → `StorageRepo.saveReplicatedBlock` →
`BlockStorage.saveReplica`, which advances `latest` and makes the block servable
**without going through `commit`**. So no `CollectionChangeEvent` is emitted:

- a reactive consumer (`Database.watch` via the Quereus vtab bridge,
  `NetworkTransactor.localChangeNotifier`) subscribed on the new owner is **not woken**
  when that node gains a block by churn replication.

This was previously flagged by an inline `// TODO: emit CollectionChangeEvent here once
replicas persist` in `handlePush`. That TODO was removed when persistence landed
(`optimystic-churn-rereplication-persist-handlepush`) in favor of this tracked ticket,
which also gives a home to the "push/replication-path notification" reference in
`optimystic-network-reactive-watch-integration-test`.

## Design questions to resolve first

This is a design call, not a mechanical add:

- **Should a replica-persist even emit a change event?** A churn replica is the *same*
  committed data arriving from elsewhere, not a new logical mutation. Emitting may be
  correct for "this node can now serve collection X" wake semantics, or may be noise /
  double-fire if the authoring node already notified its own consumers. Define the
  intended consumer contract.
- **Monotonic no-op case.** `saveReplica` is a no-op when an equal-or-newer revision is
  already held. An event must NOT fire in that case (nothing changed locally).
- **Where to originate.** `saveReplica` returns the effective `ActionRev` and knows the
  block (hence `header.collectionId`); `StorageRepo.saveReplicatedBlock` is the natural
  emit point (it already owns the `changeListeners` registry and `emitCollectionChanges`).
  Emit only when `saveReplica` actually advanced `latest`.

## Expected behavior / requirements

- When (and only when) a replica-persist genuinely advances local state for a block,
  fire a `CollectionChangeEvent { collectionId, blockIds, actionId, rev }` for the
  block's collection, reusing the existing `StorageRepo` listener registry and
  fire-and-forget / listener-isolation semantics.
- No event on the monotonic-guard no-op path.
- Keep the same success-only, post-write ordering guarantees the commit path uses.
- Add coverage: a `saveReplicatedBlock` of a fresh block fires exactly one event for
  its collection; a re-push (idempotent / older rev) fires none.

## Out of scope

- The end-to-end multi-node integration proof is tracked by
  `optimystic-network-reactive-watch-integration-test`.
