----
description: Two of the programs that start a node build a second copy of the "which machines hold this data" component from bare defaults instead of reusing the one the node already has, so they look for a differently-sized group of machines and skip the filter that keeps other networks' machines out.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-node.ts, packages/db-p2p/src/libp2p-node-rn.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/reference-peer/src/cli.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/cluster-size-coupling.spec.ts, packages/db-p2p/readme.md
difficulty: medium
repro: verified
----

# One node, one key network — enforced by types, not by convention

## What was measured

Confirmed by running a throwaway spec against a real node (`createLibp2pNode({ bootstrapNodes: [],
networkName: 'test-second-key-network-repro' })`, then `new Libp2pKeyPeerNetwork(node)` — exactly what
`reference-peer/src/cli.ts:418` does):

```
attached.effectiveClusterSize = 10          second.effectiveClusterSize = 16
attached protocolPrefix = /optimystic/test-second-key-network-repro
second   protocolPrefix = undefined
```

So the second instance selects a 16-wide cohort where the node's own consensus path selects 10, and
its network-membership filter is off — a peer belonging to a *different* Optimystic network sharing
the same physical machines is a legal candidate for it. It also carries no reputation input and no
persisted network state, and (on a node started with bootstrap peers) network mode `forming` where the
node's own instance is `joining`.

The spec was deleted after the measurement; the permanent regression coverage is in the TODOs below.

## Root cause — one representation, two holes in it

`Libp2pKeyPeerNetwork` is the component that answers "which peers are responsible for this key". Its
constructor (`packages/db-p2p/src/libp2p-key-network.ts:152`) has a **silent cluster-size default of
16**, and `createLibp2pNodeBase` attaches the correctly-built instance to the node through an
**untyped** `(node as any).keyNetwork = keyNetwork` (`libp2p-node-base.ts:1291`).

Together those two facts make "build a fresh one from defaults" the path of least resistance and
"reuse the node's own" the path that needs a cast. Every affected call site took the first one:

| site | what it does |
| --- | --- |
| `packages/reference-peer/src/cli.ts:418` | `new Libp2pKeyPeerNetwork(node)` → feeds the `NetworkTransactor` (`:442`) and every `RepoClient.create` dial (`:446`) |
| `packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts:46` | `new Libp2pKeyPeerNetwork(libp2p)` — **dead code**, see below |
| six test/harness sites (listed in the TODOs) | same shape, on nodes they built with `createLibp2pNode` |

`collection-factory.ts:366-389` already shows the intended shape — prefer `libp2pNode.keyNetwork`,
construct only for a foreign node it did not build — but it needs `as unknown as { keyNetwork?: … }`
to reach the attachment, and passes `undefined` for the cluster size, so it inherits the 16 on its
fallback path.

Fixing the two call sites alone leaves the trap armed for the next one. Fix the representation:

1. **Type the node's attachment surface** so `node.keyNetwork` is reachable without a cast.
2. **Delete the `= 16` default** so a call site that does not know its cluster size fails to compile
   instead of silently picking one.

## Arm A — a typed node type

`createLibp2pNodeBase` attaches a documented, host-facing set of handles to the node at
`libp2p-node-base.ts:1284-1299` (a block whose own comment calls it "the sanctioned in-process
handle" surface), all via `(node as any).X = …`. Give that block a type.

New file `packages/db-p2p/src/optimystic-node.ts` — its own file, not inside `libp2p-node-base.ts`,
because the React Native entry (`src/rn.ts`) must export the type but does **not** export
`libp2p-node-base.js`. Use `import type` throughout so nothing is pulled into an RN bundle at runtime.

```ts
/**
 * The handles `createLibp2pNodeBase` attaches to the libp2p node it returns. This is the
 * sanctioned in-process surface a host reads — declared once here so reaching it does not
 * require a cast, and so a host cannot silently rebuild a component the node already owns.
 */
export interface OptimysticNodeAttachments {
	/**
	 * The node's ONE key network — built from its resolved cluster policy, network-namespaced
	 * protocol prefix, reputation tracker and persistence. A host that needs key/coordinator
	 * lookup uses THIS; constructing a second one gives peer selection a different cohort
	 * width and coordinator than the node's own consensus path uses for the same key.
	 */
	keyNetwork: Libp2pKeyPeerNetwork;
	coordinatedRepo: IRepo;
	storageRepo: StorageRepo;
	/** Per-collection change origin. Replaced by the cohort-topic bridge notifier when enabled. */
	blockChangeNotifier: IBlockChangeNotifier;
	reputation: PeerReputationService;
	/** Present only when the dispute subsystem is configured. */
	disputeService?: DisputeService;
	/** The node's libp2p Ed25519 identity key, for hosts binding a client-transaction signer. */
	peerPrivateKey: PrivateKey;
}

export type OptimysticNode = Libp2p & OptimysticNodeAttachments;
```

Then in `libp2p-node-base.ts`, replace the seven `(node as any).X = …` lines of that block with one
cast and typed assignments, and widen the return type of `createLibp2pNodeBase`,
`createLibp2pNode` (`libp2p-node.ts:14`) and the RN `createLibp2pNode` (`libp2p-node-rn.ts:17`) from
`Promise<Libp2p>` to `Promise<OptimysticNode>`. Widening a return type is source-compatible: callers
holding the result as `Libp2p` keep compiling.

**Scope boundary.** `libp2p-node-base.ts` attaches many *other* things via `(node as any)` —
`spreadOnChurnMonitor`, `gcEligibleBlocks`, `rebalanceMonitor`, `blockTransferCoordinator`,
`ringShiftCoordinator`, `cohortTopicHost`, `reactivitySubscribers`, `reactivityRecover`, … Those are
internal monitors, not the host-facing surface, and typing them is a separate job. Leave them alone;
do not grow this ticket into a full audit of `(node as any)` in that file.

## Arm B — no silent cluster size

Remove the `= 16` from `Libp2pKeyPeerNetwork`'s `clusterSize` parameter
(`libp2p-key-network.ts:154`), making it required. Every call site then either reuses the node's
instance or states a size.

For the one construction that genuinely must stand alone — the foreign-node fallback in
`collection-factory.ts:388`, for a node a host injected through `registerLibp2pNode` that
`createLibp2pNode` never built — export the node default as a named constant rather than repeating
the number:

```ts
// cluster-policy.ts
/** Default replication factor / target cohort breadth when the operator declares none. */
export const DEFAULT_CLUSTER_SIZE = 10;
```

and use it inside `resolveClusterPolicy` (replacing the inline `options.clusterSize ?? 10` at
`cluster-policy.ts:133`) and at the fallback site. Confirm it is reachable from
`@optimystic/db-p2p` — `src/index.ts` does not currently export `./cluster/cluster-policy.js`, so add
that export (check nothing in that module collides with an existing export first).

The constructor keeps seven positional parameters, so the fallback call still reads
`new Libp2pKeyPeerNetwork(node, DEFAULT_CLUSTER_SIZE, undefined, undefined, undefined, undefined,
prefix)`. Not pretty, but converting to an options bag would touch ~50 call sites in
`test/libp2p-key-network.spec.ts` alone and is not this ticket. Leave a `NOTE:` tripwire on the
constructor saying so, so the next reader meets the decision rather than re-deriving it.

## Arm C — the dead quereus key-network module

`packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts` exports `createKeyNetwork`,
which has **zero callers**: nothing in `packages/` imports it and `src/index.ts` does not re-export it
(verified by grep across `packages/**/*.{ts,json,md}`). Its `'test'` branch returns a stub that throws
on every method. Delete the file rather than fixing a function nobody calls.

Re-verify the zero-caller claim before deleting (`grep -rn "createKeyNetwork\|key-network" packages/`).
If a caller has appeared, instead make it prefer `libp2p.keyNetwork` when present and fall back the
same way `collection-factory.ts` does.

## Not in scope

Whether `Libp2pKeyPeerNetwork`'s `protocolPrefix` parameter should also become required is a separate
question with its own backward-compatibility argument, already written on the parameter's doc comment
(`libp2p-key-network.ts:159-167`). Do not change it here.

## Adjacent work

`tickets/fix/2-debt-libp2p-node-base-startup-error-leak.md` also edits `libp2p-node-base.ts`, but on
the post-`node.start()` error paths, not the attachment block or the signature. No shared line; expect
no conflict beyond ordinary rebase.

## TODO

### Phase 1 — representation

- Add `packages/db-p2p/src/optimystic-node.ts` with `OptimysticNodeAttachments` / `OptimysticNode` as
  sketched above; export it from both `src/index.ts` and `src/rn.ts`.
- Replace the `(node as any).X = …` block at `libp2p-node-base.ts:1284-1299` with one typed cast plus
  field assignments; return the typed node.
- Widen the return type of `createLibp2pNodeBase`, `createLibp2pNode` (`libp2p-node.ts`) and the RN
  `createLibp2pNode` (`libp2p-node-rn.ts`) to `Promise<OptimysticNode>`.
- Export `DEFAULT_CLUSTER_SIZE` from `cluster/cluster-policy.ts`, use it in `resolveClusterPolicy`, and
  export `./cluster/cluster-policy.js` from `src/index.ts`.
- Remove the `= 16` default from the `clusterSize` constructor parameter in `libp2p-key-network.ts`;
  add the `NOTE:` about the positional-parameter list staying as-is.

### Phase 2 — call sites

- `packages/reference-peer/src/cli.ts`: delete `new Libp2pKeyPeerNetwork(node)` (`:418`) and use
  `node.keyNetwork`. With the typed node, also drop the `(node as any).storageRepo` /
  `(node as any).coordinatedRepo` reads and their `throw new Error('… not available on node')` guards
  at `:412` and `:421` — the type now guarantees both. Drop the now-unused `Libp2pKeyPeerNetwork`
  import (`:4`).
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`: replace the
  `as unknown as { keyNetwork?: … }` cast at `:375` with a typed read; pass `DEFAULT_CLUSTER_SIZE`
  explicitly in the foreign-node fallback at `:388`. Its own node (created at `:203` with
  `clusterSize: 1`) is typed now, so the `(node as any).coordinatedRepo` / `blockChangeNotifier` reads
  at `:218` and `:228` can go too — but the map at `:24` stores host-registered nodes as well, so keep
  the map's value type honest about which fields are only present on nodes this factory built.
- Add a `NOTE:` at the foreign-node fallback: a host that injects a node through `registerLibp2pNode`
  should be able to hand in its key network instead of having one guessed from defaults; if a real
  host ever needs a cluster size other than the default, widen `registerLibp2pNode` rather than
  growing more guesses here.
- Delete `packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts` after re-verifying
  it has no callers.

### Phase 3 — tests and docs

- Switch these to the node's attached key network (each builds its node with `createLibp2pNode`, so
  each carries the same defect and each is a place the next reader would copy the wrong shape from):
  - `packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts:47`
  - `packages/db-p2p/test/cohort-topic/host-node-activation.spec.ts:93`
  - `packages/quereus-plugin-optimystic/test/plugin-first-launch-libp2p.integration.spec.ts:71`
  - `packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts:607`
  - `packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts:383`
  - `packages/quereus-plugin-optimystic/test/manual-mesh-test.ts:53`
- `packages/db-p2p/test/libp2p-key-network.spec.ts:917` builds on a *mock* libp2p and is asserting the
  `networkMode` default specifically — give it an explicit `16` rather than an attached instance.
- Extend `packages/db-p2p/test/cluster-size-coupling.spec.ts` (the spec that already owns this theme)
  with a case asserting the node's attached key network is reachable **without a cast** and carries
  both the resolved cluster size and the network-namespaced protocol prefix
  (`/optimystic/<networkName>`). `protocolPrefix` is private, so either read it through one narrow
  documented cast in the spec or add a small public getter next to `effectiveClusterSize` — prefer the
  getter, since `assertClusterSizeCoupling` already established that pattern.
- Update the snippet at `packages/db-p2p/readme.md:330` — it teaches `new Libp2pKeyPeerNetwork(node)`,
  the exact call this ticket removes. Replace with `const keyNetwork = node.keyNetwork;` and one line
  on why.

### Phase 4 — validation

- `yarn build` from root (the return-type widening and the required parameter must type-check across
  `db-p2p`, `reference-peer` and `quereus-plugin-optimystic`).
- `yarn lint` from root.
- `yarn test` from root — streamed, e.g. `yarn test 2>&1 | tee /tmp/test.log`.
- `OPTIMYSTIC_INTEGRATION=1 yarn test:integration` from root if wall-clock allows; if it runs long,
  at minimum run `db-p2p`'s `cluster-size-coupling`, `fresh-node-ddl-libp2p` and
  `cohort-topic/host-node-activation` specs and say in the review handoff which integration specs were
  not run.
