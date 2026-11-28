description: A SQL host can now turn on the fast way of storing a photo straight from a file, with one registration setting, instead of having to build and hand over its own networking node.
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`declaredBlobPaths`, `resolveBinding`), packages/quereus-plugin-optimystic/src/types.ts (`OptimysticOptions.blobPaths`, `ParsedOptimysticOptions.blobPaths`), packages/quereus-plugin-optimystic/src/plugin.ts (`register`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`resolveBlobBackend`, `createNetworkTransactor`), packages/quereus-plugin-optimystic/package.json (`quereus.settings`), packages/quereus-plugin-optimystic/README.md, docs/blobs.md, packages/quereus-plugin-optimystic/test/blob-paths-setting.spec.ts (new)
----

# Review: a SQL host can turn on blob file paths

`blob_paths` is now a plugin-level registration setting carried through a binding's options to both services a network's blobs can go through. Nothing about the two guarantees (`verify`, `trust`) changed; the plugin only asks for them now.

## What was built

- **`declaredBlobPaths(aux)`** in `optimystic-module.ts:684`-ish (beside `declaredStorageAllotment`), exported, returning `BlobPathMode | undefined`. `undefined`, `null` and `''` are unset; the three mode names pass through; anything else throws naming the setting and all three, reusing the existing `quotedKeyList` helper so the message reads `'off', 'verify' and 'trust'`.
- **Called twice, for two reasons** — from `resolveBinding` (which puts it on the options, and whose return `Pick<…>` gained `'blobPaths'`), and from `register` in `plugin.ts` purely so a bad spelling throws before anything is built. Comment at the `register` site says why both.
- **`blobPaths?: BlobPathMode`** is a TOP-LEVEL field on `OptimysticOptions` (documented) and on `ParsedOptimysticOptions`, not under `libp2pOptions`, because the single-machine arm has no node.
- **`resolveBlobBackend`** now builds the `SingleMachineBlobService` init explicitly — `pieces`, `kv`, `paths: options.blobPaths` — over `storageFor(options)` with memory fallbacks per field, rather than passing a whole `NodeStorage` through as the init. That is also what leaves room for `ownWriteRoom` at this call (backlog `feat-a-local-only-host-measures-nothing-it-stores`).
- **`createNetworkTransactor`** passes `blobs: { paths: options.blobPaths }` unconditionally, with a comment on why that is equivalent to passing no `blobs` at all when unset (every sub-option the node reads has its own `??` default) and a "do not fix into a conditional spread" note.
- **Docs**: the `blob_paths` row in `package.json`'s `quereus.settings` (`type: "select"`, `["", "off", "verify", "trust"]`); the README *Plugin-Level Configuration* row before `cost_profile`; the README large-values bullet now points at the setting; docs/blobs.md §SQL's path bullet now lists the three ways a network offers path access; the status paragraph now says the registration turns it on. The `trust` tradeoff is stated in exactly one place (docs/blobs.md §Putting and reading by file path) and only cross-referenced elsewhere.

## Commands run

- `yarn build` in `packages/quereus-plugin-optimystic` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/blob-paths-setting.spec.ts` — 5 passing.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/local-transactor-storage.spec.ts test/blob-pins-online.spec.ts test/blob-pins-unstaged.spec.ts test/blobref-column.spec.ts` — 29 passing (the specs over `resolveBlobBackend`/`storageFor` and the pin lifecycle a path put shares).
- `yarn typecheck` in the package, and `yarn typecheck` from the root — clean.
- `yarn lint:docs` — 49 documents, all citations/links resolve. `yarn lint:deps` — clean.

Per `tickets/rules/testing.md` the package's full suite was NOT run here; that is this stage's.

## Tests added, and what each verifies

`packages/quereus-plugin-optimystic/test/blob-paths-setting.spec.ts`:

- three cases over `declaredBlobPaths` — unset/`null`/`''` → `undefined`; each of `'off'`/`'verify'`/`'trust'` → itself; `'Verify'`, `'on'` and `3` each throw with a message naming the setting and all three modes. Pins the refusal docs/blobs.md and the README promise, on a parser with real branching.
- two cases over `factory.getBlobBackend(options)` with a hand-built `ParsedOptimysticOptions`: `blobPaths: 'verify'` over a `storageFactory` whose `pieces` is a `MemoryPieceStore` subclass carrying stub `importFile`/`exportFile` members answers `service.paths?.mode === 'verify'`; `blobPaths` left off answers `service.paths === undefined`. This is the headline claim and it crosses the plugin→db-p2p seam no type settles. No filesystem involved — `offersFiles` is a duck-type check, so the stubs throw if ever called.

Nothing else earns one: the `createLibp2pNode` field is settled by the node's option type, and a path put's pin rules are `put`'s own shared `SqlBlobService.pinnedPut`.

## What to check, and the honest gaps

Things settled only by inspection, which is where a reviewer should look hardest:

- **The node arm is untested.** `blobs: { paths: options.blobPaths }` reaching `createLibp2pNode` was verified by reading `libp2p-node-base.ts:1454`-`:1534` (each `blobs` sub-option has its own `??` default, so an object carrying only `paths: undefined` is indistinguishable from no option) and by the type. No spec builds a real libp2p node with the setting on — the package's node-storage spec is `*.integration.spec.ts` and gated behind `OPTIMYSTIC_INTEGRATION=1`. If a reviewer thinks the forwarding deserves a case, the integration spec is where it would go.
- **`ParsedOptimysticOptions.blobPaths` is optional**, so an options object assembled field by field elsewhere would silently drop it rather than fail to compile. Checked that both `resolveBinding` call sites spread (`optimystic-module.ts:6580`, `:7065`) and that no path reaching `getBlobBackend` assembles options by hand — but that is a read, not a guarantee; it is the same shape of hazard as backlog `debt-a-networks-storage-is-taken-from-one-collections-options`.
- **No `blobPaths` was added to the `createSchemaManager` fingerprint**, deliberately: the mode changes nothing about a catalog tree and adding it would split the catalog cache for no reason. Worth a reviewer confirming that reading.
- **`SqlBlobService` is untouched**, as intended — `pathAccess()` reads `backend.service.paths`, which simply becomes an object.
- **A mode a store cannot honour** still answers `undefined` and throws nothing; that behaviour is `LocalBlobService.pathAccess`'s and was not changed or pre-empted in the plugin. The unset-versus-`'off'` equivalence rests on `init.paths ?? 'off'` in `LocalBlobService`.
- **`declaredBlobPaths` is a forward reference to `quotedKeyList`** (declared lower in the file). Function declarations hoist, so this is fine at runtime and type-checks, but it is worth a glance if the file is ever split.
