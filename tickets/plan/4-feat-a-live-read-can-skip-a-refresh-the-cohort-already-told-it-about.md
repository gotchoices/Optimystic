description: Every live query first asks the network whether its tables changed, even when this machine was just told of every change and nothing has arrived since. An app that polls a quiet table pays that network cost on every poll. Let a read skip the check for a short while when it already knows the table is current.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (live read arm ~line 1215 calls `Tree.update()`; `ensureChangeSubscription` already subscribes to local change events)
  - packages/db-core/src/collection/collection.ts (`Collection.update`)
  - packages/db-core/src/transactor/change-notifier.ts (`IBlockChangeNotifier.onCollectionChange`)
  - packages/db-p2p/src/storage/storage-repo.ts (`emitCollectionChanges` — fires on local commit, replica save from a cohort push, read promotion)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCoordinator` read routing, `shouldAllowSelfCoordination`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairWindowMs` lazy read-repair)
  - backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds.md (same refresh, opposite pressure)
tradeoffs: A read that skips the network check can return data that is up to one window stale if a change notification is lost, which weakens the "a live read sees the latest committed state" guarantee applications may rely on. The refresh-cost fix may already make the check cheap enough.
prereq: refresh-of-an-unchanged-collection-refetches-the-same-blocks
----
# A live read could skip a refresh the cohort already told it about

## Context

This is sereus's question 1: "must a live read refresh every tree from the network on every statement?" After `refresh-of-an-unchanged-collection-refetches-the-same-blocks`, an unchanged refresh should cost one or two block requests per tree. Two further steps could take it to zero.

## Option A: skip the refresh when change notifications show nothing new

`StorageRepo` already emits `onCollectionChange` when a commit lands locally, when a replica pushed by the cohort is saved, and when a read promotes a pending block. The Quereus module already subscribes (`ensureChangeSubscription`), but only to call `db.notifyExternalChange`.

Keep a per-collection "known current" mark. Set it after a successful refresh. Clear it on any `onCollectionChange` for that collection, including index collections. While the mark is set and younger than a window (for example `readRepairWindowMs`, 10 s), `Collection.update` returns without touching the network.

- **Risk:** a commit this node never stored locally produces no event. Examples: a node that is not a cohort member, or a push that was lost. The window bounds how long such a read can stay stale. Scope the skip to nodes that are cohort members of the collection's tail block, where every commit applies locally.

## Option B: route an unchanged refresh to the local copy

On sereus's joining machine, most refresh requests went to the other party even though the joiner holds the blocks. `findCoordinator(intent: 'read')` admits self only under `shouldAllowSelfCoordination` or when there are zero connections. A read from a node that is a cohort member and holds the block could be served locally, with the existing lazy read-repair (`/db-p2p/sync`, at most once per `readRepairWindowMs` per block) still catching lag. Why self was denied in sereus's run has not been confirmed. The prior analysis guessed that evidence of partition or shrinkage from a larger earlier network was the cause.

## Relation to the isolated-node ticket

`a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds` asks for the opposite failure mode of the same refresh: fall back to local data when the network cannot answer. Both should agree on one rule for when a live read may use local state without a network confirmation.
