description: A node that has just written a record can be told the record was never created, because the node remembers "this does not exist" for ten seconds and keeps serving that memory after another machine created the record. Remove that memory, keep the quiet logging it was added for, and turn the reproduction that was written for this bug into the regression gate.
files:
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts (the reproduction — seven `REPRODUCES` cases fail at HEAD; make them green, drop the prefix, keep every case)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`settledAbsences` and its two NOTEs; `absenceIsSettled`; `forgetSettledAbsences` and its two call sites in `pend` and `commit`; the `absenceSettled` field on `fetchBlockFromCluster`'s result and the solo-self exit that sets it; the memo branch and the stamp in `get`, with the in-flight-race NOTE; the `cluster-fetch:solo-self-skip` log line)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts (the `cohort of one` section asserts the memo; rewrite to the new cost model, keep the `three-member cohort` section as is)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (one case, "suppresses reads of a block this node does not hold through its OWN absence memo, not this stamp", asserts the memo exists)
  - packages/db-core/src/transactor/network-transactor.ts (the comment above `hasValidResponse` in `get` explains the unflagged absent in terms of the memo)
  - packages/db-core/src/cluster/structs.ts (`readRepairMode`, `readRepairWindowMs` and `readRepairSampleRate` doc comments mention the settled absence)
  - docs/transactions.md ("A block this node does not hold is windowed too" paragraph and the `readRepairWindowMs` / `readRepairSampleRate` table rows; the scope-limit sentence at the end of the "provably-permanent corroboration decline" paragraph)
  - docs/internals.md (the flag table row that says which unflagged absent is remembered)
  - tickets/.pre-existing-known.md (remove the entry for the reproduction spec once it is green)
  - tickets/backlog/feat-a-cohort-member-remembers-a-settled-absence.md (append the cross-reference described below)
  - tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md (lists `settledAbsences` among the per-block maps; drop the mention)
difficulty: medium
----

# What was reproduced

GitHub issue gotchoices/Optimystic#20: a node running beta.3 wrote a record through a remote coordinator and, a fraction of a second later, read the same collection's header block as "never created" through its own coordinator. Beta.2 did not do this. The routing ticket named the beta.3 settled-absence memo in `CoordinatorRepo` as the suspect, and asked for a reproduction before any change.

Reproduced, at unit level and at mesh level, in `packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts`. Every case there arms the memo the only way it can be armed (a read of a missing block while `findCluster` returns only this node), then reads inside the ten-second window. Storage is the real `StorageRepo` over `MemoryRawStorage`, so a cohort-member pend lands as a genuine pending-only record and reads back as `{ state: {} }`, exactly as in production.

| case | write path that bypasses `CoordinatorRepo.pend/commit` | cohort view at read time | at HEAD |
|---|---|---|---|
| unit | member pend into local storage (`storageRepo.pend`, what `ClusterRepo.applyConsensusOperation` calls) | self-only | serves the memo; no consult |
| unit | member pend locally, commit on two remotes | grown to include the remotes | unflagged absent served; remotes never asked |
| unit | nothing local; commit on two remotes | grown to include the remotes | unflagged absent served; remotes never asked |
| unit | a local `CoordinatorRepo.pend` while the settling consult is parked in `findCluster` | self-only | the consult's stamp re-arms the memo the pend had cleared; next read skips |
| unit | member pend then member commit | self-only | reads present (no defect) |
| unit | certified push through `saveReplicatedBlock` (also what read-driven restoration uses) | self-only | reads present (no defect) |
| mesh, 3 nodes | tree created and written through node B while A's view is self-only and B cannot reach A; then A's view grows | grown | `Tree.open` through A returns "no such tree" — the reporter's symptom |
| mesh, 3 nodes | block committed on B and C, A unreachable for both pend and commit; then A's view grows | grown | unflagged absent served |
| mesh, 3 nodes | pend reaches A as a member, commit does not; then A's view grows | grown | unflagged absent served |

All seven failing cases are deterministic over three runs. Control: with `readRepairMode` forced to `'paranoid'` on the reading node (the one mode that never serves the memo), all three mesh cases pass. The memo is the cause. Run log: `tickets/.logs/a-node-reads-a-block-it-just-wrote-as-never-created.repro.log`.

Two facts from the mesh tier worth keeping. First, a self-only view alone does not keep A out of B's write. A's admission gate does refuse B's three-member record (`cluster-member:admission-reject` with `inconsistent-with-derived-view`, symmetric difference 2 against a tolerance of 1, captured 2026-09-15), but B and C are a super-majority, the commit record still reaches a reachable A, and A, having never pended, reconciles the committed revision from the cohort and ends up holding it. So a stale absent needs A to be unreachable or refusing, which is what issue #19 on the same deployment describes (A's authorization gate refused the peers' `sync` traffic), and that is what the mesh cases model with the harness's unreachable-peer switch. Second, the transactor routes a pend by `findCluster` (greedy cover over the cohort), not by `findCoordinator`, so steering a mesh write to a chosen coordinator means steering the transactor's `findCluster`; the spec does this by reassigning `mesh.keyNetwork` after `createMesh`, which reaches the transactor alone.

# Why the answer is to remove the memo

The memo only ever applied to one cohort shape: `findCluster` returned this node alone. On that shape the consult it skips does no network work at all: `fetchBlockFromCluster` runs one `findCluster`, logs `cluster-fetch:solo-self-skip`, stamps `lastSeenCommitMs`, and returns. So the memo's whole benefit is one cohort lookup and one debug line per read of a missing block.

Measured:

| what | cost | source |
|---|---|---|
| one solo `findCluster` on the real `Libp2pKeyPeerNetwork` | 0.009 ms | the accepted-tradeoff NOTE at `get`'s proximity check in `coordinator-repo.ts`, measured 2026-09-11 |
| one read of a never-written block through `NetworkTransactor` on a 1-node mesh, memo served (`'lazy'`) | 0.0115 ms | 2000 reads, this ticket, 2026-09-15 |
| the same read with the memo never served (`'paranoid'`) | 0.0098 ms | same run |

The alternatives the routing ticket listed were weighed against that:

- **Bind the memo to the cohort it was settled under (b).** Correct for every reproduced case, but checking the binding on each memo-served read needs a `findCluster`, which is the entire cost of the consult the memo skips. Its benefit over removal is one debug line per read.
- **Clear the memo at the storage seam (a).** Retires the member-pend bypass, but not the two cases where the write never reached this node's storage, which is the shape issue #20's topology produces (a coordinator that cannot reach or is refused by this node commits without it). Not sufficient alone, and every new writer of local storage would have to remember to clear.
- **Do not arm under `extended-isolation` (c).** `CoordinatorRepo` cannot see `shouldAllowSelfCoordination` without widening `IKeyNetwork`, and a `bootstrap-node` view (never seen a peer) is just as transient when the first peer arrives.
- **Drop the memo (d).** Returns absence handling to beta.2, which the reporter's A/B ran with zero failures. Deletes a per-block state map, its two NOTEs, the in-flight race at the stamp site, a result field, and two doc paragraphs. The cost is bounded above by the measurements: about a hundredth of a millisecond per read of a missing block on a one-node deployment, and one debug line per such read, which the rate limit below removes.

Decision: **(d)**, with the `cluster-fetch:solo-self-skip` line rate-limited so issue #8's log volume does not return. The memo was introduced for a field log where a never-written collection cost "two consults per control-plane call"; on a solo node a consult is the lookup and the line, and both stay bounded without any memo.

If a human prefers to keep a memo, (b) is the shape: store `{ at, cohort }` where `cohort` is the sorted peer-id list, and in `get` serve a fresh memo only when one `findCluster` returns the same list; close the in-flight race with a per-block clear counter captured before the consult and compared at the stamp. Any memo, solo or multi-peer, needs both that binding and a storage-seam clear, and the reproduction spec is the gate for either.

# The change

**`coordinator-repo.ts`.** Remove `settledAbsences` (with both NOTEs), `absenceIsSettled`, `forgetSettledAbsences` and its calls at the top of `pend` and `commit`, the `absenceSettled` field on `fetchBlockFromCluster`'s result (every exit sets it; the doc comment on the result type describes it), and in `get` the `absenceIsSettled` branch, the `settledAbsences.delete` on a present block, the stamp block after the consult with its in-flight-race NOTE, and the delete in the catch. The comments in `get` that describe trigger (a) as "unless an earlier consult settled its absence" and the long NOTE above the consult loop that explains the unflagged absent as "confirmed within the last window" both go back to the beta.2 statement: an unflagged absent means the cohort was consulted on this read. Keep `markBlocksSeen` at the solo-self exit untouched: that is the held-block window from issue #8, a different mechanism with its own spec.

**Rate-limit the solo-self line.** At the solo-self exit, log `cluster-fetch:solo-self-skip` only when `ageMs(blockId)` is undefined or greater than `readRepairWindowMs`, and do so before `markBlocksSeen` stamps the block. The exit already stamps every block it sees, so no new state is needed. The line keeps its `blockId`. This is the field signal the reporter asked for: a read of a missing block was answered from a self-only view, once per block per window.

**`network-transactor.ts`.** The comment above `hasValidResponse` in `get` currently says an unflagged absent means the cohort confirmed the absence "within the last `readRepairWindowMs`" and describes the solo memo. Restore the direct statement: `CoordinatorRepo.get` consults the cohort on every read of a missing block before answering, and a flagged entry is the only thing that earns a retry.

**Config doc comments and docs.** `structs.ts`: drop the settled-absence sentences from the three read-repair fields. `docs/transactions.md`: replace the "A block this node does not hold is windowed too" paragraph with two sentences saying a missing block consults its cohort on every read, on a cohort of one that consult is a lookup and a once-per-window line, and why the memo that briefly existed was removed (issue #20, this ticket); trim the two table rows and the scope-limit sentence at the end of the preceding paragraph. `docs/internals.md`: the flag-table row that says which unflagged absent is remembered. `yarn lint:docs` checks the anchors.

**Specs.**

- `coordinator-repo-absence-write-bypass.spec.ts`: drop the `REPRODUCES` prefixes and the header sentences about failing at HEAD; every case stays. The unit case "a cohort-member pend lands inside the window and the next read still skips its consult" becomes "…and the next read consults", asserting one `solo-self-skip` line across the two reads if the line is rate-limited per window, or two if not; say which in the case. Keep the `paranoid` control out of the tree, it was a one-off.
- `coordinator-repo-absence-window.spec.ts`, `cohort of one` section: the memo-specific cases go ("settles after one consult", "consults again once the window lapses", "the window runs from when the consult started", the `off`-mode pair, the sample-rate case, both "re-consult that does not settle" cases, the five "local write clears the memo" cases, "a block that turns up locally retires the memo", "a cohort that grows inside a settled window is not asked until the window lapses (accepted tradeoff)", "skipClusterFetch reads never consult and never stamp", "multi-block get"). What replaces them is the new cost model for a never-written block on a cohort of one: nine reads inside one window produce nine unflagged `{ state: {} }` answers, ask no remote, and log `cluster-fetch:solo-self-skip` once (the rate limit) and `cluster-tx:read-repair-triggered` never; a cohort that grows inside the window is asked on the very next read (the accepted-tradeoff case inverted, which is the point of this ticket); a pending-only insert is served as content, unflagged. Keep the `three-member cohort` section byte-for-byte; keep the 1-node-mesh case, flipping its count to the rate-limited one line.
- `coordinator-repo-solo-read-repair-window.spec.ts`: rewrite the one case named above to "a missing block is never suppressed by the held-block stamp" — the stamp is set, the block is missing, every read still reaches the solo-self exit.

**Board.** Remove the entry this ticket's reproduction added to `tickets/.pre-existing-known.md`. Append a paragraph to `backlog/feat-a-cohort-member-remembers-a-settled-absence`: the solo memo has been removed as well (issue #20, this ticket); any future absence memo, solo or multi-peer, must be bound to the cohort view it was settled under and be cleared by every writer of local storage, and `coordinator-repo-absence-write-bypass.spec.ts` is the gate it must pass. Drop the `settledAbsences` mention from `debt-freshness-state-scattered-across-coordinator-repo`.

# Edge cases

- **Issue #8 must not regress.** The held-block window (`lastSeenCommitMs` armed at the solo-self exit) is untouched; `coordinator-repo-solo-read-repair-window.spec.ts` stays green apart from the one rewritten case. The absence side of #8 (the log volume of probing never-written collections) is covered by the rate limit, and the measurements above bound the compute.
- **Mixed versions.** Nothing on the wire changes. A beta.3 peer keeps its own memo; its reads can still be stale by one window until it upgrades.
- **`'off'` and `'paranoid'` modes.** With no memo there is nothing mode-specific left on the absence side; `absenceIsSettled`'s mode logic goes with it.
- **The scheduled commit retry.** A member that missed a commit still receives it through `scheduleCommitRetry`; until then a read through that member consults, sees the cohort's claim, and promotes or acquires. That is beta.2 behaviour and is what the mesh cases now pin.

# TODO

- Remove the memo from `coordinator-repo.ts` as listed under "The change"; rate-limit the solo-self line using the stamp the exit already sets.
- Update the `get` comments, the `network-transactor.ts` comment, the three `structs.ts` doc comments, and the two docs; run `yarn lint:docs`.
- Make `coordinator-repo-absence-write-bypass.spec.ts` green, drop its `REPRODUCES` prefixes and the header sentences about failing at HEAD, and adjust the member-pend case's count to the rate limit.
- Rewrite the `cohort of one` section of `coordinator-repo-absence-window.spec.ts` and the one case in `coordinator-repo-solo-read-repair-window.spec.ts` as described.
- Remove the reproduction entry from `tickets/.pre-existing-known.md`; append the cross-reference to the two backlog tickets.
- Run the `db-p2p` suite and `yarn typecheck`; report the counts.
