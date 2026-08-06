----
description: Two programs that start a node used to build a second copy of the "which machines hold this data" component from bare defaults instead of reusing the one the node already has; they now reuse the node's own, and the shape that made the wrong path easier has been removed.
prereq:
files: packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-node.ts, packages/db-p2p/src/libp2p-node-rn.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/reference-peer/src/cli.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/cluster-size-coupling.spec.ts, packages/db-p2p/readme.md
difficulty: medium
----

# What landed

The defect: `Libp2pKeyPeerNetwork` (the component answering "which peers are responsible for this
key") had a silent `clusterSize` default of 16, and the node's correctly-built instance was reachable
only through an untyped `(node as any).keyNetwork`. So "build a fresh one from defaults" compiled and
"reuse the node's own" needed a cast — and `reference-peer/src/cli.ts` plus six test/harness sites took
the first path, selecting a 16-wide cohort with the network-membership filter off where the node's own
consensus path selected 10 with the filter on.

Fixed at the representation, not just at the call sites.

## Arm A — the node's host-facing surface is now typed

New `packages/db-p2p/src/optimystic-node.ts` declares `OptimysticNodeAttachments`
(`keyNetwork`, `coordinatedRepo`, `storageRepo`, `blockChangeNotifier`, `reputation`,
`disputeService?`, `peerPrivateKey`) and `OptimysticNode = Libp2p & OptimysticNodeAttachments`.
Exported from both `src/index.ts` and `src/rn.ts`; entirely `import type`, so nothing new enters an
RN bundle at runtime.

`libp2p-node-base.ts` writes that block through one cast
(`const attachments = node as unknown as OptimysticNodeAttachments`) with typed field assignments,
replacing seven independent `(node as any).X = …` lines. `createLibp2pNodeBase`, `createLibp2pNode`
(`libp2p-node.ts`) and the RN `createLibp2pNode` (`libp2p-node-rn.ts`) now return
`Promise<OptimysticNode>` — a widening, so existing callers holding the result as `Libp2p` still
compile.

## Arm B — no silent cluster size

`clusterSize` is now a **required** constructor parameter on `Libp2pKeyPeerNetwork`.
`DEFAULT_CLUSTER_SIZE = 10` is exported from `cluster/cluster-policy.ts` (used inside
`resolveClusterPolicy`, replacing the inline literal), and `./cluster/cluster-policy.js` is now
re-exported from `src/index.ts` so a standalone caller can reach it. Also added a public
`effectiveProtocolPrefix` getter next to `effectiveClusterSize`, so a spec can assert an instance's
network scoping without touching a private field.

## Arm C — dead module deleted

`packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts` (exporting
`createKeyNetwork`) had zero callers — re-verified with
`grep -rn "createKeyNetwork\|optimystic-adapter/key-network" packages/ --include=*.ts --include=*.json --include=*.md`,
which after the deletion returns nothing. Deleted.

## Call sites

- `reference-peer/src/cli.ts` — uses `node.keyNetwork`; the `(node as any).storageRepo` /
  `.coordinatedRepo` reads and their two `throw new Error('… not available on node')` guards are gone
  (the type guarantees both); `Libp2pKeyPeerNetwork` import dropped.
- `quereus-plugin-optimystic/.../collection-factory.ts` — introduces
  `type FactoryNode = Libp2p & Partial<OptimysticNodeAttachments>` as the map's value type, so the
  "these fields exist only on nodes this factory built" fact is in the type. The `as unknown as
  { keyNetwork?: … }` cast and the `peerPrivateKey` cast in `getSigner` are both gone. The foreign-node
  fallback passes `DEFAULT_CLUSTER_SIZE` explicitly and carries a `NOTE:` saying a host injecting a node
  should be able to hand in its key network rather than have one guessed.
- Test/harness sites switched to the attached instance: `db-p2p/test/fresh-node-ddl-libp2p.spec.ts`,
  `db-p2p/test/cohort-topic/host-node-activation.spec.ts`,
  `quereus-plugin-optimystic/test/plugin-first-launch-libp2p.integration.spec.ts`,
  `.../distributed-transaction-validation.spec.ts`, `.../distributed-quereus.spec.ts`,
  `.../manual-mesh-test.ts`.
- `db-p2p/test/libp2p-key-network.spec.ts:917` builds on a mock libp2p and is specifically asserting the
  `networkMode` default — given an explicit `16` rather than an attached instance, as specified.
- `db-p2p/readme.md` § Libp2p Integration — the snippet taught `new Libp2pKeyPeerNetwork(node)`; now
  teaches `const keyNetwork = node.keyNetwork;` with the reason.

## Tripwires parked in code

- `libp2p-key-network.ts`, above the constructor: the seven-positional-parameter list stays as-is —
  an options bag would touch ~50 construction sites in `test/libp2p-key-network.spec.ts` alone. Revisit
  if an eighth parameter appears or that spec is rewritten anyway.
- `collection-factory.ts`, at the foreign-node fallback: widen `registerLibp2pNode` to accept the
  host's own key network (or its cluster size) rather than growing more guesses, if a real host ever
  needs a non-default cluster size.

# How to validate

Everything below was run from the repo root and passed.

- `yarn build` — type-checks `db-p2p` (tsconfig includes `src` **and** `test`), `reference-peer`, and
  the rest. Clean.
- `npx eslint .` — clean, exit 0. (`yarn lint` produces no output on success.)
- `cd packages/quereus-plugin-optimystic && npx tsc --noEmit` — that package builds with `tsup`, which
  does **not** type-check its `test/` tree, so this was run separately. Clean.
- `yarn test` — all workspaces. **0 failing** (1357 + 1542 + 53 + 50 + 45 + 44 + 12 + 125 + 420 + 6 +
  258 passing). ~5 min.
- `OPTIMYSTIC_INTEGRATION=1 yarn test:integration` — **0 failing** (29 + 423 passing, 3 + 8 pending).
  ~2.5 min. The plugin's `plugin-first-launch-libp2p.integration.spec.ts` (3 passing) was also run
  on its own.

## Targeted specs worth re-running

```
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/cluster-size-coupling.spec.ts" "test/fresh-node-ddl-libp2p.spec.ts" \
  "test/cohort-topic/host-node-activation.spec.ts" --colors --reporter spec
```
16 passing.

## New regression coverage

`db-p2p/test/cluster-size-coupling.spec.ts` (the spec that already owned this theme) gained two cases:

- *"attaches its ONE key network on the typed node surface, carrying the resolved cluster size and
  network prefix"* — boots a real node and reads `node.keyNetwork` **with no cast** (this line failing
  to compile IS half the assertion), then asserts `effectiveClusterSize === resolveClusterPolicy({}).clusterSize`
  and `effectiveProtocolPrefix === '/optimystic/<networkName>'`. Both are what a defaults-built instance
  got wrong.
- *"resolves an unconfigured clusterSize to DEFAULT_CLUSTER_SIZE"* — pins the constant a standalone
  caller must pass to what an unconfigured node actually resolves, so the two cannot drift.

Already-existing coverage that guards the same theme:
`quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts` asserts the transactor's key
network is the node's (network-scoped, configured width). Its doc comment referenced "widens the cohort
to 16"; reworded, since that default no longer exists.

# Known gaps — please poke at these

- **The composition-root cast is still there.** `node as unknown as OptimysticNodeAttachments` in
  `libp2p-node-base.ts` is unavoidable at the one place that does the attaching (libp2p's node object
  isn't typed as extensible), and `return node as unknown as OptimysticNode` likewise. The win is that
  it is *one* cast against a *declared* interface instead of seven ad-hoc `any` writes — but a field
  added to `OptimysticNodeAttachments` and never assigned there would compile silently. There is no
  compile-time completeness check.
- **`libp2p-node-base.ts` still has many other `(node as any).X = …` attachments** —
  `spreadOnChurnMonitor`, `gcEligibleBlocks`, `rebalanceMonitor`, `blockTransferCoordinator`,
  `ringShiftCoordinator`, `cohortTopicHost`, `reactivitySubscribers`, `reactivityRecover`, … The ticket
  scoped these out as internal monitors, not host-facing surface, and I left them alone. Worth a
  reviewer's judgment on whether that line is drawn in the right place.
- **Many test files still READ the attachments through `(node as any)`** — `real-libp2p.integration.spec.ts`,
  `two-node-convergence.integration.spec.ts`, `multi-coordinator-*.integration.spec.ts`,
  `reference-peer/test/distributed-diary.spec.ts`, `reference-peer/test/quick-test.ts`,
  `reference-peer/test/offline-storage.spec.ts`. Those are *reads of the correct instance*, not second
  constructions, so none of them carries the defect — but they are still places a reader would copy an
  untyped shape from. Not converted; out of the ticket's stated scope.
- **`registerLibp2pNode`'s public signature widened** from `node: Libp2p` to `node: FactoryNode`
  (`Libp2p & Partial<OptimysticNodeAttachments>`). Every attachment field is optional, so a plain
  `Libp2p` still satisfies it and all three in-repo callers compile unchanged — but it is a published
  plugin API (`dist/plugin-*.d.ts`), so worth a second opinion on whether that is the right shape versus
  an overload or a separate `registerOptimysticNode`.
- **The `reference-peer` CLI change has no direct spec.** `startNetwork` in `cli.ts` is where the
  worst instance of the bug lived (it fed the `NetworkTransactor` and every `RepoClient.create` dial),
  and nothing in `reference-peer/test/` exercises that function — `distributed-diary.spec.ts` builds its
  own transactor. Verified by type-check and by the fact that the reads it replaced are the same
  attachments the node always set, but it is coverage-by-adjacency, not a test.
- **`protocolPrefix` remains optional** on the constructor. Explicitly out of scope per the ticket
  (it has its own backward-compatibility argument written on the parameter's doc comment), so the
  membership filter can still be silently off for a caller who omits it. Untouched by design.
- **The original repro was deleted before this ticket started.** The measurement in the implement
  ticket (`attached=10 / second=16`, prefix present / absent) was taken with a throwaway spec that no
  longer exists. The permanent replacement is the assertion pair above, which pins the *correct* state
  rather than reproducing the *broken* one — a reviewer wanting to see the bug would have to
  re-introduce the default.
