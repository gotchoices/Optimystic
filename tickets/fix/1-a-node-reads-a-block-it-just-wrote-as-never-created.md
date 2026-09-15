description: A user running beta.3 saw a node write to a table and then, a fraction of a second later, be told that the table's founding record had never been created, which made a group-membership step fail outright. A shortcut added in beta.3, which remembers "this record does not exist" for ten seconds on a node that believes it is alone, is the likely cause. Reproduce it, and make sure a remembered absence can never outlive a write that reaches the node.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`settledAbsences` and its accepted-tradeoff NOTE; `get`'s skip via `absenceIsSettled`; the solo-self exit of `fetchBlockFromCluster` returning `absenceSettled: true`; `forgetSettledAbsences`, called only from `CoordinatorRepo.pend` and `CoordinatorRepo.commit`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusOperation` — the cohort-member write path that calls storage directly and never reaches the memo clear)
  - packages/db-p2p/src/storage/storage-repo.ts (`get` reports a pending-only block as `{ state: {} }`, i.e. missing)
  - packages/db-p2p/src/cluster/block-transfer-service.ts and the restoration path (other writers of local storage that bypass `CoordinatorRepo`)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster` membership scoping, which can return self-only while same-network peers are unidentified or refused; `shouldAllowSelfCoordination`'s `extended-isolation` arm)
  - packages/db-core/src/transactor/network-transactor.ts (`get` treats an unflagged absent as final)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts, packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (existing memo and issue-#8 storm specs; must stay green)
  - tickets/backlog/feat-a-cohort-member-remembers-a-settled-absence.md (documents the same cohort-member bypass for the multi-peer memo; reconcile with it)
  - tickets/complete/a-block-we-do-not-hold-is-consulted-on-every-read.md (the ticket that introduced the memo in beta.3)
difficulty: hard
repro: none
----

# Report

GitHub issue gotchoices/Optimystic#20, filed 2026-09-14 by a downstream user (VoteTorrent over Sereus), n = 1 per arm, Android emulators, full application run, not reproduced in isolation by them or by us.

A two-peer replication proof, identical except for the `@optimystic/*` version:

| control node (drone) | beta.2 | beta.3 |
|---|---|---|
| "header block read as absent" | 0 | 7 |
| enrolment failed | 0 | 2 |
| enrolment retried | 2 | 0 |

Timeline on the drone: `registerSelf: refreshed own CadrePeer record` succeeds; 158 ms later a query on the same collection fails with `collection default/CadrePeer holds committed revision 6, but its header block read as absent — storage reported that nothing was ever committed under this id`. Throughout, the drone logs `self-coord-allowed: extended-isolation (warn)`, and the write's coordinator lookup came from cache (`findCoordinator:done … source=cache`). The error text comes from a detector in the downstream plugin, which is byte-identical across both arms.

The same deployment's issue #19 shows why the drone can see itself as alone while peers are connected: its authorization gate refused the peers' `sync` traffic (572 denials), which is what `findCluster` rides.

# The mechanism under suspicion

Beta.3 lets `CoordinatorRepo.get` remember a settled absence for one `readRepairWindowMs` (10 s). It arms only at the solo-self exit of `fetchBlockFromCluster`, on the premise stated at that exit: this node is the block's whole cohort, so every acknowledged commit of the block lands here. While the memo is fresh and the block is still missing locally, `get` serves an unflagged absent with no consult, and `NetworkTransactor.get` treats that as final.

The memo is cleared by a pend or commit that **this** `CoordinatorRepo` handles, and by `get` seeing the block present. Both of the following leave it standing, and #20's topology plausibly produces either:

1. **The write reaches this node through a path that does not clear the memo, and is not yet readable as committed.** A write coordinated elsewhere (a cached remote coordinator) enrols this node as a cohort member through `ClusterRepo.applyConsensusOperation`, which calls storage directly. Between that member pend and the local commit, `StorageRepo.get` reports the block as missing, so the stale memo is served. The backlog ticket `feat-a-cohort-member-remembers-a-settled-absence` found exactly this bypass when the memo was tried on multi-peer cohorts, which is why it was restricted to solo ones.
2. **The write never reaches this node's storage.** The self-only cohort view was wrong: peers were connected but unidentified or refused. A remote coordinator committed the block on a cohort that does not include this node's view of itself as alone. Nothing local can clear the memo, because nothing local happens.

In both cases the reader already holds evidence contradicting the absence: it has just issued a write to the collection, and the collection knows a committed revision.

The accepted-tradeoff NOTE on `settledAbsences` names its revisit condition as "if a caller ever needs create-visibility across coordinators tighter than one window". This report trips it, and in the stronger form of a node's own write.

# Required

**Reproduce first.** At unit level, with `CoordinatorRepo`, a controllable clock and a mutable key network: arm the memo with a self-only cohort, then deliver a write of the block by each path that bypasses `CoordinatorRepo.pend/commit` (cluster-member pend, member pend followed later by commit, block-transfer push, restoration), and read inside the window. Then at mesh level if feasible: two nodes, node A's `findCluster` self-only while node B coordinates a write that A issues or takes part in, and A reads the block inside the window. Record which paths reproduce. If none do, say so plainly and do not ship a speculative change as the fix; add the observability item below and hand back to the reporter.

**The invariant to establish**, not a special case for header blocks: a node never serves an unflagged absent for a block

- after any write of that block has reached this node's storage, by any path (pending counts), and
- under a settled-absence memo armed on a cohort view that is no longer the current one.

Candidate designs, to choose between with the tradeoff recorded:

- **(a) Clear at the storage seam.** Every pend, commit, restore or push that touches a block's local storage clears its memo, so a writer added later cannot forget. This retires the bypass class in item 1 and is the precondition the backlog ticket names for ever widening the memo.
- **(b) Bind the memo to the cohort it was settled under.** Record the cohort at arming, and serve the memo only while the cohort lookup `get` already performs for its proximity check still returns exactly this node. This addresses item 2 when the view changes, but not when it stays wrong.
- **(c) Do not arm while self-coordination is only allowed as a fallback** (`extended-isolation`), i.e. when the key network itself doubts that self-only is the real cohort. This addresses item 2 directly, at the cost of consults while isolated.
- **(d) Drop the memo** back to beta.2 behaviour. The issue-#8 consult storm stays bounded by the held-block window for present blocks, but reads of not-yet-created blocks go back to one consult each.

The recommended starting point is (a) plus (c). Measure before choosing (d).

**Observability**, requested by the reporter and cheap: a debug line when `get` serves a memoized absence, rate-limited to once per block per window so it does not recreate the volume the skip removed, carrying the memo's age and the cohort it was settled under. Without it, this class cannot be confirmed or excluded from a field log.

# Edge cases & interactions

- **Issue #8 must not regress.** A genuinely solo node (no peers ever) must still consult at most once per window per missing block. Keep `coordinator-repo-solo-read-repair-window.spec.ts` and `coordinator-repo-absence-window.spec.ts` green, and add the new cases beside them.
- **The in-flight race already noted at the stamp site** (a local pend or commit that clears the memo while a consult is running is undone by the stamp) belongs to the same invariant. Close it under whichever design is chosen, or say why it stays.
- **Pending-only content.** If design (a) clears on member pend, a pend that is later cancelled leaves the block missing and unmemoized. The next read consults, which is the safe direction.
- **A write that this node's client issues through a remote coordinator** reaches none of this node's storage paths if this node is not in that record's cohort. Decide whether the client layer should also clear the memo for the blocks it writes, and test it.
- **Mixed versions.** Nothing here changes the wire format. A beta.3 peer keeps its own memo behaviour.
- **Update the NOTE** on `settledAbsences` to record that its revisit condition tripped (#20) and what was done. Append a one-paragraph cross-reference to `backlog/feat-a-cohort-member-remembers-a-settled-absence` if design (a) lands, since it removes that ticket's stated blocker.

# TODO

- Reproduce at unit level across each bypass path; then mesh level if feasible. Record results.
- Output an implement ticket with the chosen design and its tests, or an honest "not reproduced" handoff plus the observability line.
