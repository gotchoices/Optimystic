description: A mesh test fixture sometimes failed before the test started, because it looked for block ids that one fixed node was responsible for and that node's share of a random ring was occasionally too small; the fixture now picks a node that actually has enough.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`nodeWithBlocksInCohort`, replaces `blockIdsInCohortOf`)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (five callers)
  - packages/db-p2p/test/mesh-sanity.spec.ts (one caller, needs two distinct nodes)
  - docs/optimystic.md (test harness paragraph names the helper)
  - tickets/backlog/debt-no-mesh-fixture-forces-two-coordinator-batches.md (one prose mention renamed)
difficulty: easy
repro: verified
----
# Fixture picks the node from the ring instead of hard-coding `mesh.nodes[0]`

## What was wrong

`blockIdsInCohortOf(mesh, node, count, prefix)` scanned `${prefix}-0 … -9999` for ids whose cohort contained a caller-chosen node (always `mesh.nodes[0]` or `[1]`). Peer ids are random per mesh, so a node's arc of the ring can be small enough that fewer than `count` candidates land in it. One `yarn check` failed this way in `coordinator-repo-integration.spec.ts` ("should track revision state across multiple commits"). No caller needs a specific node.

## What changed

`nodeWithBlocksInCohort(mesh, count, prefix, { exclude?, maxCandidates? })` in `packages/db-p2p/src/testing/mesh-harness.ts` returns `{ node, blockIds }`: the first node (skipping `exclude`) to accumulate `count` ids among the candidates. It still throws, naming the best count reached, when no node gets there. `blockIdsInCohortOf` is removed. All six callers and the `docs/optimystic.md` test-harness paragraph use the new helper; `mesh-sanity.spec.ts` passes `exclude: [node0]` for its second node. No assertion in any caller was changed. This run also renamed the one mention of the old helper in the backlog ticket `debt-no-mesh-fixture-forces-two-coordinator-batches`.

## Verification

- Both specs (36 tests) passed 55 consecutive runs before this stage; `tsc --noEmit` in `packages/db-p2p` was clean.
- This stage: `yarn test` in `packages/db-p2p` — 3114 passing, 63 pending, 0 failing.
- This stage: `yarn lint:docs` from the root — all documents, citations and links resolve.
- A repo-wide search (excluding `node_modules`, `dist`, `.git`) finds `blockIdsInCohortOf` only in ticket files.
- Not run: `yarn test:integration` and the rest of `yarn check`. No `*.integration.spec.ts` file uses the helper, so neither should be affected.

## Tests added

None. The change is to a test fixture, and the failure it removes needs a random ring that happens to give a node too small an arc, so a deterministic test of the helper's throw path would test the fixture rather than the product. The existing callers exercise the success path.

## Known gaps for the reviewer

- The throw path (no node reaches `count` within `maxCandidates`) is untested. Reachable only with a tiny `maxCandidates` or an `exclude` that removes every node.
- `count` of 0 is not meaningful: the check `ids.length === count` runs after a push, so it never matches and the helper scans every candidate, then throws with `best had 0`. No caller passes 0.
- The scan cost was not measured. It calls `findCluster` once per candidate id, and the loop ends as soon as any one node has `count` ids, so it should normally stop after roughly `count` times the node count candidates; the 10,000-candidate cap is the worst case.
- The chosen node is now arbitrary per run (whichever node accumulates first), where callers used to get `nodes[0]`. Every caller's assertions are node-agnostic as far as this ticket could tell, and 55 repeated runs support that, but a reviewer may want to re-read the five `coordinator-repo-integration.spec.ts` callers for any hidden dependence on which node it is.
