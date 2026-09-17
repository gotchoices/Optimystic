description: A write can be reported as failed ("torn") even though its row is saved, because a competing write that came right after it was built on top of it. An application that retries the failed write then stores the row twice. The failure report must only be given when the row really is missing, and a row reported missing must not show up later.
prereq: cancelling-a-refused-write-blocks-another-writers-commit
architecture: docs/correctness.md
files:
  - packages/db-core/src/collection/collection.ts (`completeOwnEntry`, `tornFromRefusal`: where "torn" is decided)
  - packages/db-core/src/collection/struct.ts (`TornActionError`, `TornActionReason`: `rival-holds-revision` documented as "nothing can land this write")
  - packages/db-core/src/network/stale-failure.ts (`isOwnRevision`: deliberately `===` only; its NOTE says a superseded own revision "needs the revision index")
  - packages/db-p2p/src/storage/storage-repo.ts (`pend` own-revision carve-out; `getRevisionAction`; `internalCommit` fork guard on the declared base; read-driven promotion in `get`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations` stale check; `holdsCommittedRevision` already reads the revision index)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`classifyStaleRejection`, stale classification of a refused pend)
  - packages/db-core/src/transactor/network-transactor.ts (`cancelAbandonedSweepBlocks`, `dischargeCancel`: cancels that fail leave pending records behind)
  - docs/internals.md ("The writer's retry finishes its own half-landed action"), docs/correctness.md ("Commit durability reporting")
difficulty: hard
----

# What goes wrong

Sereus's report (`../sereus/tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md`, "Error tally") saw `TornActionError` for writes whose rows were later counted as present (run `c2np-r2`, reps 2 and 3). The prerequisite ticket removes the main reason writes tear under contention. This ticket makes the answer honest for the tears that remain, whatever causes them.

`TornActionError` promises the caller that the write's data did not land (`struct.ts`: "the log already holds an entry for a write whose data is not saved"). An application's only safe rule is to resubmit on failure. When the promise is false, resubmitting stores the row twice.

## Deterministic reproduction (repro: verified)

A 2-member `createMesh` with no latency. Writer B's transactor is wrapped so that its first multi-block commit:

1. really commits every block (`await inner.commit(request)`, which succeeds);
2. then waits for node A's tree to `replace` another row, so A takes the next revision of the same leaf, built on B's row;
3. then returns a refusal: `{ success: false, missing: [], reason: 'commit-not-durable: injected after landing' }`.

`treeB.replace([['mine', …]])` then throws:

```
TornActionError: collection Message: action … is torn at rev 2 — … the write cannot be finished:
stale revision: block X at rev 3, requested rev 2 (block X is at rev 3)
```

A fresh `Tree` on node A reads `mine` as present. The text is sereus's exact shape, and the reason is `rival-holds-revision` (the refusal carries `staleAt`). The sketch was a throwaway spec modelled on `packages/db-p2p/test/half-landed-write-is-finished.spec.ts` (`landOnlyTheTailOnce`); rebuild it from that file.

## The same outcome under real contention (from a trace)

This comes from a 2-member mesh with 2–17 ms delivery latency; the prerequisite ticket has the wrapper. The trace is at `tickets/.logs/concurrent-inserts-trace.log` (runner-pruned). Writer B is `d---mw…` and rival A is `7BxPZ…`.

- B's tail committed at rev 2. B's leaf commit then kept losing conflict races, and B cancelled its leaf pending record several times.
- A then committed the leaf at rev 3 **declaring base rev 2**. On A's own member this was refused: `commit:missing-base … local latest 1 is not the declared base 2 of rev 3`. That member then reconciled rev 3 from B's member (`reconcile:restored rev 3`).
- So A's writer had read the leaf at rev 2, meaning with B's row in it. The leaf's rev 2 was produced by the read-driven promotion of B's pending record once B's log entry was committed: `StorageRepo.get`, which `Collection.bootstrapContext` relies on to make pending non-tail blocks readable.
- B's next completion re-send was refused as stale (latest rev 3 is A's), and B reported torn. The row was saved.

A third observation, not yet explained: in one latency run a pair's count went 3 → 4, with one writer reporting torn, and the NEXT pair went 4 → 7 with both succeeding. **A row reported torn appeared one rep later.** The likely route is a pending record that outlived a failed cancel (`cancel-error … Conflict race lost` appears throughout the traces) and was then promoted by a later read under the committed log entry. Confirm or refute this.

# What must be true afterwards

- **Saved means saved:** if every block the write's log entry names contains the write's transform in its current lineage (it holds the write's revision, or a later revision that was built on it), the writer's sync or commit resolves as saved. It must not throw `TornActionError`.
- **Torn means final:** `TornActionError` is thrown only when at least one of those blocks does not contain the write, and after it is thrown the write's transforms can never later become visible. Either the pending records are confirmed gone before the error is raised, or the error carries a reason that tells the caller the write may still land, never both.
- **Tests:** the deterministic reproduction above becomes a regression spec, and so does the "reported torn, appeared later" case once its route is pinned.

# Design notes for the implementer (not settled; decide in this ticket)

**Where the "own work already superseded" judgement can live.** `isOwnRevision` treats a block as satisfied only when `latest.rev === rev && latest.actionId === actionId`. Its NOTE already says the superseded case needs the revision index (`StorageRepo.getRevisionAction`, which `ClusterMember.holdsCommittedRevision` uses). Extending the carve-out at the pend tier (`StorageRepo.pend`, `ClusterMember.validatePendOperations`, `CoordinatorRepo.classifyStaleRejection`) to "the index names this action at `rev`" is the smallest change. It has two known holes, and both need an answer:

- **Restored past the revision:** a member that got the later revision by reconcile or restore (`saveReplicatedBlock`) may have no index entry for `rev`. That member still answers stale, and with 2 members the pend is then refused. In the trace above, A's member was exactly this case.
- **Fork:** an index entry for `rev` does not prove the later revision was built on it. If a member held rev N under X and then took rev M by reconcile from a lineage whose base was below N, X is orphaned history. The fork guard (`internalCommit`, which checks the declared base) only protects the commit path, not replication.

**A client-side alternative.** On a `rival-holds-revision` refusal, the writer asks whether each unlanded block's lineage contains its action (for example, a read pinned at the entry's revision, which `completeOwnEntry`'s own NOTE suggests for the `getStatus` branch) before deciding torn. That still has to answer the fork question above.

**Whichever evidence is chosen,** state the invariant in docs/internals.md ("The writer's retry finishes its own half-landed action"), and correct the `rival-holds-revision` wording in `struct.ts` and the "Commit durability reporting" paragraph of docs/correctness.md.

**Also answer: can a read promote a pending record whose writer has already cancelled other blocks and given up?** That promotion is the "torn then appears" route. If it can, the writer's give-up path must make its remaining pending records unpromotable (confirmed cancel), or the error must say the write may land.

Check `backlog/bug-a-refused-write-can-leave-its-log-entry-behind` (the log keeps an entry for a refused write) and `backlog/bug-a-retried-write-can-store-two-versions-of-one-log-revision` before changing the give-up path. Both sit on the same exits, and either may gain or lose an arm.

# TODO

Phase 1: pin the routes
- Rebuild the deterministic spec (land, rival on top, refuse) and confirm it fails as described.
- Reproduce "reported torn, row appeared later" under the latency wrapper, with the prerequisite ticket's change in place. Remove that change temporarily if needed to get enough tears. Trace which record got promoted and why its cancel did not stick. Record the finding in this ticket's handoff.

Phase 2: decide and implement
- Choose the evidence for "the block's lineage contains this action" (see the design notes). Cover the restored-past-the-revision member and the fork case explicitly, each with a test.
- Make `completeOwnEntry` / `tornFromRefusal` (and the pend-tier carve-out, if that route is chosen) report a superseded-but-contained write as saved.
- Make the give-up path satisfy "torn means final", or give `TornActionError` a reason that says the write may still land. Document the choice in `TornActionReason`.

Phase 3: docs and runs
- Update docs/internals.md, docs/correctness.md and the `struct.ts` doc comments as described.
- Run `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/db-p2p test`, and the quereus plugin's two-node specs.
