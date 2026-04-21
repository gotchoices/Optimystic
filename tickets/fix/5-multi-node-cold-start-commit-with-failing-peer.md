description: 5-node cold-start `tree.replace` (first-write-ever) fails during commit when one peer is unreachable at boot, even though super-majority is satisfied on the pend phase. Surfaced by Phase 3 of ticket-7.
dependencies:
  - `packages/db-p2p/test/fresh-node-ddl-multi.spec.ts` (Scenario B — currently `describe.skip` pending this fix).
  - Related but distinct: `tickets/complete/5-coordinator-repo-pend-blockid-extraction.md`, `tickets/complete/5-get-block-throws-on-pending-only-metadata.md` (other cold-start/pending-metadata class bugs).
files:
  - packages/db-core/src/transactor/network-transactor.ts (`commit` phase — "Some peers did not complete" aggregator at line ~487)
  - packages/db-p2p/src/repo/coordinator-repo.ts:246 (CoordinatorRepo.commit)
  - packages/db-p2p/src/storage/storage-repo.ts:209 (StorageRepo.commit — source of the "Pending action … not found" throw)
  - packages/db-p2p/test/mesh-harness.ts (`failingPeers` fault injection)
  - packages/db-p2p/test/fresh-node-ddl-multi.spec.ts (Scenario B — reduced repro)
----

## Reduced repro (already in source, skipped)

`packages/db-p2p/test/fresh-node-ddl-multi.spec.ts` Scenario B:

```
mesh = await createMesh(5, { responsibilityK: 5, clusterSize: 5, superMajorityThreshold: 0.6 });
mesh.failures.failingPeers = new Set([mesh.nodes[4].peerId.toString()]);
const treeA = await Tree.createOrOpen<number, TestEntry>(transactorA, 'multi-5-cold-start', e => e.key);
await treeA.replace([[42, { key: 42, value: 'despite-E-down' }]]);   // <-- fails here
```

Super-majority of 5 at threshold 0.6 = 3 required. With 4 reachable peers, pend should succeed and commit should too. Instead:

```
Error: Some peers did not complete: <peerE>[blocks:1](in-flight)
  cause=Pending action <actionId> not found for block(s): <blockId>
Caused by: Error: Pending action <actionId> not found for block(s): <blockId>
  at StorageRepo.commit (packages/db-p2p/src/storage/storage-repo.ts:209)
  at async CoordinatorRepo.commit (packages/db-p2p/src/repo/coordinator-repo.ts:246)
  at async Context.<anonymous> (test/fresh-node-ddl-multi.spec.ts:109)
```

## What the stack trace implies

- Pend phase: peer E's `ClusterClient.update` throws (mesh mock honors `failingPeers`); the remaining 4 peers approve, super-majority met, pend reports success.
- Commit phase: the NetworkTransactor still tries to talk to peer E. E has no pending action (the pend never reached it), so `StorageRepo.commit` throws "Pending action … not found." NetworkTransactor marks E as `in-flight` and the overall commit fails rather than tolerating the super-majority success.

Two possibilities to investigate before fixing:

1. **Commit phase missing super-majority tolerance**: the pend path has `processBatches`-with-retry semantics; the commit path may be waiting on all peers in the batch. Verify `network-transactor.ts::commit` (~line 405+) vs the pend aggregator (~line 310+).
2. **Commit phase retargets to a fresh cluster**: coordinator cache / `findCluster` may re-include E on commit even though pend-time cluster excluded it. Check whether `recordCoordinator` / cluster-pinning carries through to the commit.

## Non-goals

- Do not weaken `failingPeers` semantics in the mesh mock to work around this — the mock is correct (it simulates a genuinely unreachable node).
- Do not change super-majority math. The arithmetic (3-of-5 at 0.6) is the intended contract.

## Expected outcome

- Scenario B passes with `describe.skip` removed from `fresh-node-ddl-multi.spec.ts`.
- No regression in mesh-sanity's "promise phase failure with default threshold causes transaction to fail" — that test (3-of-3 at 0.75, 1 peer down → pend fails) must still fail pend as it does today.

## TODO

- [ ] Reproduce locally (run `yarn test:db-p2p --grep "Scenario B"` after flipping `describe.skip` → `describe`).
- [ ] Diagnose whether the failure is in the commit-phase consensus threshold or in cluster-pinning between pend and commit.
- [ ] Implement fix in `packages/db-core/src/transactor/network-transactor.ts` (or wherever root cause lives).
- [ ] Remove `describe.skip` in `fresh-node-ddl-multi.spec.ts::'Scenario B'`.
- [ ] Confirm mesh-sanity suite still passes end-to-end.
