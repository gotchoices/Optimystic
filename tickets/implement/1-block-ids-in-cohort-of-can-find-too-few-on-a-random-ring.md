description: A mesh test fixture sometimes failed before the test started, because it looked for block ids that one fixed node was responsible for and that node's share of a random ring was occasionally too small; the fixture now picks a node that actually has enough.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`nodeWithBlocksInCohort`, replaces `blockIdsInCohortOf`)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (five callers)
  - packages/db-p2p/test/mesh-sanity.spec.ts (one caller, needs two distinct nodes)
  - docs/optimystic.md (test harness paragraph names the helper)
difficulty: easy
repro: verified
----
# Fixture picks the node from the ring instead of hard-coding `mesh.nodes[0]`

## Cause

`blockIdsInCohortOf(mesh, node, count, prefix)` scanned `${prefix}-0 … -9999` for ids whose cohort contained a caller-chosen node (always `mesh.nodes[0]` or `[1]`). Peer ids are random per mesh, so a node's arc can be small enough that fewer than `count` candidates land in it. One `yarn check` failed this way in `coordinator-repo-integration.spec.ts` ("should track revision state across multiple commits"); no caller needs a specific node.

## Change already made in this run

`nodeWithBlocksInCohort(mesh, count, prefix, { exclude?, maxCandidates? })` returns `{ node, blockIds }`: the first node (skipping `exclude`) to accumulate `count` ids among the candidates. It still throws, naming the best count reached, when no node gets there. `blockIdsInCohortOf` is removed and all six callers plus `docs/optimystic.md` are updated. `mesh-sanity.spec.ts` passes `exclude: [node0]` for its second node. No assertion in any caller was changed.

Verified: both specs (36 tests) passed 55 consecutive runs; `tsc --noEmit` in db-p2p is clean.

## TODO

- Run `yarn test` in `packages/db-p2p` and `yarn lint:docs` from the root to confirm nothing else referenced the removed export.
