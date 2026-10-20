description: When one machine of a group writes a block and the other machine stores that write as part of the group's agreement, the second machine still treats its copy as unchecked and asks the first machine about it on the very next read. Count a write this machine just stored by group agreement as a fresh check of its copy, the same way a write it coordinated itself already counts.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember`, `retainCommitVerdicts`, `reportBlockHolders`, `ClusterMemberComponents`), packages/db-p2p/src/repo/coordinator-repo.ts (`markBlocksSeen`, `commitQuorumRulesOutRivals`, `lastSeenCommitMs`, the comment above `readRepairBlock`), packages/db-p2p/src/libp2p-node-base.ts (`clusterMember(...)` and `coordinatorRepoFactory(...)` wiring), packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md, docs/transactions.md
----

# A member that applied a commit counts its copy checked

GitHub [#43](https://github.com/gotchoices/Optimystic/issues/43), arm 3 (split out of plan ticket `feat-a-cohort-consult-batches-blocks-per-peer`). Independent of the two consult tickets (`a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead`, `a-cohort-consult-asks-each-peer-about-all-its-blocks-at-once`); they touch the same file but not the same methods.

## Today

The lazy read-repair window is armed by `CoordinatorRepo.markBlocksSeen`, which writes the per-block `lastSeenCommitMs` stamp `shouldReadRepair` reads. Its writers are all inside `CoordinatorRepo`: the consult exits in `fetchBlockFromCluster`, and the commit paths (`commitThroughCluster`, `tolerateLocalCommitDivergence`, `commitSolo`), each gated on `commitQuorumRulesOutRivals(approvals, observedCohortSize)`.

A commit this node takes part in as a **cohort member** — another machine coordinated it, and this node's `ClusterMember` applied it through `ClusterService` → `ClusterMember.handleConsensus` → `applyConsensusCommits` → `StorageRepo` — never passes through `CoordinatorRepo`. So on a two-member group where the other machine writes, every block it writes is unstamped here, and the next read of each (past the stamp, which does not exist) starts a consult: a `sync` request to the machine that just wrote it, asking whether there is anything newer than what it just sent. #43 measured about 0.9 background `sync` requests per `NetworkTransactor.get` on such a group.

## Design

A member that durably applied a consensus commit has the same evidence the coordinator has when it stamps after its own commit: the record carries the cohort's commit approvals, and when they are a strict majority of the full cohort, no rival can have committed at that revision (`commitQuorumRulesOutRivals`'s argument). So the member's apply stamps the block by the same rule.

- **`ClusterMember`** gains an optional component `onCohortCommitApplied?: (applied: CohortCommitApplied) => void`, where
  ```ts
  /** A consensus commit this member now holds durably: its blocks, and the record's commit-approval
   *  count over the cohort it ran on — what `CoordinatorRepo.noteCohortCommitApplied` weighs. */
  export interface CohortCommitApplied { blockIds: readonly BlockId[]; approvals: number; cohortSize: number }
  ```
  defined in `cluster-repo.ts` beside `BlockHoldersSink`. It is called from `retainCommitVerdicts` at exactly the place `reportBlockHolders` is called — for each operation that now succeeds and did not before — so it fires on a durable apply and on the later success of a behind-refused commit's reconcile (`reconcileRefusedCommit`), and never on a refusal. `approvals` is the count of `approve` commit votes from peers in `record.peers` (the set `reportBlockHolders` already computes — share it rather than computing it twice); `cohortSize` is `Object.keys(record.peers).length`. A throwing sink is caught and logged, as `reportBlockHolders` does.
- **`CoordinatorRepo`** gains `noteCohortCommitApplied(applied)`: when `commitQuorumRulesOutRivals(applied.approvals, applied.cohortSize)`, `markBlocksSeen(applied.blockIds)`; otherwise nothing. Same denominator rule as the coordinator's own commits (the declared `repairCorroborationClusterSize` maxed with the observed cohort), so the member never arms on evidence the coordinator would refuse — in particular an undeclared two-machine group arms neither (the declared size falls back to `clusterSize`), by the same design. Like the commit-path stamps it records no floor, which clears a recorded `floorConsulted` — correct, since a commit is newer evidence than any floor consulted under before it.
- **Wiring** (`libp2p-node-base.ts`): the member is built before the coordinator, so bind late, the way `onBlockHolders` binds to `blockHoldersTarget`: a sink that forwards to the coordinator once it exists. The mesh harness wires the same sink between each node's member and coordinator, so mesh specs see production's freshness.

On the coordinating node both the member's apply and the coordinator's own commit may stamp the same blocks moments apart; that is harmless (the later stamp wins, both say the same thing).

### What is deliberately NOT a stamp: received pushes

The plan this ticket came from also named a certified pushed block (`BlockTransferService.handlePush`). Declined: a push carries the revision the SENDER holds, and the under-replication drain and the growth push deliver it whenever the receiver becomes reachable — possibly long after newer revisions committed without this node. A verified proof says that revision was committed once, not that nothing newer exists now; the coordinator's own commit stamp is sound only because "now" is the moment the majority committed. Record this as an accepted-tradeoff `NOTE:` at `noteCohortCommitApplied`: a pushed replica stays unstamped, so its first read past the push consults once; revisit if pushes dominate a profile, with a stamp gated on the push's proof being for the revision the sender committed within the window.

### Stamps and local writers

The comment above `readRepairBlock` records the absence-memo lesson: a remembered *absence* must be cleared by every writer of local storage, and nothing could guarantee that. A freshness stamp is the opposite direction — it says "this copy matched the cohort at a past moment", and a local write only makes the copy newer, never staler — so it needs no clearing by writers, and adding a writer of the stamp from outside the class is safe. Say this in the comment on `noteCohortCommitApplied`, so the next reader does not have to rederive why one memo must be cleared by writers and this one need not be.

### The freshness debt ticket

This is the first writer of `lastSeenCommitMs` outside `CoordinatorRepo`'s own methods. Append a short measurement section to `tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md` (re-measure with `wc -l packages/db-p2p/src/repo/coordinator-repo.ts` and state the count): the window's stamp now also has an external writer (`ClusterMember` via `noteCohortCommitApplied`), which the extraction's collaborator must own as an entry point.

## Edge cases & interactions

- **Below-majority record** (a downsized or partly enrolled cohort): no stamp — the next read consults as today. Test.
- **Behind member whose apply was refused and then reconciled**: stamps when the reconcile turns the verdict into a success, as `reportBlockHolders` reports then. By inspection (same call site).
- **A refused apply that stays refused, an ahead-shaped refusal, a propagated fault**: no stamp. By inspection — only a now-successful verdict reaches the sink.
- **Multi-collection batch records** (`a-consensus-record-carries-several-collections-of-one-action`): each operation that succeeds stamps its own blocks; one that is refused stamps nothing. By inspection.
- **The unsettled-claim memo** (`unsettledAheadClaims`): untouched; `flagUnconfirmedCurrency` retires it on the next read once the served revision reaches the claim, as it does after any local landing. By inspection.
- **`readRepairMode: 'paranoid'` / `'off'`**: the stamp is read only under `'lazy'`; no behaviour change elsewhere. By inspection.
- **Silent-consult holds** (`silentConsultHolds`): untouched; a hold still gates window consults until it ends. By inspection.
- **Floors**: a floored read of a stamped block below the floor still consults (`floorDemandsConsult` compares the floor to the recorded `floorConsulted`, which the stamp clears). By inspection.

## Tests

One case in `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` (or the nearest mesh-tier read-repair spec), on a two-node mesh with `repairCorroborationClusterSize: 2`: node A coordinates a write; node B's next read of a written block inside `readRepairWindowMs` starts no consult (no `cluster-tx:read-repair-triggered`, no latest query to A). That pins the arm; the below-majority branch is the same `commitQuorumRulesOutRivals` call the coordinator's commits already rely on and needs no second test.

## TODO

- Add `CohortCommitApplied` and the `onCohortCommitApplied` component to `ClusterMember` (`packages/db-p2p/src/cluster/cluster-repo.ts`); call it beside `reportBlockHolders` in `retainCommitVerdicts`, sharing the approving-signer computation.
- Add `CoordinatorRepo.noteCohortCommitApplied` with the writers comment and the push accepted-tradeoff `NOTE:`.
- Wire the late-bound sink in `libp2p-node-base.ts` and in `packages/db-p2p/src/testing/mesh-harness.ts`.
- Write the test; run `yarn workspace @optimystic/db-p2p test` and `yarn test:integration` from root.
- Append the measurement to the freshness debt ticket.
- Docs: `docs/transactions.md` § Lazy read-repair window — where it lists what stamps the window, add a commit this node applied as a cohort member under a full-cohort majority, and that a received push does not. Run `yarn lint:docs`.
