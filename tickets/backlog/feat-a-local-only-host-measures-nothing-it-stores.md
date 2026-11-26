description: An application that keeps its data on one machine with no peer network has no way to say how much of the disk it may use, and nothing tells it how much it has used — so it finds out it is full when a write fails.
architecture: packages/db-p2p/docs/storage.md#9-a-nodes-allotment-and-what-counts-against-it
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`createLocalTransactor`, `resolveBlobBackend`), packages/db-p2p/src/blob/single-machine-blob-service.ts, packages/db-p2p/src/storage/storage-account.ts (`StorageAccount`, built today only by `createLibp2pNode`), packages/db-p2p/src/storage/storage-pressure.ts, packages/quereus-plugin-optimystic/README.md (the *Plugin-Level Configuration* table)
tradeoffs: A machine with no network holds only its own application's data on its own disk and has nowhere to hand anything to, so the disk's own failure is arguably the honest limit — and the useful half of an allotment there (refusing before the disk fills, and reporting how full it is) is a new measurement-and-refusal path in the plugin rather than a setting passed through, for a deployment shape nobody has reported trouble with.
----

# A local-only host measures nothing it stores

## What a host has today

Everything a node stores is measured against one allotment its operator sets, and the node acts on the figure as it fills: it shrinks its read cache, hands ranges to other machines, deletes what it handed over, and at the top refuses new data (`packages/db-p2p/docs/storage.md` §9 and §10). That whole mechanism belongs to a peer node — `StorageAccount` and `StoragePressure` are built by `createLibp2pNode` and reachable as `node.storageAccount` and `node.storagePressure`.

A host that runs the Quereus plugin with `default_transactor: 'local'` has no node. Its blocks go to the `blocks` of its `storageFactory` through `BlockStorage`, and its large values go to a `SingleMachineBlobService` over the same value's `pieces` and `kv`. Neither is measured, so:

- There is no setting that says how much of the machine the database may use, and no equivalent of the plugin-level `storage_allotment` that a `network` host now has (`feat-the-node-the-plugin-builds-takes-a-storage-allotment`).
- Nothing reports how much has been used. A `network` host can read `node.storageAccount.capacity()` and `breakdown()`; a `local` host has no object to ask.
- Nothing refuses a write before the disk is full. A `network` node refuses a replica, an announced blob and a pend above its `refuseAbove` threshold, and `LocalBlobService.put`/`.pin` refuse at the whole allotment with `NodeOutOfSpaceError`; on a `local` host every write is attempted and the first failure comes from the platform, mid-write, with whatever that leaves behind.

So the shape of the gap is: the application learns it is out of room from a failed write rather than from a figure it set, and it cannot see the figure coming.

Two parts of the networked story do NOT apply here, and this ticket should not pretend they do. There is nowhere to shed to — a local host has no cohort and no ring — so none of the hand-over, ring-shift or released-block machinery is relevant. And a local host never caches a blob it read from somewhere else, because there is nowhere to read from: `SingleMachineBlobService` serves this machine's own pieces only, so the blob read cache the allotment caps on a node has no counterpart to cap.

## What should be true

An application that keeps its data on one machine can say how much of that machine the database may use, can ask how much it has used, and is refused new data before the disk refuses it — the same three answers a networked node gives its operator, minus the two that need a cohort.

Worth deciding when this is taken up, not assumed here:

- Whether the figure is a new plugin-level setting or the same `storage_allotment` read on a `local` binding. The second is tidier for a host that changes transactor, and means one name in the README.
- Whether the measurement is `StorageAccount` reused over a `NodeStorage` with no node — it takes a `NodeStorage` and nothing else today, so this may be mostly wiring and a reading — or something smaller.
- What "refuse" means for SQL: a blob `put` already has `NodeOutOfSpaceError`, and a commit would need an error of its own and a decision about whether the offline queue holds the transaction or fails it.

## Why it is filed rather than fixed

It came out of planning `feat-the-node-the-plugin-builds-takes-a-storage-allotment`, which passes the networked node's allotment through the plugin. The local case is not a pass-through: there is no account, no reading and no refusal to pass anything to, so it is a feature rather than a setting, and bolting it onto that ticket would have doubled it.
