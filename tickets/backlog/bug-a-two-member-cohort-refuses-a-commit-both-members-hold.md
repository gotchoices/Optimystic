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

# Further evidence: sereus headless relay run, 2026-09-17 (optimystic `ab67fa47`)

From sereus's round-trip report, filed here as an arm rather than a new ticket. Two single-node parties connected only through a relay: B on sereus's `storage` profile, A on `transaction`.

- **No proxy, 3 runs:** 1 failed on a concurrent insert pair with `TornActionError: collection default/app/Data: action … is torn at rev 7 — its log entry is stored but block(s) … do not hold that revision, and the write cannot be finished: stale revision`.
- **Through a delaying TCP proxy, 4 runs:** all failed, 3 with `Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)` and 1 with `cohort-unreachable` on a read. This is weaker evidence, because a connection gater on A was also refusing direct dials to the relay port.

**Likely link (repro: static, from reading the code, not reproduced here).** The torn error is what this ticket's refusal becomes when a rival write fills the gap:

1. Writer X's tail commit lands at rev 7.
2. X's sweep commit of a non-tail block is refused (for example `commit-not-durable`, as described above), and X cancels.
3. The concurrent writer Y refreshes and commits that block at rev ≥ 7.
4. X's refresh finds its own entry. `Collection.completeOwnEntry` re-sends at rev 7, and the member's pend validation (`cluster-repo.ts` `validatePendOperations`) answers `stale revision: block … at rev N`.
5. `tornFromRefusal` reports that answer as a `TornActionError`.

That is correct reporting of a write that really was torn. The defect sits upstream, in step 2.

**To confirm:** in a two-member mesh-harness test where the coordinator lacks the base of a non-tail block, race two inserts and look for `missing-base-revision` or `commit-not-durable` on the first writer's sweep just before the torn error.

The `1/2 approvals` shortfall through the delayed relay may be a separate cause: a promise or commit deadline exceeded on a slow link (see the `LATEST_QUERY_TIMEOUT_MS` NOTE in `coordinator-repo.ts` and the RPC deadlines in `db-p2p/src/rpc-deadline.ts`). Check the member's log for a late arrival before attributing it to this ticket.

# Update 2026-09-17: the "Further evidence" link above is refuted

The fix ticket `concurrent-inserts-from-two-members-tear-and-some-torn-writes-land` reproduced sereus's torn error in-process: a 2-member mesh, a few milliseconds of message latency, and concurrent inserts. The debug trace shows no `missing-base-revision` refusal and no `commit-not-durable` refusal before the tear. The writer's non-tail commit lost a conflict race against the *other* writer's cancel of its own refused pend. `operationsConflict` treats that cancel as a rival.

- **Where it went:** the tear is now `implement/cancelling-a-refused-write-blocks-another-writers-commit`, and the "reported torn but saved" answer is `implement/a-write-reported-torn-can-already-be-saved`.
- **What stays here:** this ticket's own defect, a commit refused as not durable while both members end up holding it. It is still open and unaffected, and its confirmation step is unchanged.
- **The proxied relay run:** the `1/2 approvals` shortfall through the delaying proxy was not examined by that work.
