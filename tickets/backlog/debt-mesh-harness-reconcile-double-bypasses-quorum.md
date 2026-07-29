----
description: The fake network used by many tests copies data between nodes by simply trusting the first node that answers, while the real system requires several nodes to agree first — so tests that look like they exercise data repair actually prove nothing about it.
files: packages/db-p2p/src/testing/mesh-harness.ts (makeReconcileBlock, ~line 121), packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/reconcile-block.spec.ts
difficulty: medium
----

# The mesh test harness's block-repair stand-in has none of the real acceptance rules

## What exists today

`packages/db-p2p/src/testing/mesh-harness.ts` builds an in-memory mesh of nodes with real storage
and consensus but mock transport. For the "pull a block I am missing from a sibling node" step it
supplies its own hand-written stand-in, `makeReconcileBlock`, which:

- walks the cohort peer list in order,
- takes the **first** node that reports a revision at least as new as the committed one,
- saves that node's bytes.

The production implementation (`cluster/reconcile-block.ts`, `createReconcileBlock`) instead:

- asks every cohort peer in parallel,
- requires a quorum of *distinct* peers to agree on the target revision and action id,
- then requires a quorum to agree on the block **content** at that revision,
- declines and retries later if either vote fails,
- reports peers that served contradicting content to the reputation subsystem.

The stand-in's own comment calls it "the mesh analogue of `createReconcileBlock`". It is not an
analogue of the acceptance rules — only of the data movement. Both the commit path and the read path
in the harness use it, so **every** mesh-level test involving block repair runs first-peer-wins.

## Why it matters

A mesh test that passes tells you nothing about whether the quorum gates work, and — worse — would
keep passing if those gates regressed to permanently declining. The gates are exactly what three
consecutive bug fixes have had to correct, so the one layer of testing that combines real storage,
real consensus and multiple nodes is blind to the thing most likely to break.

## What "done" looks like

The harness drives the real `createReconcileBlock`, with its `fetchArchive` dependency implemented
over a sibling node's `StorageRepo` (building a minimal `BlockArchive` — the reconcile logic reads
only `revisions[rev].action.actionId` and `revisions[rev].block`).

Expect fallout, and treat it as signal rather than noise: a harness mesh currently has no
`clusterSize` in its consensus config, and the real logic needs one to decide how many corroborators
a cohort could supply. Existing mesh tests where exactly one sibling holds the block will begin to
decline unless the mesh declares a cluster size that matches its node count. Each such test needs a
decision — is that scenario supposed to heal, or was it only ever healing because the stand-in did
not check?

Worth adding once the harness is honest: a mesh-level test that two nodes converge end-to-end, which
is currently only covered by unit tests and by an integration scenario in a sibling repository that
cannot be run from here (see `blocked/two-node-convergence-acceptance-cross-repo-build`).
