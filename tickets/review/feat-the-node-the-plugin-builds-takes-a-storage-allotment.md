description: A host that lets the Quereus plugin build its peer node can now tell it how much of the machine's disk the network may use, through one new registration setting, so that node fills, sheds and refuses against the figure its operator set.
architecture: packages/db-p2p/docs/storage.md#9-a-nodes-allotment-and-what-counts-against-it
files: packages/quereus-plugin-optimystic/src/types.ts (`LibP2PNodeOptions.storageAllotment`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`declaredStorageAllotment`, the two key lists, `resolveBinding`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (the `createLibp2pNode` call in `createNetworkTransactor`), packages/quereus-plugin-optimystic/test/storage-allotment-setting.spec.ts (new), packages/quereus-plugin-optimystic/test/plugin-node-storage.integration.spec.ts, packages/quereus-plugin-optimystic/README.md (*Plugin-Level Configuration*), .release-notes.pending.md
----

# Review: the node the plugin builds takes a storage allotment

## What landed

One plugin-level setting, `storage_allotment`, wired the way `cohort_topic` already is. Nothing in db-p2p changed.

- **`packages/quereus-plugin-optimystic/src/types.ts`** — `LibP2PNodeOptions.storageAllotment`, typed `Pick<NonNullable<NodeOptions['storageAllotment']>, 'bytes' | 'thresholds' | 'usedBytesCacheTtlMs'>`, documented beside `cohortTopic` with the reason it is a `Pick` (the two omitted keys, `now` and `blobRecords`, are wiring seams the node fills itself; and a rename over in db-p2p becomes a compile error here rather than a setting that silently stops arriving).
- **`packages/quereus-plugin-optimystic/src/optimystic-module.ts`** — exported `declaredStorageAllotment(aux)`, beside `declaredLinkRoundTripMs` and `declaredCohortTopic`, plus two key lists (`STORAGE_ALLOTMENT_KEYS`, `STORAGE_ALLOTMENT_THRESHOLD_KEYS`) each `satisfies` the node's own keys, and a `quotedKeyList` helper that formats the accepted keys in the error messages. `resolveBinding` now returns `storageAllotment: declaredStorageAllotment(aux)` in its `libp2pOptions`. `SESSION_BINDING_VTAB_ARGS` untouched — this is not a `USING` argument.
- **`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`** — one line, `storageAllotment: options.libp2pOptions?.storageAllotment,` in the `createLibp2pNode` call in `createNetworkTransactor`.
- **Docs** — a `storage_allotment` row in the README's *Plugin-Level Configuration* table after `cohort_topic`; in `.release-notes.pending.md`, the closing sentence of *The Quereus plugin takes one storage setting per network* replaced with the new setting, and *Upgrading a group of machines* now names the plugin setting alongside `storageAllotment.bytes`.

The validator checks **shape only** — object, known keys, `bytes` and `usedBytesCacheTtlMs` numeric when present, `thresholds` an object of known keys. The numbers stay the node's to refuse (`assertStorageAllotmentBytes`, `resolveStoragePressureThresholds` throw `RangeError` at construction), so an operator has one voice for the ranges, not two. An unknown key is **refused**, naming it, because a dropped key would reach the node as "no allotment" — the silent un-measuring this release exists to end.

## Tests

| Test | What it verifies |
|---|---|
| `test/storage-allotment-setting.spec.ts` (new, 7 cases) | Each branch of `declaredStorageAllotment`: unset → `undefined`; a well-shaped allotment and `{}` returned unchanged; and the four refusals — not an object, an unknown top-level key (`byte`), a non-numeric `bytes`, an unknown threshold key (`shedabove`) — each matched on the message that names the setting and the offending key. |
| `test/plugin-node-storage.integration.spec.ts` (extended) | That the figure a host sets actually reaches the node the factory built: `storage_allotment: { bytes: 2 GiB }` in the `register` config, then `node.storageAccount.capacity()` reports that `allotmentBytes` and — memory reporting no free space — the same figure as `totalBytes`. Its header comment and `it` title now cover both storage settings. |

Nothing else is owed. The pass-through is one field and the integration spec guards it where a real node exists; no spec in this package covered `resolveBinding`'s sibling readers before, and none was added for the registration plumbing.

## Commands run

```
yarn workspace @optimystic/quereus-plugin-optimystic typecheck          # clean
yarn workspace @optimystic/quereus-plugin-optimystic build              # clean (the suite has a stale-dist guard)
node --import ./register.mjs node_modules/mocha/bin/mocha.js test/storage-allotment-setting.spec.ts --exit   # 7 passing
yarn lint:docs                                                          # 49 documents, all citations resolve
yarn lint:deps                                                          # every import declared
```

## Not run — for review to run

- **`test/plugin-node-storage.integration.spec.ts`.** It needs `OPTIMYSTIC_INTEGRATION=1` and real libp2p, and the package's `test:integration` script runs the whole suite rather than one file, which is beyond this stage. **So the two new capacity assertions have never executed.** `dist` is freshly built, so the file can be run on its own: `$env:OPTIMYSTIC_INTEGRATION=1; node --import ./register.mjs node_modules/mocha/bin/mocha.js test/plugin-node-storage.integration.spec.ts --exit` from the package directory. The parts most worth watching: the node key the map is read by (`${NETWORK_NAME}:0`, from `CollectionFactory.getNodeKey`) and whether `capacity().totalBytes` really equals the allotment over `memoryNodeStorage()` — both were derived by reading the code, not by running it.
- **The package's full suite**, per `tickets/rules/testing.md`.

## Worth a reviewer's attention

- **Where validation happens.** `resolveBinding` only, with its two siblings — no eager check in `register()`. The tradeoff was weighed in the plan and is not open: a host with a malformed value learns at its first table or blob use rather than at `register()`, but it is still always before a node is built, and one reader beside its siblings beats a second site that can drift. Don't re-file it.
- **The `NOTE:` on the key lists is deliberately stale-by-design.** A key *added* to `NodeOptions.storageAllotment` in db-p2p is refused here until someone adds it to the list. That is loud-and-stale chosen over silent-and-wrong; the comment says so at the site.
- **`{ bytes: undefined }` is accepted** and reaches the node as absent. The key-set check runs over `Object.keys`, so the key is known; the numeric checks skip `undefined`. That matches optional-field semantics and the node's own reading of an absent `bytes`, but it is a choice the plan did not spell out.
- **No cross-option rule between `storage_allotment` and `storageFactory`.** An allotment with no storage factory means a real allotment over memory, which `storage.md` §9 lists as a legitimate row; the README says so and nothing refuses it.
- **Inert but still validated** for `local`, `test`, `mesh-test` and custom transactors, and for a node the host registered with `registerLibp2pNode` — both verified by inspection only, and both stated in the README row.

No tripwires parked, and no tickets filed.
