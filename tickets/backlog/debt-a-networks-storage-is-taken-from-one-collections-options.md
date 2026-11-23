description: Where a network keeps its data on this machine is read out of whichever table happened to open first, so a code path that builds its own settings object and forgets one storage setting silently sends that whole network's blobs to a throwaway in-memory store. It has already happened once.
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: medium
tradeoffs: Both places in the plugin that build a settings object by hand now copy an existing one instead, and a paragraph on the field they are recorded in says why they must — so the hole is closed today and this is a refactor of a type that nothing is currently misusing; a maintainer may reasonably wait for a third such place to appear.
----

# A network's storage is taken from one collection's options

## What happens now

`ParsedOptimysticOptions` (`packages/quereus-plugin-optimystic/src/types.ts`) is one flat object carrying two unrelated kinds of thing:

- **Which collection** is being opened — `collectionUri`, `cache`, `encoding`.
- **Which network it is on and where that network's data lives on this machine** — `transactor`, `keyNetwork`, `libp2p`, `libp2pOptions`, `storageFactory`.

`CollectionFactory.getOrCreateTransactor` records the FIRST such object it sees per transactor key (the `transactorOptions` map) and that record is thereafter the whole truth about that network: `knownBlobBackends()` and `blobBackendForKey()` build the network's blob store from it, long after and far away from whichever table happened to open first. So a caller that builds an options object field by field, and leaves out a field the collection it is opening has no use for, permanently misconfigures the network — for every later caller, including ones that pass complete options.

That is not hypothetical. Reviewing `feat-blob-pins-reconcile-after-a-restart` (commit `ticket(implement): feat-blob-pins-reconcile-after-a-restart`) found it live: the schema catalog's options were assembled by hand and omitted the blob half of the storage options — two fields then, one `storageFactory` since — and because a restarted process reads the catalog before it opens any table, the catalog's reduced options were the record. Every blob store the process then built for that network was over fresh in-memory piece and record stores, so the process found none of its own blob pins and `plugin.blobs` answered as if the machine held nothing — no error, no log line, just wrong answers from `stat`, `pinsOf` and `listPins` for the life of the process.

## Why a fix at this level

Both hand-built options objects in the plugin now spread an existing object and override what differs, and the `transactorOptions` field carries a paragraph stating what callers owe it. That is a prose contract over a representation that invites the mistake: nothing in the type, the compiler or a lint rule distinguishes "a field this collection does not need" from "a field this network cannot do without", and the failure is silent and permanent rather than loud and local. The next hand-built options object — a new internal tree, a host calling `getOrCreateTransactor` directly — re-opens it.

Holding a network's configuration apart from any collection's options would make the bad state unrepresentable: a collection's options would name a network, not carry its storage, and there would be nothing to drop. Roughly:

```ts
/** Where one network lives and where this machine keeps its data for it. Fixed per transactor key. */
interface NetworkOptions {
  transactor: 'network' | 'test' | 'mesh-test' | string;
  keyNetwork: 'libp2p' | 'test' | string;
  libp2p?: Libp2p;
  libp2pOptions: LibP2PNodeOptions;
  storageFactory?: () => NodeStorage;
}

/** Which collection to open, on which network. */
interface CollectionOptions {
  collectionUri: string;
  cache: boolean;
  encoding: 'json' | 'msgpack';
  network: NetworkOptions;
}
```

What matters is the shape, not these names: a caller opening a second collection on the same network passes the `network` it already has through untouched, so the only way to reduce a network's configuration is to construct a `NetworkOptions` deliberately — which is a thing a reader can see and a reviewer can question.

A cheaper alternative, if that refactor is judged too wide: have `getOrCreateTransactor` refuse — or at least log loudly — when options for a key it already knows carry a different storage configuration from the record, so the next occurrence is noisy instead of silent. That does not close the class (the reduced options still come first in the ordering that actually bit), but it turns a wrong answer into a visible one.

## What would confirm the fix

A caller cannot express a collection on a known network without its storage configuration, so no new code path can drop one; the behaviour this ticket describes has no way to arise. The blob-pin specs (`packages/quereus-plugin-optimystic/test/blob-pins-*.spec.ts`) exercise the path that caught it — they restart a process over shared stores and read back the pins the previous one wrote — and must keep passing unchanged.

## Arm: the droppable storage fields are down to one (2026-11-23)

`the-sql-plugin-takes-one-storage-setting-per-network` has landed; it replaced `rawStorageFactory` and `blobStorageFactory` with a single `storageFactory` returning the one value db-p2p now takes for a node's whole storage, and resolves it once per transactor key into a map on `CollectionFactory` so that every consumer of a network's storage reads one value. The factory it calls is still the one on whichever options object arrived first for that key, so the ordering this ticket is about is unchanged.

That narrows this ticket without closing it. What it fixed: two independently droppable fields became one, the two can no longer disagree with each other, and every consumer of a network's storage — the `local` transactor's block store, the single-machine blob service, and the node the plugin builds itself — reads the one resolved value. What it leaves: `ParsedOptimysticOptions` still carries a network's storage inside a collection's options, so a hand-built options object can still reduce a known network's configuration, and first-options-win still decides. The `NetworkOptions`/`CollectionOptions` split above is still the fix that makes that unrepresentable, and the remaining hole is now one field in one place rather than two.

Folding the split into that ticket was considered and rejected: it spans the aux-option reader, the catalog opener, `openIndexTree`, `getOrCreateTransactor`, `getTransactorKey`, `knownBlobBackends`, `blobBackendForKey` and the hand-built options object in roughly twenty specs, with its own failure mode (a mis-keyed network silently sharing or splitting state) — a separate agent run, and pairing the two risked both.

One more instance of the same class to fold in when this is taken up: the storage map is keyed by transactor key (`<transactor>:<keyNetwork>`) while the node is keyed by node key (`<networkName>:<port>`), so two transactor keys resolving to one node key leave the node holding whichever key's storage built it — exactly as it holds whichever key's `libp2pOptions` built it today.
