description: An application using the database through SQL can now ask for the fast way of storing a photo straight from a file, but there is no setting that turns that fast way on, so unless the application builds and hands over its own networking node itself the answer is always "not available here".
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`resolveBlobBackend`, the `createLibp2pNode` call), packages/db-p2p/src/blob/single-machine-blob-service.ts, docs/blobs.md
difficulty: easy
tradeoffs: The one host this was built for (Sereus Chat, GitHub #69) builds its own libp2p node and registers it, which already works — so this closes a hole nobody is standing in yet, and adding a registration option means one more setting to validate, document and keep in agreement with the node option it forwards to.
----

# A SQL host cannot turn on blob file paths

## What a host can do today

`SqlBlobService.pathAccess()` (`packages/quereus-plugin-optimystic/src/optimystic-adapter/sql-blob-service.ts`) answers the `putFile`/`readToFile` pair of docs/blobs.md §[Putting and reading by file path](../../docs/blobs.md#putting-and-reading-by-file-path) when the network's backend offers path access, and `undefined` when it does not. Whether a backend offers it is decided entirely outside the plugin:

- **A `network` transactor whose node the HOST built** and handed over through `CollectionFactory.registerLibp2pNode` carries whatever that host asked for: a node built with `blobs: { paths: 'verify' }` over a piece store that can reach files has `node.blobs.paths`, and `pathAccess()` answers it. This works today and is how the React Native host this was built for reaches it.
- **A `network` transactor whose node the PLUGIN builds** does not: the `createLibp2pNode` call in `collection-factory.ts` passes `storage`, `port`, `networkName`, `bootstrapNodes` and a few others, and no `blobs` option at all — so `paths` stays at its default `off` whatever the host's piece store can do.
- **Every other transactor** (`local`, `test`, `mesh-test`, a custom one) gets a `SingleMachineBlobService` built with `{ pieces, kv }` and no `paths`, which leaves `paths` `off` for the same reason. This is the arm that matters most: a phone with the database on local storage and no mesh is the plain configuration, and it is the one that can never see the capability.

So a host that supplies a piece store able to cut and join files — `FilePieceStore` in `@optimystic/db-p2p-storage-fs` is one, and a React Native store is the other — gets `undefined` from `pathAccess()` unless it also builds its own node. Nothing is WRONG: the answer is honest, and the host-built-node route is real. What is missing is the setting.

## What a host should be able to say

One registration option, alongside `blob_unstaged_holding_ms` (which `SqlBlobPins` reads off the registration config), naming the mode the capability's three values already name: absent or `off` meaning no path forms at all, `verify` meaning hash each imported leaf here after the store names it, `trust` meaning take the store's ids. The two guarantees and exactly what `trust` gives up are specified in docs/blobs.md §Putting and reading by file path and do not change; this is only about the plugin being able to ask for them.

Where the value has to arrive:

- the single-machine arm of `resolveBlobBackend`, as `SingleMachineBlobService`'s own `paths` init field (it already takes one);
- the `blobs` option of the `createLibp2pNode` call in the same file, for a node the plugin builds.

A value the host asks for that its store cannot honour must stay honest rather than fail: the service already logs one `blob:paths` line carrying the mode asked for and whether the capability was there, and leaves `paths` undefined, which is the behaviour to keep. A mode spelling the parser does not know should be refused at registration, as `blob_unstaged_holding_ms` refuses a non-positive number, rather than silently read as `off` — a host that asked for path access and got silence has no way to tell which of the three reasons it was.

## Expected behaviour

- A registration that names the mode, over a storage factory whose `pieces` offers file access, makes `await plugin.blobs.pathAccess()` answer an object whose `mode` is the mode asked for, on a `local` transactor as much as on a plugin-built `network` one.
- A registration that names it over a store with no file access still answers `undefined`, and the one `blob:paths` line says the capability was not there.
- A registration that names nothing behaves exactly as today.
- A path put through it is pinned, recorded and released exactly as `put` is — which is already true by construction, since both go through one method in `SqlBlobService`.
- An unknown spelling fails the registration, naming the option and the three accepted values.
