description: A host that lets the Quereus plugin build its peer node can now tell it how much of the machine's disk the network may use, so that node fills, sheds and refuses against the figure its operator set instead of against the whole disk — or, on a backend that cannot see the disk at all, instead of never knowing how full it is.
architecture: packages/db-p2p/docs/storage.md#9-a-nodes-allotment-and-what-counts-against-it
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`resolveBinding`, beside `declaredCohortTopic` and `declaredLinkRoundTripMs`), packages/quereus-plugin-optimystic/src/types.ts (`LibP2PNodeOptions`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`createNetworkTransactor`, the `createLibp2pNode` call around line 695), packages/quereus-plugin-optimystic/README.md (the *Plugin-Level Configuration* table), packages/quereus-plugin-optimystic/test/plugin-node-storage.integration.spec.ts, packages/quereus-plugin-optimystic/test/storage-allotment-setting.spec.ts (new), .release-notes.pending.md (the v1.30.0 sections *The Quereus plugin takes one storage setting per network* and *Upgrading a group of machines*), packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.storageAllotment` — read only; nothing in db-p2p changes)
----

# The node the plugin builds takes a storage allotment

## Why

v1.30.0 makes every node measure what it stores against one allotment its operator sets (`NodeOptions.storageAllotment` in `packages/db-p2p/src/libp2p-node-base.ts`) and act on it as it fills: shrink the read cache, hand ranges to other machines, delete what it handed over, and at the top refuse new data (`packages/db-p2p/docs/storage.md` §9 and §10).

The Quereus plugin builds its own node for a `network` transactor (`CollectionFactory.createNetworkTransactor`), and that call passes no `storageAllotment` because the plugin offers no setting for one. So a host that lets the plugin build its node cannot give it an allotment at all. On a backend that reports free space (file, IndexedDB in a browser) the node then measures against the whole free disk; on one that does not (SQLite on NativeScript, LevelDB on React Native, memory) it cannot tell how full it is, logs a `node-wiring` `WARN:`, never sheds or refuses, takes the whole keyspace, and advertises no `ArachnodeInfo.capacity` — which a v1.29.1 peer's ring statistics leave out of both their peer count and their capacity total. The v1.30.0 *Upgrading a group of machines* advice tells exactly such a host to set the allotment, which a plugin-built node currently cannot. The only way out today is for the host to build the node itself and register it with `CollectionFactory.registerLibp2pNode`, which is a lot of code to own for one number.

## What to build

One plugin-level setting, `storage_allotment`, wired exactly the way `cohort_topic` already is: read from the registration config in `resolveBinding`, carried on `LibP2PNodeOptions`, passed by `createNetworkTransactor` to `createLibp2pNode` as `storageAllotment`. Four small edits, and nothing in db-p2p changes.

**The option.** `storage_allotment` is an object with `bytes`, `thresholds` and `usedBytesCacheTtlMs`, all optional, passed through verbatim as the node's `storageAllotment`. Plugin-level only — `register(db, config)`, not a per-table `USING` argument — for the reason the other two node settings are: it configures the node, which every table on one network and port shares. Unset, nothing changes anywhere.

**The field on `LibP2PNodeOptions`** (`packages/quereus-plugin-optimystic/src/types.ts`), beside `linkRoundTripMs` and `cohortTopic` and documented in the same voice:

```ts
storageAllotment?: Pick<NonNullable<NodeOptions['storageAllotment']>, 'bytes' | 'thresholds' | 'usedBytesCacheTtlMs'>;
```

A `Pick` of the node's own type rather than the whole `StorageAllotmentOptions` (`packages/db-p2p/src/storage/storage-account.ts`), for two reasons worth a comment on the field: the two keys left out are wiring seams a host has no business setting (`now` is an injectable clock, and `blobRecords` is overwritten by the node itself at `libp2p-node-base.ts:1470`), and a `Pick` makes a rename of one of these keys over in db-p2p a compile error here instead of a setting that silently stops arriving — the failure class of backlog `debt-node-options-call-sites-escape-the-type-check`.

**The reader**, beside its two siblings in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`, and `export`ed (as `defaultTransactorOf` is) so its spec can reach it:

```ts
export function declaredStorageAllotment(aux: Readonly<Record<string, unknown>>): LibP2PNodeOptions['storageAllotment']
```

It returns `undefined` when the key is absent, returns the declared object unchanged when its shape is right, and otherwise throws an `Error` whose message names the setting:

| Declared | Message (`...` stands for `got ${typeof declared} ${String(declared)}`) |
|---|---|
| not an object, `null`, or an array | `storage_allotment must be an object with an optional number 'bytes', an optional 'thresholds' and an optional number 'usedBytesCacheTtlMs' (the node's storageAllotment option); ...` |
| a key that is none of those three | `storage_allotment has no 'byte' setting; it takes 'bytes', 'thresholds' and 'usedBytesCacheTtlMs'` |
| `bytes` present, not a number | `storage_allotment.bytes must be a number of bytes; ...` |
| `usedBytesCacheTtlMs` present, not a number | `storage_allotment.usedBytesCacheTtlMs must be a number of milliseconds; ...` |
| `thresholds` present, not an object (or `null`, or an array) | `storage_allotment.thresholds must be an object of fractions; it takes 'reclaimBelow', 'shedAbove' and 'refuseAbove'; ...` |
| `thresholds` carries a key that is none of those three | `storage_allotment.thresholds has no 'shedabove' setting; it takes 'reclaimBelow', 'shedAbove' and 'refuseAbove'` |

The wording is a suggestion; naming the setting, and the offending key where there is one, is the requirement.

**The plugin checks shape; the node stays the authority on the numbers.** Do not re-implement `assertStorageAllotmentBytes` or `resolveStoragePressureThresholds`: `bytes: 0`, `bytes: 1.5` and inverted thresholds are the node's `RangeError` at construction, and duplicating those rules here would give an operator two voices to keep in step. `{}` is accepted and means exactly what unset means.

**The key sets ARE shape, and an unknown key is refused.** `{ gigabytes: 20 }` passed through would reach a node as "no allotment", which is the silent un-measuring this whole release is about; a refusal naming the key is the point of the setting. Derive both accepted sets from the node's types (`keyof NonNullable<…>`, with `satisfies` if you like the idiom) so a rename is a compile error, and leave a `NOTE:` at the validator saying that a key ADDED in db-p2p is refused here until it is added to the list — loud and stale, chosen deliberately over silent and wrong.

**Where it is validated.** In `resolveBinding` only, with its siblings — one site, called by every path that can reach a node (`parseTableSchema` for a declared table, `deriveDefaultOptions` for the catalog open and for `plugin.blobs`). Do NOT add a second eager check in `register()`. The tradeoff, stated so a reviewer need not re-weigh it: a host with a malformed value learns at its first table or blob use rather than at `register()` (where `cost_profile` and `blob_unstaged_holding_ms` are checked, because `register` itself consumes those). It is still always before a node is built, so no node ever runs on a value nobody checked, and one reader beside its siblings is worth more than fail-fast at a second site that can drift from the first.

**The pass-through.** `resolveBinding` adds `storageAllotment: declaredStorageAllotment(aux)` to the `libp2pOptions` it returns; `createNetworkTransactor` adds `storageAllotment: options.libp2pOptions?.storageAllotment,` to its `createLibp2pNode` call. That call is the only `createLibp2pNode` in the plugin's source, and `optimystic-module.ts:680` is the only place in it that builds a `libp2pOptions` object — there is nothing else to thread.

**Not in scope.** The schema-manager fingerprint (`createSchemaManager`) deliberately omits `linkRoundTripMs` and `cohortTopic` because neither changes which storage the catalog reaches; the allotment is the same and must not be added to it. The `local` transactor has no node and so no storage account at all; that gap is parked as backlog `feat-a-local-only-host-measures-nothing-it-stores`.

## Edge cases & interactions

- **A node the host registered.** `registerLibp2pNode` puts the node in `CollectionFactory`'s `libp2pNodes` map, so `createNetworkTransactor`'s `if (!nodeInfo)` branch never runs and the setting has no effect — that node took its own options. Verified by inspection of that branch, and said plainly in the README row, as it is for `cohort_topic`.
- **Every transactor but `network`.** `local`, `test`, `mesh-test` and a custom transactor build no node, so the setting is inert for them — but it is still VALIDATED for them, because `resolveBinding` runs on every binding. That is deliberate and matches both siblings: a typo in the registration config is a typo whichever transactor a table names. Verified by inspection.
- **An allotment with no `storageFactory`.** The node is then built over `memoryNodeStorage()` with a real allotment: memory reports no free space, so the effective total IS the allotment and the node measures heap-backed bytes against it. Odd but legitimate — `storage.md` §9's table gives exactly that row — so refuse nothing and invent no cross-option rule the node itself does not have. Verified by inspection; one clause in the README row.
- **`bytes` out of range, thresholds inverted.** `createLibp2pNode` throws a `RangeError` (`assertStorageAllotmentBytes`, `resolveStoragePressureThresholds`), which surfaces as the rejection of whatever statement or blob call first built the node — not at `register()`, and not from the plugin's own reader. Verified by inspection; the README row says the numbers are the node's to refuse.
- **A small allotment changes more than refusal.** The node's blob read cache is the smallest of its own cap (256 MiB), an eighth of the effective total, and what the total leaves; and a node with under `DEFAULT_MIN_RING_CAPACITY_BYTES` (100 MiB) available advertises the deepest ring with a partition instead of the whole keyspace. So a host that sets a small figure gets a smaller cache and a narrower ring, both correctly. Nothing to implement — it is why the integration spec below uses 2 GiB rather than a token figure, which would change that spec's own put path.
- **Two tables, one registration, two networks.** The setting is plugin-level, so no two tables and no two `USING` clauses in one registration can disagree about it. Two tables that name different `networkName` or `port` do resolve to two node keys and therefore two nodes, each given the same figure, so a host that puts its tables on two networks in one registration promises the machine's disk twice. Pre-existing class, already named in backlog `debt-a-networks-storage-is-taken-from-one-collections-options` (its closing paragraph: a node holds whichever key's `libp2pOptions` built it) — do not file anything and do not add a `NOTE:`; one sentence in the README row is the whole of what is owed. Two separate `register()` calls each build their own `CollectionFactory` and their own node, so they cannot disagree either.
- **The catalog-open ordering.** `deriveDefaultOptions` resolves a binding too, and after a restart the catalog read is the first thing to name a transactor key. Because the setting is plugin-level and uniform, whichever path builds the node supplies the same figure — the hazard that bit `storageFactory` (a hand-built options object dropping a field) cannot arise from one field on `libp2pOptions` that only `resolveBinding` fills. Verified by inspection of both call sites.

## Tests

Two, and nothing more is owed. The reader is branching logic with named messages; the pass-through is one field, guarded where a real node already exists.

**`test/storage-allotment-setting.spec.ts` (new; no node, no `Database`)** — one `it` per branch of `declaredStorageAllotment`, in the shape of `test/cost-profile.spec.ts`, which imports its validator straight from `../src/…`:

- unset → `undefined`
- `{ bytes: 2147483648, thresholds: { shedAbove: 0.8 } }` → returned unchanged (deep-equal is enough)
- `{}` → returned unchanged
- `'20gb'` → throws `/storage_allotment must be an object/`
- `{ byte: 20 }` → throws `/storage_allotment has no 'byte' setting/`
- `{ bytes: '20gb' }` → throws `/storage_allotment\.bytes must be a number/`
- `{ thresholds: { shedabove: 0.8 } }` → throws `/storage_allotment\.thresholds has no 'shedabove' setting/`

**`test/plugin-node-storage.integration.spec.ts` (existing, extended — build no second node)** — that spec already registers a plugin over a `memoryNodeStorage()` and builds the real node by putting a blob. Add `storage_allotment: { bytes: ALLOTMENT_BYTES }` to its `register` config with `const ALLOTMENT_BYTES = 2 * 2 ** 30;` (2 GiB: above the 100 MiB low-space ring floor and at the blob-cache pivot, so the setting changes nothing about the put the spec already asserts), and after the existing assertions read the node the factory built and assert what it reports:

```ts
const nodes = (plugin.collectionFactory as unknown as {
  libp2pNodes: Map<string, { node: { storageAccount: { capacity(): Promise<{ allotmentBytes?: number; totalBytes?: number }> } } }>;
}).libp2pNodes;
const capacity = await nodes.get(`${NETWORK_NAME}:0`)!.node.storageAccount.capacity();
expect(capacity.allotmentBytes, "the node measures against the host's allotment").to.equal(ALLOTMENT_BYTES);
// Memory reports no free space, so the allotment IS the effective total (storage.md §9).
expect(capacity.totalBytes).to.equal(ALLOTMENT_BYTES);
```

The cast is the suite's existing way to reach a factory's internals (`test/catalog-hydration.spec.ts`, `test/init-retry-after-transient-failure.spec.ts`); add no production accessor for it. Update that spec's header comment: it now covers both storage settings the plugin's node takes.

Per `tickets/rules/testing.md` this stage runs no suites, and one spec file at most. The cheap one is the new unit spec:

```
yarn workspace @optimystic/quereus-plugin-optimystic typecheck
node --import ./register.mjs node_modules/mocha/bin/mocha.js test/storage-allotment-setting.spec.ts --exit    # from the package directory
```

The integration assertion needs a built `dist` (that spec imports `../dist/plugin.js`) and real libp2p — `yarn workspace @optimystic/quereus-plugin-optimystic build`, then that one file with `OPTIMYSTIC_INTEGRATION=1` (`$env:OPTIMYSTIC_INTEGRATION=1` in PowerShell). Leave it to review; the package's `test:integration` script runs the whole suite and is not agent-runnable.

## Docs

- **`packages/quereus-plugin-optimystic/README.md`**, *Plugin-Level Configuration*: a `storage_allotment` row after `cohort_topic`, in the voice of its neighbours. It should say: what it is (`NodeOptions.storageAllotment` for the node the plugin builds — `bytes`, the number of bytes of this machine you gave the network, plus the optional `thresholds` it changes behaviour at and `usedBytesCacheTtlMs`); that the plugin refuses a value of the wrong shape or an unknown key while the node refuses a number out of range; that unset means the node measures against whatever its backend reports free, and that on SQLite, LevelDB and memory — which report none — it then cannot tell how full it is at all, which is the case this setting exists for; that it has no effect on a node the host registered; that it is plugin-level, like `cohort_topic`, and that one figure covers every node that registration builds, so a host with tables on two networks sizes it accordingly; and one clause that a figure below 2 GiB also lowers the node's blob read cache (an eighth of the allotment) and one leaving under 100 MiB available narrows its ring.
- **`.release-notes.pending.md`**, v1.30.0 *The Quereus plugin takes one storage setting per network* (heading unchanged — it is about the three storage factories becoming one): replace the closing sentence "The node the plugin builds takes no allotment; a host that needs one builds the node and registers it with `CollectionFactory.registerLibp2pNode`." with the new setting — `storage_allotment`, through `register()` only, `{ bytes, thresholds?, usedBytesCacheTtlMs? }`, passed to that node as `NodeOptions.storageAllotment`, refused for shape at the first table or blob use, no effect on a node the host registered, and unset meaning today's behaviour.
- **`.release-notes.pending.md`**, v1.30.0 *Upgrading a group of machines*: make "set `storageAllotment.bytes` on SQLite, LevelDB and memory nodes" also name the plugin setting, so a host that does not build its own node can act on the advice.
- Nothing changes in `packages/db-p2p/docs/storage.md` or `packages/db-p2p/readme.md`: the plugin's own settings are the plugin README's to document, and §9 is cited here as the anchor, not edited.

## TODO

- Add `storageAllotment` to `LibP2PNodeOptions` in `packages/quereus-plugin-optimystic/src/types.ts` as the `Pick` above, documented in the voice of `linkRoundTripMs` and `cohortTopic`, with the comment on why it is a `Pick` of the node's type.
- Add the exported `declaredStorageAllotment` to `packages/quereus-plugin-optimystic/src/optimystic-module.ts` beside `declaredCohortTopic`, with the key sets derived from the node's types, the messages above, and the `NOTE:` about a key added in db-p2p.
- Read it in `resolveBinding` (`storageAllotment: declaredStorageAllotment(aux)`), and leave `SESSION_BINDING_VTAB_ARGS` alone — this is not a `USING` argument.
- Pass `storageAllotment: options.libp2pOptions?.storageAllotment` to `createLibp2pNode` in `CollectionFactory.createNetworkTransactor`.
- Write `packages/quereus-plugin-optimystic/test/storage-allotment-setting.spec.ts` with the seven cases above.
- Extend `packages/quereus-plugin-optimystic/test/plugin-node-storage.integration.spec.ts`: the 2 GiB allotment in its `register` config, the two capacity assertions, and its header comment.
- Add the README row, then replace the two sentences in `.release-notes.pending.md`.
- Run `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` and the new unit spec alone (the one spec this stage may run).
- Hand off to review naming what you did not run: the integration spec (needs `dist` and real libp2p) and the package's suite.
