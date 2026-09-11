description: On a network of several machines, a read of a record that has not been created yet still asks the other machines every single time; a one-machine deployment now remembers the answer for ten seconds, but doing the same with several machines served a just-written record as missing, so it was switched off until a machine can tell when another machine's write reaches it.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`settledAbsences`, `fetchBlockFromCluster`'s `!corroborated` exit returning `absenceSettled: false`, `forgetSettledAbsences`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusOperation` — the cohort-member write path that bypasses the coordinator)
  - packages/db-p2p/src/storage/storage-repo.ts (`get` reports a pending-only block as `{ state: {} }`, hiding the in-flight write)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts
  - packages/db-p2p/test/fresh-node-ddl-multi.spec.ts (Scenario B — the regression gate)
tradeoffs: Pure performance for multi-machine deployments that re-read absent records; the per-read consult is what they already paid before, and any memo here re-opens a read-your-writes hole unless every write path that reaches this node's storage can invalidate it.
----
# A cohort member remembers a settled absence

## Background

`CoordinatorRepo.get` consults a block's cohort (the machines responsible for it) whenever the block is missing locally. Ticket `a-block-we-do-not-hold-is-consulted-on-every-read` let a coordinator remember a confirmed absence for one `readRepairWindowMs` (10 s default) so repeated probes of a not-yet-created record cost one consult per window instead of one per read. Review restricted that memo to the case where `findCluster` returns only this node, because the multi-peer version broke read-your-writes.

## The defect the multi-peer memo had (verified)

With the memo armed on the multi-peer "every member answered nothing" exit, `packages/db-p2p/test/fresh-node-ddl-multi.spec.ts` Scenario B (5 nodes, one down) failed 5 of 20 runs; with the memo disabled, 0 of 20. A diagnostic log showed one cohort member serving the memo for the tree header block after another node's commit of it was acknowledged:

- Node X settles the header block's absence while node A's `createOrOpen` probes it.
- A's write goes through another coordinator. X takes part as a cohort member via `ClusterRepo.applyConsensusOperation`, which calls `storageRepo.pend` / `storageRepo.commit` directly — never `CoordinatorRepo.pend/commit`, which is where the memo is cleared.
- The commit is acknowledged at super-majority; members that have not committed yet receive it later (`ClusterCoordinator.scheduleCommitRetry`). Until then X holds at most a pending record, and `StorageRepo.get` reports a pending-only block with no context as `{ state: {} }`, so X still reads the block as missing and the memo serves an authoritative absent.
- Node B reads through X inside the window and gets nothing.

Before the memo, X's read consulted the cohort, saw the other members' claim, and promoted its pending.

## What a fix has to provide

Any write of a block that reaches this node's storage — coordinated here or arriving as a cohort member — must invalidate the memo before the writer can be acknowledged, or the read path must be able to see that such a write is in flight. Candidate shapes (not decided):

- Storage-level: `StorageRepo.get` exposes pending records for a block with no committed revision (today it returns `{ state: {} }`), and a memo is ignored while the block has pendings. Watch the many specs and `NetworkTransactor` checks that expect an absent to be exactly `{ state: {} }`.
- Write-path signal: the member write path (or storage) notifies the coordinator of every pend/commit per block id, so the invalidation lives with every writer rather than with one of them.

A member that received neither the pend nor the commit when the writer was acknowledged remains possible; that residual is the same one-window bound a held block's content already has for a missed commit, and should be stated as such.

## Acceptance

- Scenario B of `fresh-node-ddl-multi.spec.ts` passes in a loop (say 40 runs) with the multi-peer memo armed.
- The three-member cases in `coordinator-repo-absence-window.spec.ts` flip back to "settles for one window", plus a case where a cohort-member pend lands inside a settled window and the next read consults.
