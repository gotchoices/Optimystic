description: The SQL plugin now takes one setting for everything a network keeps on this machine, instead of two settings that could disagree and no setting at all for the node it builds itself — so that node's files can now outlive the process.
architecture: docs/blobs.md#sql, packages/db-p2p/docs/storage.md
files: packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/cost-profile.ts, packages/quereus-plugin-optimystic/test/storage-helpers.ts, packages/quereus-plugin-optimystic/test/local-transactor-storage.spec.ts, packages/quereus-plugin-optimystic/test/plugin-node-storage.integration.spec.ts, packages/quereus-plugin-optimystic/test/blob-pins-harness.ts, packages/quereus-plugin-optimystic/test/repro-issue8.mjs, packages/quereus-plugin-optimystic/README.md, docs/blobs.md, packages/db-p2p/docs/storage.md
----

# The SQL plugin takes one storage setting per network

## What landed

`OptimysticOptions.rawStorageFactory` (`() => IRawStorage`) and `OptimysticOptions.blobStorageFactory` (`() => { pieces, kv }`) are gone. In their place is one field, on `OptimysticOptions` and on `ParsedOptimysticOptions`:

```ts
storageFactory?: () => NodeStorage;   // NodeStorage from @optimystic/db-p2p: { blocks, kv, pieces }
```

It is read by the aux-option reader (`resolveBinding` in `optimystic-module.ts`) under the same `typeof === 'function'` guard, so it is still `register()`-only and cannot be carried by a `USING` clause. The schema-manager fingerprint folds `tableOptions.storageFactory ? '1' : '0'` where it folded the raw one.

`CollectionFactory` resolves it **once per transactor key** (`storageFor`) into a private map, `storages`, and all three consumers read from there:

- `createLocalTransactor` wraps `storageFor(options)?.blocks` in `withReadCache`, with the same lease-ownership rule as before.
- `resolveBlobBackend`'s single-machine arm passes the resolved value straight to `SingleMachineBlobService`, which reads `pieces` and `kv` off it.
- `createNetworkTransactor` passes it as `NodeOptions.storage` to its `createLibp2pNode` call. **This is the new capability**: the plugin's own node now keeps its blocks, blob pieces and blob records where the host says, so a pin survives a restart without the host building and registering a node by hand. The superseded `NOTE:` saying it could not is gone.

`storageFor` returns `NodeStorage | undefined` rather than manufacturing a memory default, deliberately: the node's missing-storage `node-wiring` `WARN:` tests the *presence of the option*, so a default built inside the plugin would have silenced it and made the memory case look intended. Each consumer therefore keeps its own memory fallback.

## Host usage

```ts
const storage = fileNodeStorage(dir);   // one set of stores per directory; you opened it, you close it
const plugin = register(db, { default_transactor: 'local', storageFactory: () => storage });
// ...
db.close();
await plugin.dispose();      // releases only the read-cache lease; closes no store
await storage.close();
```

A host that wants durable blobs over a throwaway block store — what `blobStorageFactory` alone used to express — builds `{ blocks: new MemoryRawStorage(), kv: durableKv, pieces: durablePieces }`. Nothing refuses any combination; the README names the mixtures that bite.

## Tests

| Test | What it verifies |
| --- | --- |
| `local-transactor-storage.spec.ts` — "routes pend + commit through the host-supplied block store" | Converted from the old `rawStorageFactory` assertion: a host's `blocks` store really is written through by the `local` transactor. |
| `local-transactor-storage.spec.ts` — "asks the factory once per transactor key, however many consumers resolve on it" | The one-set-per-location invariant: a *constructing* factory must not be asked twice for one network, or two sets of stores open over one directory, which breaks `FilePieceStore`. Exercises all three consumers. |
| `plugin-node-storage.integration.spec.ts` — "puts the blob's pieces in the host's store, through the node's own blob service" | Added in review. The ticket's headline capability: a `network` transactor's own node writes to host storage. Asserts both that the host's piece store received the put and that the resolved backend's service is a `NodeBlobService` — see the findings below for why one assertion alone would not discriminate. |

`test/blob-pins-*.spec.ts` remain the suite that matters most here: they open a plugin over shared stores, close it, open another, and read back the pins the first wrote. `blob-pins-harness.ts`'s `BlobPinStores` now holds one `NodeStorage` instead of a `MemoryRawStorage` plus a separate pieces-and-records pair, and every handle's `storageFactory` returns that same value — which is what still makes a second handle a restart rather than a fresh machine.

The roughly twenty `FileRawStorage(dir)` specs keep memory blob stores: a new helper, `test/storage-helpers.ts`, exports `blocksOnly(blocks)` returning `{ blocks, kv: new MemoryKVStore(), pieces: new MemoryPieceStore() }`, and every such site became `storageFactory: () => blocksOnly(new FileRawStorage(dir))` — behaviour-identical to what those specs ran on before.

## Review findings

Reviewed the implement diff (`ticket(implement): the-sql-plugin-takes-one-storage-setting-per-network`) before its handoff summary, then read `NodeStorage` and `NODE_KV_NAMESPACES`, `SingleMachineBlobService`/`LocalBlobService`, `fileNodeStorage`, `CollectionFactory`'s whole transactor/blob-backend/lifecycle surface, and every remaining occurrence of both retired option names across the repository's TypeScript, Markdown and `.mjs`.

**Fixed in this pass (three; one behavioural, two hygiene).**

- **A call site of the retired option was missed, and it fails silently.** `packages/quereus-plugin-optimystic/test/repro-issue8.mjs` still passed `rawStorageFactory: () => new KvRawStorage(driver)` in the *plugin's* `register` config for its `TRANSACTOR=local` arm. The plugin reads only `storageFactory` and no unknown top-level key is refused, so that arm had quietly fallen back to `MemoryRawStorage`: the harness exists to count driver calls below the read cache, and it would have counted zero of them for ever. Now passes `{ ...memoryNodeStorage(), blocks: new KvRawStorage(driver) }`, the same shape as the `network` arm's `NodeOptions.storage` above it. Verified by running it: `TRANSACTOR=local TABLES=2 INDEXES=1` reports 27 driver calls and a `quereus:local` read-cache entry over the host store. (`ticket(review): a-node-takes-all-its-storage-as-one-value` had already updated this file's *node* arm, which is why only the plugin arm was left stale.)
- **The ticket's one new capability had no shipped test.** Added `test/plugin-node-storage.integration.spec.ts`: register with `default_transactor: 'network'` and a `storageFactory`, `plugin.blobs.put` three bytes, then assert the host's `pieces` store lists one piece **and** that the resolved backend's service is a `NodeBlobService`. Both assertions are needed — the single-machine arm now reads the same `pieces`, so a plugin that fell through to it (node built without a blob service, or no node built) would satisfy the piece-count assertion on its own, which is the point the handoff made against calling this "wiring". It is an integration spec because every real-libp2p spec in this package is gated on `OPTIMYSTIC_INTEGRATION=1`; it runs in 65 ms. **Mutation-checked**: with `storage: this.storageFor(options)` removed from the `createLibp2pNode` call, the spec fails on the piece count (0 vs 1) and nothing else in the package does.
- **Source hygiene on the `storages` field.** Its documentation was a JSDoc block followed by a second, free-standing `//` block that repeated the dispose-lifetime point already made in the JSDoc. Merged into one JSDoc carrying both `NOTE:` tripwires, so the field has one comment and the greppable set stays greppable.

**Checked and correct, no action.**

- **Folding the blob records into the node's `kv` keeps them findable.** This was the change worth verifying, since `SingleMachineBlobService` now gets the node's key-value store rather than its own: it reaches that store through `LocalBlobService`, which writes under `BLOB_RECORD_KEY_PREFIX`, the same prefix the node writes and `NODE_KV_NAMESPACES` declares. So a host that moves one network from `local` to `network` over the same storage finds its blob records where it left them, and a file-backed store sharing the block directory still keeps them out of block listings.
- **The memo is not a second first-options-win race.** `storageFor` reads the *caller's* `options` while `transactorOptions` holds the key's first ones, which looks like the family of bug the class's own comment warns about. It cannot diverge today: `getOrCreateTransactor` records the options ahead of `createTransactor`, and every `storageFor` caller is either inside that first construction or past an awaited `getOrCreateTransactor`. Recorded as a tripwire rather than changed (below).
- **Read-cache leases over a reused `blocks` store are unchanged.** `clearCache()` clears `transactors` without releasing leases, so a rebuilt `local` transactor wraps the same `blocks` again and takes a second lease. That is exactly what happened before: a fresh `FileRawStorage` over one directory reports the same `getStoreIdentity()`, so the two landed on one shared cache under two leases either way, and `dispose()` releases every lease it collected.
- **Keeping the ~20 `FileRawStorage(dir)` specs on `blocksOnly` rather than converting them to `fileNodeStorage(dir)` is right, and `fileNodeStorage`'s own doc says so.** Several of those specs register two plugins over one directory to get two *independent* write groups, or a reopen that reads what the first flushed (`legacy-commit-atomicity`'s `createDbPlain`, `committed-read-isolation`, the three `concurrent-*-refusal` specs). `fileNodeStorage` counts holders and hands a second caller over one directory the *same* store instances with a shared write group — its doc comment explicitly directs a test needing two independent instances to construct the stores itself. Converting them would have made those assertions pass more easily while testing something else.
- **Nothing else in the repository names either retired option.** Every remaining `rawStorageFactory` hit is `MeshOptions.rawStorageFactory` (`packages/db-p2p/src/testing/mesh-harness.ts`), a different option taking a node index, used by `mesh-node-harness.ts`, `offline-restore.spec.ts`, `two-node-lagging-replica-multi-collection-commit.spec.ts`, `mid-ddl-crash.spec.ts` and `cold-apply-cost.spec.ts` — the last of which the implement ticket had listed as a plugin caller and was correctly left alone after reading it. `blobStorageFactory` has no occurrences at all. The one mention in `.release-notes.pending.md` sits inside the already-published v1.27.0 section and is a historical record.
- **Documentation matches the code.** Read every file the change touched and the ones it should have: `README.md`'s option table, dispose example and `cost_profile` row; `docs/blobs.md` §SQL and its one-writer-per-machine bullet; `packages/db-p2p/docs/storage.md` §6 and §8's two composition-seam paragraphs. All three now describe one setting and the node arm. `docs/internals.md` and the storage packages' readmes say nothing about the plugin's options and needed nothing. `yarn lint:docs` resolves all 895 anchored citations.
- **Source hygiene otherwise.** `collection-factory.ts` is 1 264 lines (`wc -l`), unchanged in shape by this ticket — `storageFor` is five statements and the three consumers each lost a line. No narrated-statement comments were introduced; the new prose states constraints and consequences at the density of the surrounding file.

**Major findings: none.** Nothing reached the filing bar — no new ticket and no `backlog/` entry, because no latent defect was found. The one architectural gap the diff leaves is already filed: `tickets/backlog/debt-a-networks-storage-is-taken-from-one-collections-options`, whose arm this ticket's implementer refreshed.

**Conditional/speculative (one new tripwire, no ticket).** The `storageFor`-versus-`transactorOptions` divergence above is fine today and only becomes a defect if a *new* caller reaches `storageFor` without first going through `getOrCreateTransactor`. Parked as a `NOTE:` on `storageFor` in `collection-factory.ts` naming the invariant it rests on and the one-line remedy (read `transactorOptions.get(key)` there). The implementer's two existing tripwires — `storages` outliving `dispose()`, and transactor-key-versus-node-key — are correctly placed `NOTE:`s at the `storages` declaration and were not re-filed.

**Accepted tradeoffs: none at stake.** No `NOTE: accepted tradeoff` sits at any line this diff changes, so no earlier human decision was re-litigated. (`optimystic-module.ts` carries twelve of them, all far from the three lines this ticket touched in it; `SingleMachineBlobService` carries one, in a file the diff only constructs from.)

**One correction to the handoff.** The refreshed arm on `debt-a-networks-storage-is-taken-from-one-collections-options` claimed the change resolves storage "rather than reading it out of whichever options object arrived first". The memo does not change *where* the factory comes from — it is still the first options object's — and the next paragraph of that same ticket says so. Reworded, so the next agent is not told half the ticket has already landed.

## Validation run

All in the foreground, all green. No pre-existing failure surfaced, so no `tickets/.pre-existing-error.md` was written.

```
yarn lint                                                       # clean
yarn lint:docs                                                  # 49 documents, 895 anchored citations, 922 file mentions, 848 links - all resolve
yarn lint:deps                                                  # 6 guarded packages on their expected majors; every import declared
yarn workspace @optimystic/quereus-plugin-optimystic typecheck   # clean
yarn workspace @optimystic/db-p2p build                          # and the plugin's
yarn workspace @optimystic/quereus-plugin-optimystic test         # 1458 passing, 16 pending; smoke ok quereus@5.6.1
yarn workspace @optimystic/quereus-plugin-optimystic test:integration  # 1466 passing, 8 pending
yarn workspace @optimystic/db-p2p test                            # 3882 passing, 84 pending
yarn workspace @optimystic/db-p2p-storage-fs test                 # 133 passing, 1 pending
yarn check:rn                                                     # Metro bundle 20.3s, hermesc compile 15.5s - passed
TRANSACTOR=local TABLES=2 INDEXES=1 node test/repro-issue8.mjs     # 27 driver calls over the host store (0 before the fix)
```

`db-p2p` and `db-p2p-storage-fs` are in the suite list because the implement diff touched a comment in each; `test:integration` because the change decides what storage the node the plugin builds is given. The only edit made after the full suites was the `storageFor` tripwire comment, with the touched specs re-run after it (34 passing) and the package rebuilt.
