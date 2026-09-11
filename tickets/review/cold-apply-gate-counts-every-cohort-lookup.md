description: Fixed a performance test that was only seeing 3 of the 54-144 "which machines hold this block?" questions a cold schema apply actually asks, and documented why making each of those questions cheaper is not worth doing today.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.wrapKeyNetwork`, applied in `createMesh` before phase 1)
  - packages/db-p2p/test/mesh-harness-wrap-key-network.spec.ts (new harness-level spec for the hook)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 4 rewritten, `ApplyCost` fields, `MEASURED`, diagnostic print, file header)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster` — accepted-tradeoff NOTE, comment only)
  - packages/db-p2p/test/bench-findcluster.mjs (header comment, records today's figure)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cancel-path NOTE wording, comment only)
----
# What changed

## The hook (production-code-adjacent, but test-only)

`MeshOptions` in `mesh-harness.ts` gained `wrapKeyNetwork?: (shared: IKeyNetwork) => IKeyNetwork`,
applied in `createMesh` at the point the shared `MockMeshKeyNetwork` is constructed — before
`makeNodeKeyNetwork` closes over it and before phase 1 builds any per-node `deriveExpectedCluster`
closure. Every one of the ~40 existing `createMesh` call sites across db-p2p's suite is unaffected
(the option defaults to identity); I ran the full `db-p2p` suite (2683 passing, 50 pending —
pre-existing skips) to confirm.

New spec: `mesh-harness-wrap-key-network.spec.ts` — three cases: (1) a counting wrapper on a 3-node
mesh sees both a node coordinator's lookup (`coordinatorRepo.get`) and a lookup through
`mesh.keyNetwork` directly, proving the hook sits ahead of both paths; (2) `findClusterFails` still
works through a wrapped instance; (3) omitting the option leaves `mesh.keyNetwork` as the plain
unwrapped mock.

## The gate (`cold-apply-cost.spec.ts`)

Gate 4 used to count `findCluster` calls only at the seam `NetworkTransactor` reads
(`mesh.keyNetwork`, reassigned after `createMesh`) — which sees the coordinator's own commit-path
lookups but NOT the two lookups every `CoordinatorRepo.get` makes (`isResponsibleForBlock`'s
proximity check, `fetchBlockFromCluster`'s cohort consult), because each node's coordinator closes
over the mesh's *shared* key network through a per-node wrapper built during `createMesh`'s phase 1,
never through the `Mesh.keyNetwork` property. The old gate therefore asserted on 3 calls per commit
when the real count was 54 / 144 / 142 across the three test scales — it was checking 1/18 to 1/48
of the actual cohort traffic, and none of the part that scales with schema size.

Now `measureColdApply` wraps the shared key network via the new hook (the "complete" count) and
keeps a second, separate proxy on `mesh.keyNetwork` (the "transactor seam" count, printed but not
gated). Gate 4 is reshaped to match gates 5 and 6's per-object-ceiling-plus-no-growth pattern
(`MAX_FINDCLUSTER_PER_OBJECT = { small: 2.9, large: 2.6 }`, `SCALE_GROWTH_TOLERANCE`), plus a sanity
check (`complete > transactorSeam`) so a future edit that silently detaches the hook fails loudly
instead of the gate looking like a big improvement.

Ran the rewritten spec and it reproduces the ticket's expected numbers exactly: 54/22=2.45 (small),
144/67=2.15 (large), 142/66=2.15 (small×3), transactor seam 3 at every scale. Also ran the FULL
`quereus-plugin-optimystic` suite (800 passing, 13 pending — pre-existing skips) since this file
sits alongside many other DDL/DML cost and correctness specs that share plugin bootstrapping.

## The declined optimization (comment-only)

Added the accepted-tradeoff `NOTE:` at `Libp2pKeyPeerNetwork.findCluster` (verbatim text from the
ticket) recording that memoizing the solo-node cohort answer was considered and declined: measured
at 0.009 ms/call (ticket's own bench run, N=2000), so a memo would save ~1.3 ms per 67-object apply
while introducing an invalidation hazard (a node that gains a peer, or finishes identifying one,
must stop answering self-only immediately; read-repair recovery relies on that widening). Revisit
condition: an on-device React Native profile showing `findCluster` as material.

I independently re-ran `test/bench-findcluster.mjs` (default N=200, not the ticket's N=2000) after
editing its header comment, to confirm the comment-only edit didn't break the script and that the
order of magnitude still holds: got 0.012 ms/call just now vs. the ticket's 0.009 ms/call at N=2000
— consistent given the smaller N and ordinary machine variance. I did not re-run at N=2000 to get an
exact match; the header records the ticket's own N=2000 figure, not my N=200 spot-check.

## Comment wording fix (`coordinator-repo.ts`)

The cancel-path NOTE previously implied `pend`/`commit` avoid the doubled `findCluster` lookup
("they pay it once") — they do not; on a multi-peer cohort both pay the same doubled lookup for
`blockIds[0]`. Reworded to say theirs is CONSTANT (one block) where cancel's SCALES with N. No code
changed, only the comment.

# How to validate this

- `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/db-p2p test` — full suite,
  2683 passing / 50 pending (pre-existing) at the point I left it. The harness change (`createMesh`)
  is exercised by essentially every spec in this package, so this is the widest-blast-radius check.
- `yarn workspace @optimystic/quereus-plugin-optimystic build && yarn workspace @optimystic/quereus-plugin-optimystic test` —
  needs the db-p2p build first since it imports `@optimystic/db-p2p/testing` from `dist/`, not
  source. 800 passing / 13 pending (pre-existing) at the point I left it.
- Targeted: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cold-apply-cost.spec.ts" --reporter spec`
  from `packages/quereus-plugin-optimystic` — the diagnostic print line (gate 4's `it` block just
  above it) is the fastest way to eyeball the split between the complete and transactor-seam counts
  without re-deriving them.
- Targeted: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/mesh-harness-wrap-key-network.spec.ts" --reporter spec`
  from `packages/db-p2p` for just the new hook spec.

# Known gaps / things I did not do

- **I did not re-derive the 54/144/142 figures independently from scratch.** I trusted the ticket's
  own "Measured" section (which describes patching `findCluster` on the shared instance directly and
  attributing by stack frame) and verified that my `wrapKeyNetwork`-based re-measurement reproduces
  those exact numbers — which it does, byte-for-byte against the ticket's "Expected outputs" section.
  I did not independently re-derive the per-site breakdown table (`isResponsibleForBlock` 23/68/67,
  etc.) — I have no reason to doubt it, but a reviewer wanting that confirmed would need to
  re-instrument by hand.
- **The `0.009 ms/call` / `~1.3 ms per apply` figures in the accepted-tradeoff NOTE and gate 4's
  MEASURED comment are the ticket's own N=2000 measurement, not something I re-ran at that scale.**
  My own spot-check (N=200, above) is consistent in order of magnitude but not an exact
  reproduction. If a reviewer wants an exact re-measurement, run
  `N=2000 node packages/db-p2p/test/bench-findcluster.mjs`.
- **The three declined-optimization items in the ticket's "Decided" section (#4, "Not pursued")** —
  sharing one lookup between the proximity check and the consult inside `get`, and sending the
  cohort over the wire from `consolidateCoordinators` — required no code change per the ticket
  (it says "Not pursued", not "add a NOTE"), so I left no comment at either site. If review disagrees
  and wants those recorded as accepted-tradeoff NOTEs too, that's a small addition, not a redesign.
- **No behavior change was intended anywhere except the two test files and the new hook's identity
  default.** The two production-adjacent comment edits (`libp2p-key-network.ts`,
  `coordinator-repo.ts`) are comment-only; I did not add any assertions or tests that would catch a
  future accidental behavior change to those functions, since the ticket didn't ask for that.
- I did not run `db-p2p`'s `test:integration` suite (`OPTIMYSTIC_INTEGRATION=1`) — the ticket's scope
  is the in-process mesh harness and the coordinated-commit-path spec, neither of which is gated
  behind that flag, and the integration suite boots real libp2p nodes which is considerably slower.
