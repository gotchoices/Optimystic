description: One test runs the same transaction scenario at one to five machines and checks, at each size, what the documentation says should happen: every machine writes and reads, two machines race for one row, one machine goes unreachable, and every acknowledged row stays readable.
prereq:
files:
  - packages/db-p2p/test/transaction-node-count-sweep.spec.ts
  - packages/db-p2p/test/util/node-count-mesh.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts (comment only)
  - tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md (arm)
  - tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text.md (arm)
----

# What was built

`packages/db-p2p/test/transaction-node-count-sweep.spec.ts` runs on the in-process mesh (part of plain `yarn test`) at 1–5 machines. Each size gets one mesh configured the way a real deployment is (default replication factor 10, machine count declared only as `clusterPolicy.repairCorroborationClusterSize`) and four sequential phases (a failed phase fails the rest, via `sequentialPhases`):

1. Every node writes its own row as the coordinator of that write (`transactorDrivenBy` in `test/util/node-count-mesh.ts`), and every node reads every row. Durability is `local` at one machine and fully durable at two or more; every node's own storage holds every block.
2. Nodes 0 and 1 race one row (skipped by title at one machine): same first revision, no throws, every refusal conflict-shaped, no revision committed by two actions, each write lands or fails only with `SyncRetryExhaustedError`, and every node reads the last committed value.
3. The last node becomes unreachable (`setUnreachable`) and node 0 writes. Four and five machines: acknowledged with `majority` durability naming exactly the away node, and storage agrees. Two and three machines: refused with `Some peers did not complete: ` whose `cause` is the promise-phase super-majority shortfall with the expected numbers.
4. Every acknowledged row reads back from every reachable node.

The expected outcome per size is derived from the documented fractions (promise `ceil(0.75n)`, commit `floor(0.51n)+1`, durability strict majority) and cross-checked against a hand-written table and the policy the mesh resolves. A per-size table is printed at the end.

Findings from implementation (appended as arms, not new tickets): a refused write at two/three machines spends ~1 s in a cancel loop that cannot reach its own quorum (`debt-unpromotable-pending-records-need-a-sweep`); there is no typed field for "refused, a/n promises" so the spec parses message text (`debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`); two concurrent writers from different coordinators lose round one together every time — recorded as a measured sentence in the all-lose-round NOTE in `CoordinatorRepo.pendThroughCluster`.

# Review findings

**Checked:** the implement diff (`c38f7167`) read in full — spec, helper, the `coordinator-repo.ts` comment, both backlog arms; documented arithmetic against `packages/db-p2p/docs/cluster.md` (Phase 1/Phase 2), `docs/optimystic.md` § Deployment Sizes, `ClusterCoordinator` (`floor(n × simpleMajorityThreshold) + 1` at `src/repo/cluster-coordinator.ts:907`) and `cluster-policy.ts` defaults; every ticket/doc the spec cites exists (`6.5-docs-one-durability-bar-one-size-floor`, `implement/1.5-a-member-that-leaves-mid-session-and-returns`, `backlog/more-design/6.5-partition-healing.md`, `NetworkTransactor.MAX_CANCEL_ROUNDS`); `setUnreachable`/`transactorDrivenBy` semantics (asynchronous rejection so re-homing works, cohort membership untouched); mesh lifetime.

**Fixed inline (minor):**
- The spec's header comment claimed `cluster.md` states the commit bar as `floor(0.51 × n) + 1`; the doc says ">50%" and the formula lives in `ClusterCoordinator`. Comment corrected to say which is which.
- The race phase only checked that the *contested* revision had one winner. A loser that rebases and retries could in principle double-commit a later revision unseen. Now asserts no revision in the race was committed by more than one action.
- The one-away acknowledged branch checked storage holders against the strict-majority bar only; it now also requires at least as many holders as the write's reported `confirmed` count, so the number returned to the application is tied to storage fact.

**Validation after fixes:** `tsc --noEmit -p packages/db-p2p` clean; `yarn lint` clean; the sweep alone passed 3 of 3 runs (21 tests, 3.1–4.3 s); `yarn workspace @optimystic/db-p2p test` 2790 passing, 62 pending (unchanged, none added), 0 failing.

**Major findings:** none. No size contradicted the documented rule; the two real product-side costs found during implementation were correctly filed as arms on existing backlog tickets rather than new tickets.

**Tripwires / accepted tradeoffs:** meshes are never disposed — already covered by the accepted `NOTE:` at `createMesh` in `src/testing/mesh-harness.ts` (timers are unref'ed); not re-filed, revisit condition has not tripped.

**Known coverage gaps (reviewed, left as documented, no ticket):**
- Self-first routing is a test helper, not production proximity routing — deliberate, so each node's coordinating path is exercised; "writer is not the coordinator" and coordinator failover are covered elsewhere by proximity-routed specs, not here.
- Leaving-and-returning is owned by `implement/1.5-a-member-that-leaves-mid-session-and-returns`, which reuses this helper.
- Only one away node (the last) and one writer (node 0); only a two-writer race; round-one race outcome is reported, not asserted (correct — it is timing-dependent over real sockets).
- Phases share state, so `--grep` on a single phase fails; run a whole size.
- Refusal assertions depend on message text, intentionally, and are cross-referenced from the backlog arm.
