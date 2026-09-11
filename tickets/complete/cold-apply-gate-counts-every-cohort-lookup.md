description: Fixed a performance test that was only seeing 3 of the 54-144 "which machines hold this block?" questions a cold schema apply actually asks, and recorded why making each of those questions cheaper is not worth doing today.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.wrapKeyNetwork`, applied in `createMesh` before phase 1)
  - packages/db-p2p/test/mesh-harness-wrap-key-network.spec.ts (harness-level spec for the hook)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 4 rewritten, `ApplyCost` fields, `MEASURED`, diagnostic print, file header)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster`: accepted-tradeoff NOTE, comment only)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cancel-path NOTE wording; accepted-tradeoff NOTE in `get`, comment only)
  - packages/db-p2p/test/bench-findcluster.mjs (header comment records today's figure)
----
# Gate 4 counts every cohort lookup, and the solo-node memo is declined on measurement

## What landed

`findCluster` answers "which machines form the cohort (the replica group) for this block?". `cold-apply-cost.spec.ts` gates the cost of a cold `APPLY SCHEMA` through a 1-node in-process mesh. Its gate 4 counted cohort lookups by proxying `mesh.keyNetwork`, but only the transactor reads that property. Each node's coordinator closes over the mesh's shared key network directly, so gate 4 saw 3 of the real 54 / 144 / 142 lookups (at 22 / 67 / 66 objects), and none of the part that grows with schema size.

- **Harness hook.** `MeshOptions.wrapKeyNetwork?: (shared: IKeyNetwork) => IKeyNetwork` wraps the shared mock key network at construction, before any per-node view, member derivation or `Mesh.keyNetwork` captures it. When the option is omitted, nothing is wrapped, so the ~40 existing `createMesh` call sites are unchanged.
- **Gate 4 reshaped** to "cohort lookups per object, at every seam": per-scale ceilings (small 2.9, large 2.6, about 20 % over the measured 2.45 / 2.15), a no-growth check (`scaled ≤ small × 1.05`), and a sanity assertion (`complete > transactorSeam`) that fails loudly if the hook ever detaches. The transactor-seam count stays in the diagnostic print, ungated.
- **Solo-node memo declined.** A solo `findCluster` measures 0.009 ms/call on Node (`bench-findcluster.mjs`, N=2000), about 1.3 ms per 67-object apply. That is not worth the invalidation hazard: read-repair relies on a later lookup widening once a peer arrives. This is recorded as an accepted-tradeoff `NOTE:` at `findCluster`. The revisit condition is an on-device React Native profile.
- A wording fix in `coordinator-repo.ts`'s cancel-path NOTE: `pend`/`commit` pay the same doubled lookup, but a constant one, where cancel's scales with N.

## Review findings

**Checked:** the implement diff against the full implement-stage spec (every TODO item and every "Edge cases" bullet), the hook's placement in `createMesh` (it runs before `makeNodeKeyNetwork` and phase 1, and `Mesh.keyNetwork` returns the wrapped binding), the counting proxy's pass-through behaviour (the per-node wrapper mutates the returned record, and the proxy neither clones nor freezes it), the double-counting setup (two separate `Counts` objects, and only the complete one is gated), and the docs (no `docs/` file describes `MeshOptions`, and `yarn lint:docs` passes).

**Found and fixed inline (minor):**
- **A spec requirement was missed: the timing-sensitivity note.** The spec asked gate 4's comment to name that its count depends on the 60 s `responsibilityCache` and the 10 s solo absence memo (`readRepairWindowMs`), so a failure on a very slow host is recognisable. The implementer omitted it. Added it to gate 4's comment.
- **The `MEASURED` history comment conflated two measurement methods.** It said the totals were "counted via the `wrapKeyNetwork` hook by patching the shared key network directly and attributing each call by stack frame". Reworded it: stack-frame attribution found the totals, and the hook reproduced them exactly. It also attributed all 51 / 141 / 139 uncounted lookups to `CoordinatorRepo.get`. The per-site table shows five of them are fixed commit-path lookups (3 in `ClusterCoordinator`, 2 in `verifyResponsibility`), so the comment now says so.
- **The harness spec overclaimed.** The test titled "failure injection (findClusterFails, partitionSides)…" only exercises `findClusterFails`, so I retitled it. The "omitting the option leaves the unwrapped mock" test only checked the result had one entry, which a wrapper would also satisfy. It now also asserts `constructor.name === 'MockMeshKeyNetwork'`.
- `counting()`'s docstring said "used at three seams"; it is now four.
- **A declined idea was left unrecorded at its site.** The spec's decision #4 declined sharing one lookup between `get`'s proximity check and its cohort consult. The implementer left no marker there, so the next reviewer would likely re-discover and re-file it. Added an accepted-tradeoff `NOTE:` at the proximity loop in `CoordinatorRepo.get`, with its reason (nothing to win at 0.009 ms) and the related blocked decision. The companion decline (sending the cohort over the wire from `consolidateCoordinators`) is a security refusal, so it is not a tradeoff with a revisit condition and needs no NOTE.

**Major findings:** none. Nothing needed a new ticket. The hook is test-only, the production edits are comments, and gate 4's thresholds reproduce the measured baseline byte-for-byte (54 / 144 / 142, with the transactor seam at 3).

**Tripwires:** none new. The two conditional concerns the ticket raised already live at their sites as accepted-tradeoff NOTEs (`findCluster`, and now `CoordinatorRepo.get`). The timing dependency is in gate 4's comment.

**Not verified:**
- I did not re-run the bench at N=2000. The NOTE's 0.009 ms figure is the plan ticket's own measurement, and the implementer's N=200 spot-check (0.012 ms) agrees in order of magnitude.
- I did not run the integration suite (`OPTIMYSTIC_INTEGRATION=1`), because nothing here touches real-libp2p paths.

**Validation run:**
- `yarn workspace @optimystic/db-p2p build`: passes.
- `mesh-harness-wrap-key-network.spec.ts`: 3 passing.
- Plugin build, then `cold-apply-cost.spec.ts`: 7 passing, and the diagnostic print matches `MEASURED` exactly.
- ESLint on all five touched source/spec files: clean.
- `yarn lint:docs`: clean.
- Full db-p2p suite: 2682 passing, 50 pending (skipped before this ticket), 1 failing. The failure is `routing-key-convention-divergence.spec.ts` ("the coordinator the writer picks is outside the responsible cohort for most blocks"). It is a flaky statistical threshold on random 16-node keypairs: five isolated re-runs gave 0.595 (fail), 0.77, 0.82, 0.86 and 0.74 against `> 0.6`. It is unrelated to this ticket and is reported in `tickets/.pre-existing-error.md` for triage.
