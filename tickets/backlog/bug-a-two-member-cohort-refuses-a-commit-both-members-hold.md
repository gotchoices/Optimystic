description: In a group of two machines, a write is often refused as "not safely stored" even though both machines end up storing it, because one machine checks for the write before the other has finished saving it. Clients then retry writes that had already succeeded.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusOperation` commit arm, `reconcileDivergentCommit`, `durableCommitVerdict`)
  - packages/db-p2p/src/cluster/reconcile-block.ts (`reconcile:no-rev-quorum`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`commit` local-executed arm ~2549–2590, `refuseCommitNotDurable`)
  - packages/db-p2p/src/storage/storage-repo.ts (`commit` missing-base refusal, `dropUnpromotablePendings`)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Once the lost-write defect is fixed, the refusal only costs a retry round, and waiting for the peer before judging durability adds latency and a new timeout to every commit that takes this path.
----

# What happens

Seen in sereus's two-machine strand scenario (`strand-chat-participants-converge.integration.ts`, "writes IMMEDIATELY"), on 2026-09-16 at optimystic HEAD `17440946`. The joining machine coordinates a commit whose log tail block it has **never stored locally** (it read that block from the host).

1. Consensus reaches commit on both members.
2. The joiner's own member applies first. `StorageRepo.commit` refuses with `missing-base-revision … local latest none is not the declared base 1 of rev 2` and drops the pending record.
3. `reconcileDivergentCommit` pulls the block from the only other member, the host. The host has **not applied yet**, so nothing is restored.
4. `durableCommitVerdict` re-reads local storage, finds nothing, and retains a refusal.
5. The host applies a few milliseconds later and holds the revision.
6. The coordinator counts 1 holder of 2 → `commit-not-durable`. The client cancels and retries.
7. Later, replication (`replica:save`) brings the block to the joiner anyway.

In the logged failing runs, steps 2–6 took about 10–40 ms. The refusal appeared in every failing run and in some passing ones; in runs where the joiner already held the block it never appeared.

Before `implement/a-write-whose-log-entry-landed-alone-is-reported-saved` lands, this refusal is what turns into a silently lost write. After that fix it should cost only a retry. It is still a wrong answer ("not durable" for a write both members hold), and it makes a two-member cohort's writes pay an extra round whenever the coordinator lacks a base block.

# Open questions for whoever picks this up

- Should the coordinating member's reconcile wait for, or retry against, the peers that voted to commit, before settling its verdict? Or should the durability gate re-read the members' holdings once after all commit responses are in?
- Why did the joiner never store the log tail block while it did store the leaf (`cluster-fetch:synced`)? If reads through a remote coordinator never acquire the block locally, every first write by a newly joined member goes through this refusal.
