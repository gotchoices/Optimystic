description: The node the Quereus plugin builds for a `network` transactor can now be given the storage allotment every other node takes, so a host that lets the plugin build its node can say how much of the machine's disk the network may use, and the node fills, sheds and refuses against that figure.
architecture: packages/db-p2p/docs/storage.md#9-a-nodes-allotment-and-what-counts-against-it
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`resolveBinding`, `declaredCohortTopic`, `declaredLinkRoundTripMs`), packages/quereus-plugin-optimystic/src/types.ts (`LibP2PNodeOptions`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`createNetworkTransactor`), packages/quereus-plugin-optimystic/README.md (the plugin-level settings table), packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.storageAllotment`, `assertStorageAllotmentBytes`, `resolveStoragePressureThresholds`), .release-notes.pending.md (`# v1.30.0`)
----

# The node the plugin builds takes a storage allotment

## Why

v1.30.0 makes every node measure what it stores against one allotment its operator sets (`NodeOptions.storageAllotment` in `packages/db-p2p/src/libp2p-node-base.ts`), and act on it as it fills: shrink the read cache, hand ranges to other machines, delete what it handed over, and at the top refuse new data. This came from Sereus #67: an operator who gives a storage node a fixed share of a disk needs every part of the system to count against that one figure.

The Quereus plugin builds its own node for a `network` transactor (`CollectionFactory.createNetworkTransactor` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`), and that call passes no `storageAllotment`, and the plugin offers no setting for one. So a host that lets the plugin build its node cannot give it an allotment at all. On a backend that reports free space (file, IndexedDB) the node then measures against the whole free disk; on one that does not (SQLite on NativeScript, LevelDB on React Native, memory) it cannot tell how full it is, logs a `WARN:` and never sheds or refuses — and its advertised ring info omits `capacity`, which a v1.29.1 peer's ring statistics reject (the *Upgrading a group of machines* section of the v1.30.0 notes tells such hosts to set the allotment, which a plugin-built node currently cannot). The only way out today is for the host to build the node itself and register it with `CollectionFactory.registerLibp2pNode`, which is a lot to ask for one number.

## What should be true

A plugin-level setting, configured the way `link_round_trip_ms` and `cohort_topic` already are (read in `resolveBinding` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`, carried on `LibP2PNodeOptions`, passed by `createNetworkTransactor` to `createLibp2pNode`), gives the node the plugin builds its `storageAllotment`. Proposed shape, to be confirmed or improved at plan time:

- `storage_allotment`: an object passed through as the node's `storageAllotment` — `bytes` and the optional `thresholds` — mirroring how `cohort_topic` passes the node's `cohortTopic` object. Plugin-level only, not a per-table `USING` argument, for the reason the other two give: it configures the node, which every table on one network and port shares.
- A malformed value is refused when the option is read, with a message naming the setting, as `declaredCohortTopic` and `declaredLinkRoundTripMs` do; the node's own validation (`assertStorageAllotmentBytes`, `resolveStoragePressureThresholds`) stays the authority on the numbers, so the plugin checks shape and lets the node check ranges rather than duplicating its rules.
- It has no effect on a node the host registered (that node already took its own options), and the README says so, as it does for `cohort_topic`.
- Unset keeps today's behaviour exactly.

## Things to decide or get right

- **One node, many tables.** The node is built once per network key and shared; a second table on the same network cannot give it a different allotment. Say what happens when two `register()` calls or table declarations disagree, consistent with what the existing plugin-level node settings already do (they are plugin-level precisely to avoid this; confirm that holds).
- **The `local` transactor.** It uses the `storageFactory` block store with no node and so no storage account at all. Whether a `local`-only host needs an allotment is out of scope here unless it falls out for free; if it is a real gap, park it in `backlog/` with a `feat-` ticket rather than growing this one.
- **Docs.** Add the row to the plugin-level settings table in `packages/quereus-plugin-optimystic/README.md`, and update the v1.30.0 section of `.release-notes.pending.md`: its *The Quereus plugin takes one storage setting per network* section currently ends "The node the plugin builds takes no allotment; a host that needs one builds the node and registers it with `CollectionFactory.registerLibp2pNode`." — replace that sentence with the new setting, and make the *Upgrading a group of machines* advice name it.
- **Tests.** One spec that a plugin-built node given the setting reports the allotment (e.g. through `node.storageAccount` or the node's pressure reading), and one that a malformed value is refused with the setting's name. Nothing more is owed.
