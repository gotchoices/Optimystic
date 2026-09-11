description: On a 16-node mesh where the cohort is narrower than the network, a Diary append sometimes reports success for revisions that no node stores, so another client reads the Diary back empty. The commit of revisions 2 and 3 of the Diary's log block succeeds through a coordinator whose cohort never held revision 1, and afterwards no node has revision 2 or 3, either committed or pending. This is an acknowledged write that was lost, not a replica shortfall.
prereq:
files:
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (the failing arm, "a Diary written through the transactor: replica placement per committed block")
  - packages/db-core/src/transactor/network-transactor.ts (`consolidateCoordinators` — the first append's two-block pend goes to one peer; later single-block pends route to a different coordinator at the double-hashed coordinate)
  - packages/db-p2p/src/repo/coordinator-repo.ts (the coordinator that acknowledges the r2/r3 commit; its cohort at the single-hashed coordinate never held r1)
  - packages/db-p2p/src/cluster/cluster-repo.ts (members asked to pend and commit an UPDATE to a block they do not hold, and what they answer)
  - packages/db-p2p/src/storage/storage-repo.ts (commit of an update whose base revision is absent: what it stores and what it returns)
  - tickets/blocked/writer-and-servers-disagree-on-where-a-block-lives.md (the routing divergence that SETS UP the placement; this ticket is the lost-acknowledgement part, which must not depend on that decision)
difficulty: hard
----

# Acknowledged Diary commits land on no node

## Failing test

`packages/db-p2p/test/routing-key-convention-divergence.spec.ts` > `routing-key convention: writer H(H(id)) vs server H(id)` > `on the mesh harness (16 nodes, responsibilityK 4, clusterSize 4)` > `a Diary written through the transactor: replica placement per committed block`

```
AssertionError: expected [] to have the same members as [ 'entry-0', 'entry-1', 'entry-2' ]
```

The mesh in that spec now has seeded keys (`createMesh(..., { keySeed: 16 })`), so its geometry is the same every run. It was seeded to fix a different arm's flaky statistical bound. The Diary's log-block id is still random per run, so this arm fails about 1 run in 5–8: 2/8, 3/16 and 1/16 in three batches. Unseeded, it failed 0/8, but the defect depends only on geometry, so random keys hit it too, just less often.

Reproduce: `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/routing-key-convention-divergence.spec.ts` from `packages/db-p2p`, repeated.

## What a failing run does (probe on the seed-16 mesh; peer ids shortened to the last 5 characters)

```
pend@uPY4p   diverg,aNvWbk -> true     # first append: header + log block in ONE pend, coordinated by uPY4p
commit@uPY4p aNvWbk rev=1  -> true
commit@uPY4p diverg rev=1  -> true
pend@FrqMX   aNvWbk        -> true     # appends 2 and 3: log block alone, now routed to FrqMX
commit@FrqMX aNvWbk rev=2  -> true
pend@FrqMX   aNvWbk        -> true
commit@FrqMX aNvWbk rev=3  -> true

block aNvWbk: writerCohort (H(H(id))) [FrqMX, 7PpSe, oq5hB, uPY4p]
              serverCohort (H(id))    [Twpri, wpKFr, dj2QS, 752T5]
              holders                 [uPY4p@r1]             # nothing at r2 or r3, anywhere
raw state on every node: only uPY4p has {"latest":{"rev":1}}, "pendings":[] — no node has a pending r2/r3
```

- Revision 1 of the log block exists on exactly one node, `uPY4p`. That node coordinated the combined pend because it is in the header's cohort, but it is in neither of the log block's cohorts at the server's coordinate.
- Revisions 2 and 3 are each acknowledged `success: true` by the coordinator (`FrqMX`), yet afterwards no node holds them, and no pending record for them survives anywhere.
- A second, independent transactor then reads the Diary back as `[]`.

In passing runs the log block lands on its full server-side cohort plus the coordinator, and reads back complete. Which kind of run you get depends only on where the random log-block id falls on this ring.

## Root-cause hypothesis

Two separate faults stack up:

1. **Placement.** The writer's routing coordinate (`sha256(sha256(id))`) differs from the servers' (`sha256(id)`). The first append's two-block pend is consolidated onto one coordinator, so the log block's r1 is stored where neither convention's cohort will look again. This is the blocked ticket's Finding A/B and needs its human decision.
2. **Lost acknowledgement.** This is the part for this ticket, and it is a defect under any routing convention. An update commit (r2, r3) is run by a coordinator whose cohort holds no base revision of the block. It reports success even though no member materializes the revision. Somewhere between `CoordinatorRepo` commit, the cluster transaction and `StorageRepo.commit`, either "applied nothing because the base is missing" is counted as success, or the pend is admitted and then silently dropped. Find which of these it is first. The raw-state dump above shows no surviving pending record, so the record was either never written or was deleted without the commit failing.

## Design constraints

- A commit must never be acknowledged unless at least a quorum of the cohort durably holds the committed revision. An update whose base the cohort lacks has to fail, or has to reconcile the base from wherever it lives before it commits. It must not quietly succeed. The fix must not rely on the routing convention being corrected: a partition or churn can put a coordinator in the same position.
- Do not "fix" this by choosing a mesh seed on which the arm passes, or by loosening the read-back assertion. The arm is the regression pin.
- When the fix lands, the failing arm must pass reliably at `keySeed: 16`. Run it at least 30 times and remove the ledger entry in `tickets/.pre-existing-known.md`. Add a deterministic unit-level pin for the lost acknowledgement, with fixed block ids and no random Diary ids, next to the storage/cluster tests.
- Cross-cutting: none expected. No byte format, determinism edition or migration change, unless the fix adds a new refusal reason to a wire-visible result type. In that case, update its serialization vectors.
