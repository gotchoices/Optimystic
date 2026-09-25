description: A mesh test fixture sometimes failed before the test started, because it looked for block ids that one fixed node was responsible for and that node's share of a random ring was occasionally too small; the fixture now picks a node that actually has enough.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`nodeWithBlocksInCohort`, replaces `blockIdsInCohortOf`)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (five callers)
  - packages/db-p2p/test/mesh-sanity.spec.ts (one caller, two distinct nodes via `exclude`)
  - docs/optimystic.md (test harness paragraph names the helper)
  - tickets/backlog/debt-no-mesh-fixture-forces-two-coordinator-batches.md (one prose mention renamed)
difficulty: easy
repro: verified
----
# Fixture picks the node from the ring instead of hard-coding `mesh.nodes[0]`

## What was wrong

`blockIdsInCohortOf(mesh, node, count, prefix)` scanned `${prefix}-0 … -9999` for ids whose cohort contained a caller-chosen node (always `mesh.nodes[0]` or `[1]`). Peer ids are random per mesh, so a node's arc of the ring can be small enough that fewer than `count` candidates land in it, and the fixture then threw before the test body ran. One `yarn check` failed this way in `coordinator-repo-integration.spec.ts` ("should track revision state across multiple commits"). No caller needed a specific node.

## What changed

`nodeWithBlocksInCohort(mesh, count, prefix, { exclude?, maxCandidates? })` in `packages/db-p2p/src/testing/mesh-harness.ts` returns `{ node, blockIds }`: the first node (skipping `exclude`) to accumulate `count` ids among the candidates. `blockIdsInCohortOf` is removed. All six callers and the `docs/optimystic.md` test-harness paragraph use the new helper; `mesh-sanity.spec.ts` passes `exclude: [node0]` for its second node, which is what keeps "pend + commit through different nodes independently" using two distinct nodes. No assertion in any caller changed. The one mention of the old helper in the backlog ticket `debt-no-mesh-fixture-forces-two-coordinator-batches` was renamed.

The review pass added two fail-fast guards and a docstring paragraph; see below.

## Review findings

### What was checked

- **The implement-stage diff, read before the handoff summary.** Worth recording for anyone tracing this later: the code landed in the *fix*-stage commit `cefcbf78`, and the implement-stage commit `92b1e94b` contains only the ticket move plus the backlog-prose rename. `git show --grep="ticket(implement): …"` alone would show no code.
- **Every caller, for hidden dependence on which node it gets.** This was the handoff's main open question. All six use `node` only as the coordinator they pend, commit, cancel and read back through; none asserts on a peer id, a node index, or anything else that distinguishes one node from another. In `coordinator-repo-integration.spec.ts` the surrounding suites are `createMesh(3, { responsibilityK: 1 })`, so the chosen node is the block's sole responsible peer, which is the only property the assertions need. The two remaining `mesh.nodes[0]!` uses in those files are in `responsibilityK: 3` suites where every node is in every cohort, so they were correctly left alone.
- **Whether the flakiness is actually gone, or only made less likely.** It is gone for every caller that passes no `exclude`, by counting rather than by luck: at `responsibilityK: 1` each of the 10,000 candidates lands in exactly one node's cohort, so the busiest of three nodes owns at least 3,334 of them — no `count` a spec would plausibly ask for can fail. That argument was not in the code, so it is now a paragraph on the docstring. It does not extend to the `exclude` arm, where the remaining nodes could in principle own a vanishing arc; that residual is astronomically small and the throw names it clearly, so it is left as is.
- **Repo-wide sweep for the old name.** `blockIdsInCohortOf` survives only in `tickets/complete/2-writer-and-harness-route-to-the-cohort.md`, which is the archived record of the run that introduced it. Correct to leave — an archive describes what happened then.
- **Docs.** `docs/optimystic.md` is the only document that named the helper, and it was updated. `yarn lint:docs` resolves all 47 documents, 181 anchored citations, 679 file mentions and 394 links.
- **Lint, types, tests.** `yarn lint` exit 0; `tsc --noEmit` in `packages/db-p2p` clean; the full `packages/db-p2p` suite 3114 passing, 63 pending, 0 failing; the two affected specs (36 tests) run 40 further consecutive times with no failure, which is the evidence that matters for a change about ring randomness. Not run: `yarn test:integration` and the rest of `yarn check` — no `*.integration.spec.ts` uses the helper.
- **Build freshness.** Editing `db-p2p/src` left its `dist` older than its source, which would have tripped `assertBuildFresh` for every *dependent* package's test run. `yarn workspace @optimystic/db-p2p build` was run; `dist` is git-ignored, so the committed tree is the one source file.

### Minor findings, fixed in this pass

- **`nodeWithBlocksInCohort` spent all 10,000 candidates before rejecting a caller error.** With `count` of 0 the `ids.length === count` test runs after a push and so never matches, and with every node in `exclude` no candidate can ever match either. Both cases scanned the whole candidate range — 10,000 `findCluster` calls inside a test — and then failed with `best had 0`, a count rather than a cause. The first was the handoff's own declared gap. Both are now fail-fast guards above the loop that name what the caller asked for. The guards are unreachable from the six current callers; they exist so the seventh is told what it did wrong.
- **The docstring did not say why the throw is essentially unreachable**, which is exactly the non-obvious consequence a reader of a bounded scan wants. Added as the counting argument above.

### Major findings

None. Stating the reason rather than the absence: the change is about forty lines confined to one test fixture with no production reach, it removes rather than adds a code path, and its single judgment call — the chosen node is now arbitrary per run — was verified caller by caller above rather than assumed.

### Tripwires parked

None. The two candidates the handoff offered are not conditional concerns. The unmeasured scan cost is bounded by the early exit — a run ends as soon as any node reaches `count`, so it costs on the order of `count × nodes` candidates, and the 10,000 cap is spent only on the throw path the counting argument above shows is unreachable without `exclude`. The arbitrary-node property was settled by reading the callers, not deferred.

### Accepted tradeoffs encountered

None. There is no `NOTE:` at or around this site, so nothing here was previously weighed and declined.

### Tests

None added, none cut. Per *Tests must pay for themselves*, a deterministic test of this helper's throw path would verify the fixture rather than the product, and the guards added above are refusals of caller error that a type or a reading of the call sites already covers. Nothing was cut either: no assertion in any caller changed, so the six existing callers exercise the success path on every suite run and none of them restates the implementation or verifies a mock. The 40-run repetition is the right instrument for a randomness change and leaves no test behind to maintain.
