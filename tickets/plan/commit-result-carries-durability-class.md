description: When a write succeeds, the caller is told only "yes". It is not told whether the change is now held by the full group, by a bare majority, or only by the machine that wrote it. Make the result say which, so an application can show a change as pending, and so the storage layer can remember which blocks still need copies pushed out.
prereq:
files:
  - packages/db-core/src/transactor/i-transactor.ts (or wherever `CommitResult` / `PendResult` are declared — today success is a bare boolean or a StaleFailure)
  - packages/db-p2p/src/repo/coordinator-repo.ts (~line 2107-2109 and 2534-2575: the solo short-circuit that commits to local storage with a self-signed proof and returns plain success; ~line 2656-2705 and 2912-2928: the durability gate that counts durable holders)
  - packages/db-core/src/transactor/network-transactor.ts (~line 724-771 and 804-828: a torn multi-block commit whose sweep failed for transport reasons is logged and still returned as success)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (~line 866-896: commit-majority shortfall schedules a retry and returns without throwing)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (the `grown` arm — the only path today that gives a second copy to a block written while alone; in-memory, event-triggered)
  - packages/db-p2p/src/transactions/block-transfer.ts (`pushBlocks`, the existing block push primitive)
  - ../sereus/packages/cadre-core/src/cadre-node.ts (~line 3047-3130 `drainPendingControlReplication`: the downstream project reconstructing "committed alone" from connection counts because the storage layer does not report it)
difficulty: medium
tradeoffs: Widening a result type touches every transactor implementation and test double, and the first consumer (sereus) already has a working row-level workaround, so a maintainer might defer it; the counter-argument is that the workaround misses header and index blocks by its own admission and the long-lived-pend feature cannot be built without this.
----

# The problem

Optimystic today has exactly one shape of successful write: acknowledged, meaning a majority of the cohort durably holds it. But three real situations return that same plain success while meaning something weaker:

1. **Solo commit.** A node whose derived cohort is itself alone writes straight to local storage, mints a single-signer proof, and returns success. Nothing distinguishes that from a quorum commit. Sereus had to infer "this was written alone" from the control node's connection count and build a row-level re-issue queue on top, and its own docs note that re-issuing a row never rewrites the untouched collection-header and index blocks, which is why it then also had to add a whole-store push on peer join.
2. **Majority, not full.** A commit is acknowledged at more than half the cohort. The remaining members are healed later by a commit-broadcast retry that lives in memory (persisted only when a transaction state store is injected, which the reference peer never does). The caller cannot tell a 2-of-4 from a 4-of-4.
3. **Torn multi-block commit.** The tail block commits, the sweep over the other blocks fails for a transport reason, the abandoned blocks are cancelled, and the result is still success.

# What to build

**A durability class on the result.** The pend and commit results carry, alongside success, something like `{ holders: number, cohort: number, quorum: 'local' | 'majority' | 'full' }` and the identity of the coordinating cohort. `local` means only the writer holds it; `majority` means acknowledged under the normal gate but at least one cohort member has not confirmed; `full` means every cohort member confirmed. This is descriptive, not a policy change: nothing about what is accepted changes in this ticket.

**A durable under-replication ledger.** The coordinating node records, in its persistent storage, every block it acknowledged below `full`, with the members still missing it. A drain pushes those blocks (through the existing block push primitive) whenever a missing member becomes reachable, and clears the entry when the member confirms it holds the revision. This generalizes the rebalance monitor's `grown` arm from "topology changed" to "I know who is missing what", and it survives restart. Sereus's row-level queue and peer-join backfill become redundant for blocks once this exists; they can stay as belt-and-braces until measured.

**An event when a block reaches full replication**, so a host can move a change from "pending" to "saved" in its UI. The local change notifier is the natural seam.

# Not in this ticket

Deciding whether a caller may *proceed* on a `local` result, and what happens if such a write later loses a conflict. That is the tentative-commit lane, `backlog/feat-long-lived-pend-completes-as-members-appear`, which needs this ticket first.

# Use cases to test

- Solo node writes, result says `local`, ledger holds the block; a second member joins; the block is pushed; the ledger clears; the event fires.
- Four-member cohort with one member unreachable: result says `majority` with holders 3 of 4; the member returns; the ledger drains it; a read on that member finds the block without read repair.
- Torn multi-block commit: the result must not say `full`; it must name the blocks that were cancelled.
- Restart the coordinator between acknowledgement and drain: the ledger survives and drains after restart.
