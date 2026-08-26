description: The fake multi-node network used by most tests grew a new way to configure itself and a new repair route, but neither has a test — so a future edit could break either one silently and every suite would still go green.
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (resolveMeshPolicy — exported and directly callable; MeshOptions.clusterPolicy)
  - packages/db-p2p/test/mesh-reconcile-quorum.spec.ts (where the mesh-level cases live)
  - packages/db-p2p/src/cluster/cluster-policy.ts (resolveClusterPolicy — reference)
  - packages/db-p2p/src/cluster/cluster-repo.ts (reconcileDivergentCommit — the untested caller)
difficulty: easy
tradeoffs: Both gaps are covered indirectly — the configuration path by the four mesh cases that happen to use it, the commit path by unit tests of the same callback with a fake fetcher — so a maintainer could reasonably call this belt-and-braces and spend the time on behaviour that has no coverage at all.

# Two untested seams in the mesh test harness

`createMesh` is the in-process fake network almost every `db-p2p` test runs on. A recent change
rewired it to use the real block-repair logic instead of a stand-in. Two parts of that rewiring
have no test of their own.

## Arm one — the new configuration option is never exercised

`MeshOptions` gained a `clusterPolicy` field: the production-shaped way for a test mesh to declare
how big it really is, how many peers must agree, and whether it may run below the safe floor. The
harness folds that field together with three older top-level shortcuts, and documents a precedence
rule — *an explicit `clusterPolicy` entry beats the matching shortcut*. Nothing asserts the rule,
and no test passes `clusterPolicy` at all.

That matters more than a normal untested option, because `clusterPolicy.assumedClusterSize` is the
setting the cluster-policy module documentation names as **the** way a genuinely small deployment
regains the ability to self-repair without also shrinking its replication factor. The harness claims
to offer it; nothing shows it works there.

The folding logic now lives in its own exported function (`resolveMeshPolicy`) precisely so this can
be asserted without building a mesh — same options in, same numbers out. What is wanted:

- the precedence rule, per shortcut, both directions;
- `clusterPolicy.assumedClusterSize: 2` letting a two-node mesh repair (the documented escape hatch),
  distinct from the `clusterSize: 2` route the current specs already cover;
- omitting everything landing on the production defaults rather than on anything mesh-specific.

## Arm two — only one of the two repair routes is driven through the mesh

Repair reaches the same callback from two directions: a node that commits a block it cannot build
locally (the write side), and a node that reads a block the cohort says exists but it does not hold
(the read side). The rewiring's whole point was that both directions now share one object, so a test
can no longer tell them apart.

All four current mesh cases enter from the read side. The write side is covered only by unit tests
that call the callback directly with a fake peer-fetcher — which is exactly the kind of stand-in the
rewiring existed to stop relying on. One mesh-level case that provokes a commit the committing node
cannot materialize, and asserts it heals through the cohort, would close it.

## Also unpinned, and cheap to add while here

The harness deliberately refuses to serve block content from a peer a test has marked silent, so a
test that silences a peer cannot accidentally converge *through* that peer. The reasoning is written
down at the code site; no test holds it in place.
