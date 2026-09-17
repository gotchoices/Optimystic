description: After a machine commits a write, its background "make sure my group has copies" check treats every freshly written block as new and pushes it to the other group members, who already stored it as part of the commit. Over a relay, one insert sets off dozens of useless transfers. A commit that every member confirmed should count as those members already holding the block.
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`cohortPeers` memory ~line 132–190, `recordGrowthOutcome` ~line 282, grown arm ~line 436–505, `connection:open` trigger ~line 227)
  - packages/db-p2p/src/libp2p-node-base.ts (`ownedBlocks` fed from `onAnyCollectionChange` ~line 1134–1150; rebalance wiring ~line 1327–1400)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`commit` durability: `cohortWriteDurability` ~line 3060, `isDurableMajority` ~line 3111)
  - packages/db-p2p/src/cluster/spread-on-churn-monitor.ts (the other "push on churn" sender; check it for the same pattern)
repro: static
----
# Rebalance pushes freshly committed blocks back to members that already hold them

## Observed

In sereus's headless two-party run (party B on the `storage` profile, party A on `transaction`, connected only through a relay), **one** insert by A set off 32 `/db-p2p/sync` and 15 `/db-p2p/block-transfer` streams from B. When B inserted, up to 20 `/db-p2p/block-transfer` streams followed. Those streams were counted on A's relay socket. Which code opened each one was inferred from reading the code, as described below.

## Mechanism (read from code)

- Every block a commit touches is added to `ownedBlocks` (`libp2p-node-base.ts`, via `storageRepo.onAnyCollectionChange`).
- `RebalanceMonitor` keeps a per-block `cohortPeers` set: the peers it has *confirmed* are co-responsible. A block with no entry reports the whole non-self cohort as `grown`. That rule heals the founder case, where a machine wrote alone and must push its data out.
- The grown reaction pushes each such block to those peers. Only `recordGrowthOutcome` adds peers to `cohortPeers`, so the memory fills only after a push.
- A check runs on `connection:open`, throttled by `minRebalanceIntervalMs`, and on the growth recheck timer. A relay link that reconnects often therefore runs the check often.

The result: each freshly committed block looks "grown" at the next check. B pushes it to A, even though A took part in the commit that created it.

It is not the under-replication drain. With 2 members, `isDurableMajority` requires both, so every acknowledged commit is `full` and nothing enters the ledger.

## Fix

When a commit is acknowledged, seed the rebalance memory. Record as confirmed holders the cohort members that **both** signed a commit approval **and** reported applying the block. Commit durability already derives exactly that set (`cohortWriteDurability` holders in `coordinator-repo.ts`). Feed it to the monitor through `recordGrowthOutcome` or a sibling method such as `recordCommittedHolders(blockIds, peerIds)`.

- **Trust.** Apply reports are unsigned advisory data, so a lying member could suppress a repair push to itself. Restricting to peers that also signed the commit approval limits the harm to a member lying about its own copy. That member is already trusted with the commit. A later read-repair or reconcile still heals it.
- **Members that are not coordinators.** A member that applied a commit coordinated by someone else receives no durability report. Seed that node's memory from the consensus record's signers when the commit applies (in `cluster-repo.ts`, the commit arm of `applyConsensusOperation`). Otherwise B, receiving A's commits, still pushes A's blocks back to A.
- **Other senders.** Check `SpreadOnChurnMonitor` for the same "no memory ⇒ push to everyone" behaviour. The 32 `/sync` streams per A-insert may come from it, or from reconcile's archive fetches (`fetchArchive`), rather than from rebalance. Instrument first. If the sync streams come from a different site, split that part out rather than guessing.

## TODO

- Instrument: in a mesh-harness two-member test (`packages/db-p2p/src/testing/mesh-harness.ts`), count block-transfer pushes and sync requests caused by one commit, then force a `connection:open` or recheck. Record the baseline.
- Seed confirmed holders from acknowledged commits, on the coordinator from durability holders and on members from the commit record's approving signers.
- Keep the founder case working: a block written with no reachable peers must still be reported grown and pushed once peers appear. Keep the existing rebalance-monitor specs green.
- Identify the source of the `/db-p2p/sync` burst after a commit. Fix it here if it is the same pattern, otherwise file it with the measured count.
- Test: after a full-quorum commit in a two-member mesh, a subsequent rebalance check pushes zero blocks for that commit.
