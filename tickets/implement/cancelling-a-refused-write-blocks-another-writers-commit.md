description: When two machines write to the same table at once, the loser cancels its refused attempt, and the cancel is treated as a competing write. On a two-machine group it knocks out the winner's in-progress save, which leaves the winner's write half-saved and reported as failed. A cancel only removes its own writer's reservation, so it should never compete with another writer.
architecture: docs/correctness.md
files:
  - packages/db-p2p/src/cluster/race-resolution.ts (`operationsConflict`: the rule to change)
  - packages/db-p2p/src/cluster/record-operations.ts (`getActionId`, `getAffectedBlockIds`: a cancel's blocks come from `cancel.actionRef.blockIds`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`findConflict`: the only caller; `getTransactionPhase` turns a conflict into a conflict vote)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`ConflictRaceLostError` / `cluster-tx:conflict-race-lost`: how the loser's commit fails)
  - packages/db-p2p/test/race-resolution.spec.ts (unit tests for `operationsConflict`)
  - packages/db-p2p/src/testing/mesh-harness.ts (`createMesh`: the regression test adds latency on top of it)
  - docs/correctness.md ("Case 2: Concurrent arrival": says conflicts are detected by block overlap alone)
difficulty: medium
----

# What goes wrong

Sereus reported that two machines inserting into one table at the same moment often fail with `TornActionError` (7 of 16 concurrent pairs), and that some writes reported as torn were actually saved. The report is in `../sereus/tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md`, under "Error tally". This ticket fixes why the writes tear. The sibling ticket `a-write-reported-torn-can-already-be-saved` fixes the wrong answer given for the ones that land anyway.

## Reproduced in-process (repro: verified)

The in-process mesh reproduces it once cluster messages take a few milliseconds. No sereus storage profile, relay, or missing blocks are needed. The setup:

- `createMesh(2, { responsibilityK: 2, clusterSize: 2, superMajorityThreshold: 0.67 })` and `buildNetworkTransactors`.
- One `Tree` per node on the same collection id.
- A seed row written from node A, then `treeB.update()`.
- Four reps of `Promise.allSettled([treeA.replace(...), treeB.replace(...)])` with distinct keys.

The delay wrapper, applied to every node right after `createMesh`:

```ts
const DELAY = () => 2 + Math.floor(Math.random() * 15);
for (const n of mesh.nodes) {
	const inner = n.clusterMember;
	n.clusterMember = { update: async (r) => {
		await new Promise(res => setTimeout(res, DELAY()));
		const out = await inner.update(r);
		await new Promise(res => setTimeout(res, DELAY()));
		return out;
	} } as any;
}
```

This slows only REMOTE deliveries. The mesh's cluster client looks up `target.clusterMember` on every call, while each coordinator keeps the member object it was built with and calls its own member directly.

**Measured** (no delay and no failures before; with the delay):

| Variant | Pairs | Failed pairs |
|---|---|---|
| Plain mesh, no delay | 20 (5 runs × 4) | 0 |
| Delay | 8 | 4 |
| Delay, B's storage emptied and B restarted before the pairs | 8 | 1 |
| Delay, with the change below | 32 | 0 |

Failures hit both A and B, not only B. The error text matched sereus's: `… is torn at rev N … stale revision: block X at rev N+1, requested rev N (block X is at rev N+1)`. Some failures instead read `… the re-send was refused` (the `completion-refused` reason).

## The mechanism, from a debug trace

The trace used `debug` `optimystic:*`, with peer ids replaced by A and B. It was written to `tickets/.logs/concurrent-inserts-trace.log`, which the runner prunes. Writer B is `z422…` and writer A is `zNav…`.

1. B's pend (tail + leaf, rev 2) succeeds.
2. A's pend is refused: `pending conflict: block <leaf> held by unresolved action(s) z422…`. A then **cancels its own refused pend**. Each cancel is its own cluster transaction, and it names both blocks.
3. B commits the log tail at rev 2 on both members.
4. B's sweep commit of the leaf now meets A's cancel transactions in each member's in-flight table. `ClusterMember.findConflict` asks `operationsConflict`, which answers "conflict" because the two messages share a block and name different actions. Each member votes `conflict` on B's commit: `Conflict race lost: 2/2 member(s) hold a conflicting winner (0/2 approvals)`. With two members, one conflict vote is already enough to lose.
5. B cancels the leaf, refreshes, finds its own log entry, and re-sends the attempt (`Collection.completeOwnEntry`). Each re-send collides with A's next cancel in the same way. In the second trace this happened four times in a row, from about 1.8 s to 6.6 s.
6. A eventually pends and commits the leaf at rev 3. B's next re-send is refused as stale, and B reports `TornActionError`.

The cancels also lose races to each other and to pends (`coordinator-repo:cancel-error … Conflict race lost` throughout the trace). Losing a race leaves pending records standing longer, which makes the whole contention last longer.

# The change

A message whose every operation is a `cancel` must not conflict with any message of a **different** action. Messages of the same action are already excluded.

Why this is safe:

- A cancel of action X only deletes X's pending records on the named blocks (`StorageRepo.cancel`). It never changes a block's revision, so it does not reorder anyone's revision.
- **Commit of Y:** a commit of a different action Y never reads X's pending record (it was checked at Y's pend).
- **Pend of Y:** storage and `validatePendOperations` already refuse a pend of Y while X's record exists, and the answer is the same whichever of the two arrives first. The worst case is a retry, never a wrong result.
- **Invalidation:** it writes compensating revisions and does not touch pending records.

Removing the conflict also means a cancel can no longer abort another transaction's reservation (`race-accept-incoming`) and cannot itself be aborted.

Before you settle the shape: RepoMessages are single-operation in practice. The rule should still be stated over the whole operation list ("every operation is a cancel"), so that a mixed message stays conservative.

After this change, check whether any tearing remains under the delay wrapper. It measured 0 of 32 pairs. If a longer run shows residual tears, trace them before widening the rule. For example, a commit of X losing to a pend of Y is a different question: that pend will be refused by storage anyway, but Theorem 9's approvals-first ordering applies there.

# Related

- `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold`: its "Further evidence" arm guessed, from code reading, that this torn error comes from a `missing-base-revision` / `commit-not-durable` refusal. The trace above shows neither. That ticket's own bug (a commit refused while both members end up holding it) is separate and stays open. A note has been added to it.
- `backlog/feat-occ-priority-reservation` also touches `findConflict`, but about fairness between real rivals. That work does not overlap with this change.
- The profile difference sereus observed (a `storage` joiner fails, a `transaction` joiner did not in 4 pairs) is not needed to reproduce this. The likely explanation is timing (arachnode restore and rebalance work on the storage node). The control sample was small.

# TODO

- Change `operationsConflict` so that a cancel-only message never conflicts with a different action's message. Update its doc comment to state the commutation argument above.
- Add unit cases in `test/race-resolution.spec.ts` covering a cancel against a pend, a commit, a cancel and an invalidate of other actions on a shared block (no conflict), and pend against pend and commit against pend of different actions (still a conflict).
- Add a mesh regression spec (e.g. `packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts`). Use the latency wrapper above, 2 members, and at least 3 runs × 4 concurrent pairs, and assert that every `replace` resolves and each row is readable from a fresh `Tree` on the other node. Confirm it fails before the change: 4 of 8 pairs failed in the measurement. Keep its runtime modest (the measured 32-pair run took about 17 s without the emptied-storage variant). If it is too slow for `yarn test`, cut the pairs rather than gate it.
- Update docs/correctness.md "Case 2: Concurrent arrival" to say that cancels are excluded from conflict detection, and why.
- Run `yarn workspace @optimystic/db-p2p test`, and the quereus plugin's two-node sweeps (`two-node-index-interleaving-sweep`, `two-node-multi-collection-commit`), since they exercise concurrent contention.
