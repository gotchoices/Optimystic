----
description: Two of the programs that start a node build a second copy of the "which machines hold this data" component, and that copy is created from bare defaults instead of the node's own settings — so it looks for a differently-sized group of machines, and it does not filter out machines belonging to a different network.
prereq:
files: packages/reference-peer/src/cli.ts (~418), packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts (~46), packages/db-p2p/src/libp2p-key-network.ts (constructor ~152), packages/db-p2p/src/libp2p-node-base.ts (~695, ~1291), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (~375, the site that already does this correctly)
difficulty: medium
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: Nothing is visibly broken — a 16-wide cohort still stores and reads data, and the network-scoping gap only bites a deployment that runs two Optimystic networks over the same physical peers — so a maintainer could reasonably call this cosmetic inconsistency and defer; the counter-argument is that it is the same defect `bug-cluster-size-resolution-single-source` just fixed inside `createLibp2pNodeBase`, still live in the shipped reference node.
----

# Two composition roots construct a second key network from bare defaults

`Libp2pKeyPeerNetwork` is the component that answers "which peers are responsible for this key" —
it picks the coordinator and assembles the cohort. Its constructor's second parameter is the cluster
size, and it carries a **silent default of 16** (`libp2p-key-network.ts:154`), plus an optional
protocol prefix whose absence disables network scoping entirely (documented on the parameter itself).

`createLibp2pNodeBase` builds one correctly — from the single resolved cluster policy, with the
network-namespaced protocol prefix, the reputation tracker and the persistence store — and attaches
it to the node as `node.keyNetwork` (`libp2p-node-base.ts:695`, `:1291`).

Two composition roots ignore that attached instance and construct a **second** one from bare
defaults:

- `packages/reference-peer/src/cli.ts:418` — `new Libp2pKeyPeerNetwork(node)`, then hands it to the
  `NetworkTransactor` and to every `RepoClient.create` dial the CLI makes (`:442`, `:446`).
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts:46` — same call, on a
  node it just created through `createLibp2pNode`.

Each second instance therefore runs at cluster size 16 (rather than the node's resolved 10, or
whatever the operator configured), with network scoping off, no reputation input, no persisted
network state, and network mode `forming`. So the reference peer's read/write path can select a
different, wider peer set — and a different coordinator — than the node's own consensus path does
for the same key.

This is the same defect `bug-cluster-size-resolution-single-source` closed inside
`createLibp2pNodeBase`; those two roots sit outside it, so neither the single-source fix nor the
`assertClusterSizeCoupling` startup check reaches them.

The third caller already shows the intended shape: `collection-factory.ts` prefers
`libp2pNode.keyNetwork` when present and only falls back to constructing one for a foreign node it
did not build — with a comment spelling out exactly this hazard ("constructing a second one from
defaults would silently give every transactor-level findCluster / findCoordinator a 16-wide cohort
with network scoping disabled").

## Expected outcome

Filed at the representation rung rather than as two one-line patches, because patching the two call
sites leaves the trap armed for the next one:

- **A node's key network has one instance.** A composition root that has a node built by
  `createLibp2pNode` uses the instance already attached to it. Reaching it should not require an
  `as any` cast — `node.keyNetwork` being untyped is part of why these sites rebuild instead of reuse.
- **The cluster size stops having a silent default.** Removing `= 16` from the constructor makes a
  call site that does not know its cluster size fail to compile instead of quietly picking one. Most
  existing callers already pass it explicitly; the ones that do not are the bug.
- **A construction that genuinely must stand alone** (the foreign-node fallback in
  `collection-factory.ts`) states its size and its protocol prefix explicitly, as that site already does.

## Not in scope

Whether `Libp2pKeyPeerNetwork`'s protocol-prefix parameter should also become required is a separate
question with its own backward-compatibility argument, already written on the parameter's doc comment.

## Confirmation

`repro: static` — read from the code, not run. What would confirm it: start `reference-peer` against
a mesh of more than ten peers and compare the peer set the CLI transactor's `findCluster` returns for
a key against the set the node's own commit path uses for the same key; they should differ in width.
