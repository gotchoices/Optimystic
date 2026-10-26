description: Optionally save queued offline transactions to the device's storage, so a change the application was told is committed survives the app being killed or the device restarting, and is never sent to the network twice.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#persistence
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p/src/storage/node-kv-namespaces.ts, packages/db-p2p/src/storage/memory-kv-store.ts, docs/offline-sync.md, packages/quereus-plugin-optimystic/README.md
difficulty: hard
----

Stage 5 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages).

## What is wanted

The `journal` registration option (an `IKVStore` or a factory; `MemoryKVStore` refused, a store without `flush` accepted — [§Registration](../../docs/offline-sync.md#registration)) and everything in [§Persistence](../../docs/offline-sync.md#persistence):

- One `JournaledEntry` record per entry under the `optimystic-offline/` prefix, with a database label, zero-padded sequence so a prefix listing is queue order. Actions, not transforms; no SQL text.
- The four write-ordering rules of [§Write ordering](../../docs/offline-sync.md#write-ordering): journal + flush before `commit` resolves (failure unseals and rolls back); `attempt` written + flushed before each send (the stage-3 hook); outcome record written before the entry record is deleted; `committedCollections` before consuming committed segments.
- Restore in `plugin.hydrate(db)` (after the catalog, before returning) and `plugin.offline.restore()`: initialize named tables, re-stage each segment's actions, seal; a guard refusal during restore fails the entry; a collection whose base blocks cannot be read keeps its entries journaled and restores them on that table's first successful read ([§Restore after a restart](../../docs/offline-sync.md#restore-after-a-restart)). An in-doubt record resumes under its recorded attempt identity.
- Retained outcomes for `outcomeRetentionMs` or until `acknowledge` ([§Outcomes after a restart](../../docs/offline-sync.md#outcomes-after-a-restart)).
- The prefix added to `NODE_KV_NAMESPACES` so a host can share its node's `kvStore` ([§Which store](../../docs/offline-sync.md#which-store)).
- `persisted` on `queued` statuses reflects the configuration.

The plugin package must not gain a dependency on a concrete storage package; it takes the `IKVStore` interface. The planner should confirm where `IKVStore` can be imported from without making the plugin depend on more of db-p2p than it already does.

## Edge cases the plan must cover

Crash after the network commit and before the journal delete (`MemoryBatchBackend({ deferSync: true })` + `powerLoss()` for both the journal and the node store): after restart the entry is reported committed and the log holds one entry for it. Crash after the local acknowledgement: restored by `hydrate`, visible before any network contact, drains on reconnect. Crash between writing `attempt` and sending. A journal record of an unknown version `v`. Two `Database`s sharing one store under different labels. Restore of an entry whose table was dropped while the app was down.

## Done when

Those scenarios pass, the README documents the option, and docs/offline-sync.md marks the stage implemented.
