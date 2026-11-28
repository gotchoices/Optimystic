description: An application using the database through SQL can ask for the fast way of storing a photo straight from a file, but there is no setting that turns it on — so unless the application builds and hands over its own networking node, the answer is always "not available here". Add the setting.
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`resolveBinding`, the `declared*` setting parsers), packages/quereus-plugin-optimystic/src/types.ts (`OptimysticOptions`, `ParsedOptimysticOptions`), packages/quereus-plugin-optimystic/src/plugin.ts (`register`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`resolveBlobBackend`, the `createLibp2pNode` call in `createNetworkTransactor`), packages/db-p2p/src/blob/single-machine-blob-service.ts (`SingleMachineBlobServiceInit.paths`, read only), packages/db-p2p/src/blob/local-blob-service.ts (`BlobPathMode`, `LocalBlobService.pathAccess`, read only), packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.blobs`, read only), packages/quereus-plugin-optimystic/package.json (`quereus.settings`), packages/quereus-plugin-optimystic/README.md (*Plugin-Level Configuration*, the large-values bullet), docs/blobs.md (status paragraph, §SQL), packages/quereus-plugin-optimystic/test/blob-paths-setting.spec.ts (new)
difficulty: easy
----

# A SQL host can turn on blob file paths

Putting and reading a blob by file path is built everywhere but the one place a SQL host can reach it. `SqlBlobService.pathAccess()` answers the `putFile`/`readToFile` pair when the network's blob backend offers path access, and `undefined` when it does not — and nothing the plugin builds itself ever asks for it:

- a `network` transactor whose node the **host** built and registered through `CollectionFactory.registerLibp2pNode` carries whatever that host asked the node for, so this already works;
- a `network` transactor whose node the **plugin** builds passes no `blobs` option to `createLibp2pNode` at all, so the node's `paths` stays at its default `'off'`;
- every other transactor (`local`, `test`, `mesh-test`, a custom one) gets a `SingleMachineBlobService` built with `{ pieces, kv }` and no `paths`, which is `'off'` for the same reason. This is the arm that matters most: a phone with the database on local storage and no mesh is the plain configuration, and today it is the one that can never see the capability.

The work is one plugin-level registration setting, `blob_paths`, carried through the options a binding is resolved into and handed to both places that build a blob service. The two guarantees `verify` and `trust` give, and exactly what `trust` gives up, are specified in docs/blobs.md §[Putting and reading by file path](../../docs/blobs.md#putting-and-reading-by-file-path) and do not change here — this ticket only lets the plugin ask for them.

## The setting

`blob_paths`, a plugin-level registration setting only — not a per-table `using optimystic(...)` argument, for the reason `link_round_trip_ms` and `storage_allotment` are plugin-level: it configures one network's blob service, which every table on that transactor key shares, so two tables must not be able to disagree about it. Nothing is read from `args`, so `SESSION_BINDING_VTAB_ARGS` in `src/schema/table-identity.ts` is unchanged.

Accepted values are exactly the three `BlobPathMode` names, plus unset:

| declared | meaning |
|---|---|
| absent, `null`, `''` | unset — no path access, and every byte of behaviour as it is today |
| `'off'` | the same, said explicitly |
| `'verify'` | hash every leaf the piece store imported, here, after the store named it |
| `'trust'` | take the store's piece ids as given |

`null` and `''` count as unset for the reason they do for `cost_profile` and `blob_unstaged_holding_ms`: a plugin loader's settings form sends an untouched field as `''`. Anything else — `'Verify'`, `'on'`, a number — throws, naming the option and the three accepted values, because a host that asked for path access and got silence cannot otherwise tell which of the three reasons it got silence for.

## Where the value goes

Add a parser beside the other plugin-level `declared*` parsers in `optimystic-module.ts`:

```ts
/** The plugin-level `blob_paths`, or `undefined` when unset. */
export function declaredBlobPaths(aux: Readonly<Record<string, unknown>>): BlobPathMode | undefined;
```

`BlobPathMode` (`'off' | 'verify' | 'trust'`) is already exported from `@optimystic/db-p2p` — `src/index.ts` re-exports all of `blob/local-blob-service.js` — so import the type rather than restating the union, which keeps a value the plugin accepts and a value the node accepts from drifting.

It is **pure**, and called in two places for two different reasons:

- `register` in `plugin.ts`, beside `parseUnstagedHoldingMs`, purely so a bad spelling throws before anything is built. `auxData` is the registration `config` object itself (`plugin.ts:150`), so the value `register` validated is the value every later resolution reads — the same arrangement `defaultTransactorOf` already has, called in `register` for the cost profile and in `resolveBinding` for the binding.
- `resolveBinding` in `optimystic-module.ts`, which is what puts it on the options.

Then the value rides the options to its two consumers:

- **`ParsedOptimysticOptions.blobPaths?: BlobPathMode`** — a TOP-LEVEL field, like `storageFactory` and unlike `libp2pOptions.*`, because it is read by both the single-machine arm (which has no libp2p node at all) and the node arm. Add it to `resolveBinding`'s return `Pick<…>` and to the public `OptimysticOptions` with the doc comment the other blob-touching fields have. Both `resolveBinding` call sites spread the result (`optimystic-module.ts:6555` and `:7040`), so it reaches a table's binding, `defaultBindingOptions` (which is what `plugin.blobs` resolves through) and the catalog's options without further plumbing — **do not** assemble options field by field anywhere; that is exactly how the blob half of the storage options was once dropped (the NOTE in `createSchemaManager`, and backlog `debt-a-networks-storage-is-taken-from-one-collections-options`).
- **`resolveBlobBackend`'s single-machine arm** in `collection-factory.ts:558`: `SingleMachineBlobServiceInit` already takes a `paths` field, so name `pieces`, `kv` and `paths` explicitly rather than passing the whole `NodeStorage` through as the init. Shaping it that way also leaves room for the second init field backlog `feat-a-local-only-host-measures-nothing-it-stores` wants at this same call (`ownWriteRoom`).
- **the `createLibp2pNode` call** in `createNetworkTransactor` (`collection-factory.ts:695`): add `blobs: { paths: options.blobPaths }`. Unconditional is correct and simplest — every other `blobs` sub-option the node reads has its own `??` default off `options.blobs?.x` (`libp2p-node-base.ts:1454`–`:1534`), so a `blobs` object carrying only `paths`, and `paths: undefined` at that, is indistinguishable from no `blobs` option at all. Say so in a comment so a later reader does not "fix" it into a conditional spread.

## What a host then sees, and what it does not

Nothing new is logged, and nothing new decides whether the capability exists. `LocalBlobService` already resolves `paths` from the mode and the store together, and already logs the one line that answers "why is path access undefined": `blob:paths mode=… available=…`, under db-p2p's `blob:store` namespace (docs/debugging.md). An honest `undefined` over a store that cannot reach files is therefore the behaviour to KEEP, not to change — a mode the store cannot honour must never fail a registration or a put.

Which networks offer path access after this lands:

- a `local`, `test`, `mesh-test` or custom transactor, when `blob_paths` names `verify` or `trust` **and** the `pieces` of the host's `storageFactory` offers file access (`offersFiles`). With no `storageFactory` the pieces are a `MemoryPieceStore`, which offers none, so the answer stays `undefined` and the log line says `available=false`;
- a `network` transactor whose node the **plugin** builds, on the same two conditions — the node's storage IS that same `storageFactory` value;
- a `network` transactor whose node the **host** registered: unchanged, and `blob_paths` has no effect on it, exactly as the README already says of `cohort_topic` and `storage_allotment`. A registered node that carries no blob service at all falls through to the single-machine arm, where `blob_paths` does apply.

A path put is pinned, recorded and released exactly as `put` is. That needs no work and no test: both go through one method in `SqlBlobService` (`pinnedPut`), which is why they cannot drift.

## Edge cases & interactions

Each case, and how it is settled — most by inspection, because the change is one validated string reaching two construction sites.

- **A mode the store cannot honour** (`blob_paths: 'verify'` over a browser store, a `MemoryPieceStore`, any store without `importFile`/`exportFile`). `paths` stays `undefined`, one `blob:paths … available=false` line is logged, nothing throws. Existing behaviour in `LocalBlobService.pathAccess`, unchanged — verify by inspection that no new branch in the plugin pre-empts it.
- **An unknown spelling.** Refused by `register()`, before any table, node or store exists. **Test** (below).
- **Unset versus explicit `'off'`.** Unset passes `undefined`; `'off'` passes `'off'`; `LocalBlobService` applies `init.paths ?? 'off'`, so the two are identical downstream. By inspection.
- **A host-registered node.** `resolveBlobBackend` returns `nodeBlobs` without consulting `options.blobPaths`, so the setting is inert there. By inspection; stated in the README row.
- **Two transactor keys that resolve to one node key.** A node is cached under `<networkName>:<port>` and keeps the options of whichever transactor key built it, while a blob backend is keyed `<transactor>:<keyNetwork>`. `blob_paths` is plugin-level, so every binding of one `register()` carries the same value and no divergence is possible — the same argument that makes `link_round_trip_ms` safe there. Not a new instance of backlog `debt-a-networks-storage-is-taken-from-one-collections-options`; by inspection.
- **First-options-win memoization.** `CollectionFactory.transactorOptions`, `storages` and `blobBackends` all keep the FIRST options seen per key. Same argument: one plugin-level value across every binding. By inspection — and it is the reason this must not become a per-table argument.
- **The catalog path.** `createSchemaManager`'s `schemaOptions` spreads `tableOptions`, and `openIndexTree` spreads likewise, so `blobPaths` travels on the options a `hydrate` registers for a key before any table opens. Confirm by inspection that no options object is built field by field on any path that reaches `getBlobBackend`.
- **The SchemaManager fingerprint** (`createSchemaManager`) must NOT gain `blobPaths`: it keys catalog trees, and the blob path mode changes nothing about a catalog tree. Adding it would split the catalog cache for no reason. By inspection.
- **`trust` and what it gives up.** Unchanged and not restated here; the guarantee wording lives in docs/blobs.md §Putting and reading by file path. By inspection of the doc edits — the README and docs changes must not invent a second statement of the rule.
- **The node arm's `blobs` option.** Adding `blobs: { paths: undefined }` must change nothing else about a node built with the setting unset — `hold`, `copy.enabled`, `cacheBudgetBytes`, `reclaimGraceMs` and `digest` each default off their own `??`. By inspection of `libp2p-node-base.ts:1454`–`:1534`.
- **`SqlBlobService` needs no change at all.** `pathAccess()` reads `backend.service.paths`; a backend built with the mode on simply answers an object. Confirm by inspection that nothing in `sql-blob-service.ts` is edited.

## Tests

Two cases, one new file `packages/quereus-plugin-optimystic/test/blob-paths-setting.spec.ts`, modelled on `test/storage-allotment-setting.spec.ts` (which imports its parser from `../src/optimystic-module.js`) and on `test/local-transactor-storage.spec.ts` (which hands `factory.getBlobBackend` a hand-built `ParsedOptimysticOptions`). Nothing else here earns a test: the forwarding into `createLibp2pNode` is one literal field settled by the type and by inspection, and the pin rules are shared code.

- **`declaredBlobPaths`, one case per branch.** `{}`, `{ blob_paths: null }` and `{ blob_paths: '' }` → `undefined`; `'off'`, `'verify'` and `'trust'` → themselves; `'Verify'`, `'on'` and `3` each throw with a message naming `blob_paths` and the three accepted values. This pins the refusal docs/blobs.md and the README promise, on a parser with real branching.
- **The mode reaches the single-machine service.** `factory.getBlobBackend(options)` with `blobPaths: 'verify'` over a `storageFactory` whose `pieces` is a `MemoryPieceStore` given stub `importFile`/`exportFile` members — `offersFiles` is a duck-type check, so the stubs need not do anything — answers a backend whose `service.paths?.mode` is `'verify'`; the same options with `blobPaths` left off answer `service.paths === undefined`. This is the ticket's headline claim and it crosses the plugin→db-p2p seam, which no type settles. No filesystem and no `@optimystic/db-p2p-storage-fs` needed.

Note for the runner: the plugin's specs import from `../dist/plugin.js`, so the package must be built before its suite runs. Per `tickets/rules/testing.md`, run at most one spec file here; the full suite is the review stage's.

## TODO

- Add `declaredBlobPaths(aux)` to `optimystic-module.ts` beside `declaredStorageAllotment`, exported, typed `BlobPathMode | undefined`, importing `BlobPathMode` from `@optimystic/db-p2p`. Treat `undefined`, `null` and `''` as unset; refuse anything outside the three names with a message naming `blob_paths` and all three.
- Call it from `resolveBinding` and add `blobPaths` to that function's return `Pick<…>`.
- Call it from `register` in `plugin.ts`, beside `parseUnstagedHoldingMs`, so a bad spelling throws before anything is built; comment why it is called in both places.
- Add `blobPaths?: BlobPathMode` to `ParsedOptimysticOptions` and a documented `blobPaths` to `OptimysticOptions` in `src/types.ts`, saying it is plugin-level only, which two services read it, and that it is inert on a host-registered node.
- In `resolveBlobBackend`, build the `SingleMachineBlobService` init explicitly — `pieces`, `kv`, `paths: options.blobPaths` — over `storageFor(options)` or the memory pair.
- In `createNetworkTransactor`, add `blobs: { paths: options.blobPaths }` to the `createLibp2pNode` call, with the comment on why unconditional is equivalent to passing nothing.
- Add the `blob_paths` row to `quereus.settings` in `packages/quereus-plugin-optimystic/package.json` — `type: "select"`, options `["", "off", "verify", "trust"]`, `default: ""`, a help line saying what it turns on and that it needs a store that can reach files.
- Add the `blob_paths` row to the *Plugin-Level Configuration* table in the package README, after `blob_unstaged_holding_ms`: the three values and what each checks, that unset and `''` mean off, that it is refused by `register`, that it needs a `storageFactory` whose `pieces` can reach files or the answer stays `undefined` (and says so once in the `blob:paths` log line), and that it has no effect on a node you registered yourself.
- Update the large-values bullet in the README (the sentence beginning "Today the capability reaches SQL only through a libp2p node you built yourself") to point at the setting instead.
- Update docs/blobs.md §SQL's *Putting and reading by file path* bullet: replace "which today means a node the HOST built and registered, since the plugin passes no such setting…" with the three ways a network offers it, and drop the backlog slug.
- Update the status paragraph at the top of docs/blobs.md: drop "which today answers an object only for a network whose node the host built and registered with the setting on, since nothing the plugin builds itself turns it on (backlog `feat-a-sql-host-cannot-turn-on-blob-file-paths`)" and say instead that the registration's `blob_paths` turns it on for the node the plugin builds and for the single-machine service every other transactor gets.
- Add `test/blob-paths-setting.spec.ts` with the two cases above.
- Build the package and run that one spec file; type-check the touched packages.
