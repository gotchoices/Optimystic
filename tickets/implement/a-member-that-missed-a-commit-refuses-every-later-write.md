description: If one machine misses a write while the others save it, that machine keeps a leftover "a write is in progress here" marker and mistakes it for somebody else's write still running. It then votes against every later change to that data, so nobody in the group can write to it — until that machine happens to read the data itself, which nothing schedules. Reproduced in a three-machine test: three writes in a row were each refused after ~17 seconds and reported as failures, then a single read by the stuck machine cleared it and the next write took 32 milliseconds.
prereq: a-write-reported-torn-can-already-be-saved
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations` — the pending-rival branch that returns the `held` verdict; `holdsCommittedRevision`; `applyConsensusOperation`'s behind-divergence reconcile, which is the healing this path never reaches)
  - packages/db-p2p/src/storage/storage-repo.ts (`get` — the read-driven promotion that IS the only cure today; the `state.pendings` list the vote reads, which carries action ids and not their revisions)
  - packages/db-p2p/src/storage/i-block-storage.ts (`savePendingTransaction` stores the pend's `rev`; `listPendingTransactions` yields only the action id, so the vote cannot see that revision)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`answerBlocksHeld`'s un-corroborated arm; `noteStuckReservation`, whose "remote-only reservation goes unnamed" NOTE this measurement confirms)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`BlocksHeldError`, and the `Pend blocks held: n/m member(s) …` text the writer ends up seeing)
  - packages/db-p2p/test/member-leaves-and-returns.spec.ts (the `onClusterDelivery` mechanics the reproducer below is built from)
  - packages/db-p2p/test/util/node-count-mesh.ts (`createProductionShapedMesh`, `setUnreachable`, `transactorDrivenBy`, `recording`)
  - docs/correctness.md (Theorem 9's `held` paragraph: "Both are terminal for the record they answer and retryable for the writer" — false in this case)
difficulty: hard
repro: verified
----

# What goes wrong

A cohort member that promised a write and then missed its commit keeps that write's **pending record** — the durable marker a member stores at pend-apply and removes at commit or cancel. From then on, every later write to that block meets that record on this one member, and the member reads it as a *live rival reservation*: it votes `held`, the vote that means "somebody else is writing this right now, try again in a moment".

Nothing about it is momentary. The rival already committed, on the other members, minutes ago. The record will never be removed by its writer, because its writer believes the write succeeded — and it did, by majority. So the member votes `held` on every retry, forever.

At three machines that one vote decides everything: the promise bar is `ceil(0.75 x 3)` = all three, so two approvals out of three is a refusal. Every write to that collection, from every machine, is refused, retried to the end of the writer's budget, and reported to the application as a failure.

The premise the vote rests on is written out at the site and is simply not true here: *"the rival's reservation is removed the moment it commits or cancels, so the very same pend succeeds on retry."* The rival committed. This member just did not see it.

## What that costs, measured

Three-machine in-process mesh, production-shaped configuration (`createProductionShapedMesh(3)`), everything reachable at the time of measurement:

- three consecutive writes from a healthy machine: **16.7 s, 17.4 s, 16.7 s**, each ending in `SyncRetryExhaustedError: sync for collection … exhausted 10 retries: Pend blocks held: 1/3 member(s) hold an unresolved rival action (2/3 approvals)`;
- the wedged block was the collection's **log tail**, so *no* write to that collection could get through;
- one read performed **by the stuck member itself** cleared it, and the next two writes took **33 ms** and **32 ms** at `quorum: full`.

Four runs, same outcome every time.

The same fingerprint, on a real deployment: sereus's `control-write-degraded-cohort-member` run 1 on 2026-09-17, where rival action `P6DsRqE3Mj2-escNG0gTvw` was still named as the holder **five minutes** after it was first seen, three tests hit the scenario's 120 s ceiling, and one background write was lost silently in a run that otherwise passed. That report is `../sereus/tickets/fix/control-write-refused-when-a-rival-write-holds-the-block.md`.

## This is not a regression from the `held` vote

The same branch used to answer with a `reject` vote, so the same wedge reported itself as `Transaction rejected by validators` after about ten seconds instead of as an exhausted retry budget after about seventeen. `a-contended-pend-refusal-is-permanent-on-a-small-cohort` changed the *wording and the retryability* of this refusal, not whether the block is wedged. Do not spend time looking for what that change broke; it fixed the case it was about (a genuinely live rival) and left this one, which was already there, more visible.

# Reproducing it

Built from `packages/db-p2p/test/member-leaves-and-returns.spec.ts`, whose phase-2 mechanics this reuses almost verbatim. Deterministic — four runs, no sampling.

1. `createProductionShapedMesh(3)`; call the nodes A, B, C. Seed a `Tree` from A.
2. A writes again. Watch `mesh.failures.onClusterDelivery` for the delivery to C that carries **the write's tail commit** — `commit.blockIds.includes(commit.tailId)` — at the moment C has promised it and not yet voted on it (`record.promises[cId] !== undefined && record.commits[cId] === undefined`). On that delivery, `setUnreachable(mesh, [c])`. The tail commits on A and B (the commit phase needs only two of three); C keeps the pending record it stored when it promised the pend.
3. Leave C unreachable for **12 s** — longer than the writer's commit-retry schedule (`ClusterCoordinator.scheduleCommitRetry`: 250/500/1000/2000/4000 ms, 7.75 s in total). After that nobody owes C the commit any more.
4. `setUnreachable(mesh, [])`. Every machine is reachable again and the fault is over.
5. B writes. It fails with `SyncRetryExhaustedError` after ~17 s. Repeat: it fails again, identically, for as long as you care to keep trying.
6. Read the tree **through C**. The record clears, and B's next write takes ~30 ms.

Read straight out of each node's own `storageRepo.get` at step 4, the state is unambiguous:

```
A  tail  latest={"actionId":"XlFR…","rev":2}  pendings=[]
B  tail  latest={"actionId":"XlFR…","rev":2}  pendings=[]
C  tail  latest={"actionId":"MPsd…","rev":1}  pendings=["XlFR…"]
```

C holds, in its own storage, both halves of the answer: a pending record for action `XlFR…`, and a `latest` that has not reached it. Nothing asks.

# Why none of the existing cleanup paths owns this

Each was checked against the run, under `DEBUG='optimystic:*'`:

- **`StorageRepo.dropUnpromotablePendings`** — never ran (zero `commit:drop-unpromotable-pendings` lines). It fires only inside a commit whose refusal was divergence-shaped, and no commit for this action ever reached C again.
- **`NetworkTransactor.cancelAbandonedSweepBlocks`** — ran, and for the wrong block. It cancels what the *sweep* abandoned, which was a different, non-tail block; that cancel failed (`Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`), was logged as a WARN and swallowed, and that block's record cleared later anyway. The tail's commit **succeeded**, so nothing anywhere treats the tail's pending record as abandoned. It is not abandoned; it is unreplicated.
- **`ClusterCoordinator.scheduleCommitRetry`** — the one mechanism that would genuinely have healed C. It gives up after 7.75 s. A member away or slow for longer than that is never offered the commit again.
- **`CoordinatorRepo.noteStuckReservation`** — never fed, and the say-once `coordinator-repo:stuck-reservation` line never fired (zero occurrences against twelve `pend-held-uncorroborated` lines). The coordinator can only name a holder its **own** storage corroborates, and here the record exists on one remote member only. The NOTE at that method already predicted exactly this shape and named the cure ("count on the member side"); this measurement is its revisit condition tripping.
- **`StorageRepo.get`'s read-driven promotion** — the only thing that actually cures it, and it only runs when the wedged member is itself the one reading, with the collection's action context. Writers coordinate through other machines and never read C's storage, so nothing in the write path can trigger it. A machine that mostly serves its cohort and rarely reads on its own account stays wedged.

So: **nothing owns this case**, and the one thing that cures it is triggered by a coincidence.

## It is NOT the unpromotable-pending sweep

`backlog/debt-unpromotable-pending-records-need-a-sweep` is about records that can **never** be promoted, whose writer is gone and whose cure has to be a guess about when a marker is abandoned — deliberately hard, because deleting a live reservation is worse than the leak. This record is the opposite: it is **promotable**, its action is committed and durable on the rest of the cohort, and the correct action is not to delete it but to finish it. The two tickets should not be merged. An arm has been added there recording this distinction and correcting that ticket's 2026-09-16 arm, which said the cost lasts "for as long as that member is away" — measured here, it outlives the absence indefinitely.

# What must be true afterwards

- **A member that is behind must not veto.** When a member finds a block held by a pending record whose action the cohort has already committed, the write must not be refused on the strength of that record. Progress under contention (`docs/correctness.md` Theorem 9) claims a `held` vote is "terminal for the record it answers and retryable for the writer"; that has to become true, which means either the member stops casting it in this case or the writer's retry has something that can actually clear it.
- **A member that misses a commit converges without being read.** Today the healing exists (`StorageRepo.get`'s promotion, and the behind-divergence reconcile in `applyConsensusOperation`) but is reachable only by accident. After this ticket, a member holding a pending record for an action the cohort has committed comes current on its own — on the next vote it casts about that block at the latest.
- **A wedge is named while it lasts.** If any window remains in which a member can refuse on a record only it holds, the coordinator or the member says so once, in words, the way `stuck-reservation` does for the corroborated case.
- **A regression spec pins it.** The six-step reproduction above, asserting that B's write after step 4 succeeds, and that C's own storage holds the missed revision without anyone having read through C.

# Design notes for the implementer (not settled — decide in this ticket)

**The discriminator is already in storage, one layer down.** `savePendingTransaction(actionId, transform, rev, latch)` stores the revision each pending record claims, but `listPendingTransactions` yields only action ids and `GetBlockResults`' `state.pendings` is therefore `ActionId[]`. Surfacing that revision makes the two cases locally separable without asking anyone:

- a genuine live rival is racing for **the same slot** — its record's rev equals the rev the incoming pend is requesting;
- a commit this member missed sits **below** the incoming request — the cohort has moved past that revision, and this member's copy of the reservation is the only thing still claiming it.

Verify that claim before building on it; it is inferred from the storage contract and from the reproduction's numbers (C's record at rev 2 while the incoming pend requested rev 3), not from a test that isolates it.

**Then there are two shapes of answer, and they are not exclusive.**

- *Heal at the vote.* On finding a below-slot record, the member reconciles the block from the cohort (the machinery `applyConsensusOperation`'s behind path already uses) and then votes honestly. Correct and self-limiting — it only runs on the refusal path — but it puts a network round trip inside a promise vote, which today is local. Consider bounding it and voting `held` if it does not finish in time, so the worst case is today's behaviour rather than a stalled vote.
- *Say "behind" rather than "held".* Give the verdict a third kind so the coordinator can tell "somebody is writing this" from "one member is behind", answer the writer accordingly, and drive the healing outside the vote. More wire surface, and a new vote kind is a signed-payload change — the same care `a-contended-pend-refusal-is-permanent-on-a-small-cohort` took.

**Do not reach for a time bound.** "This record has been here a while, drop it" is the guess the unpromotable-pending sweep exists to avoid, and it is not needed here: the cohort's committed history is the authority, and it is reachable.

**Do not raise the retry budget.** The originating report asked whether `maxAttempts` is wrong when the holder is slow rather than gone. Measured: it is not. On the same mesh with a genuinely live, progressing holder (1.5 s of injected latency on every cluster delivery to one member, making one write's pend-to-commit window 27 s), a contending writer absorbed the contention in **two** retries and committed at 51.5 s. The budget only looks wrong against a record that will never clear — and against that one, no budget is enough. Fix the record.

**Check the `noteStuckReservation` NOTEs when you are done.** Both of them describe residuals of this defect. If the fix removes the remote-only-reservation case, say so there rather than leaving a NOTE that reads as still-open.

# TODO

- [ ] Rebuild the six-step reproduction as a spec in `packages/db-p2p/test/`, from `member-leaves-and-returns.spec.ts`'s `onClusterDelivery` mechanics and `util/node-count-mesh.ts`. Assert the *fixed* behaviour: after the fault ends, the next write from another machine succeeds, and the behind member's own storage holds the missed revision without anything having read through it.
- [ ] Confirm that a pending record's stored `rev` really does separate a live rival from a missed commit, and that it survives to where the vote can see it. Surface it on `state.pendings` (or a sibling field) if it does.
- [ ] Decide between healing at the vote and a new "behind" verdict kind; record the decision and what you rejected, at the site.
- [ ] Implement it in `ClusterMember.validatePendOperations`' pending-rival branch, reusing whatever `a-write-reported-torn-can-already-be-saved` settles about how a member decides an action is already committed — that ticket is answering the same question one branch over, and two different answers in one method would be worse than either.
- [ ] Cover the case the fix must NOT break: a genuinely live rival inside its pend-to-commit window still gets a `held` vote and the writer still retries. `packages/db-p2p/test/cluster-pend-held-vote.spec.ts` and `concurrent-two-member-writes-do-not-tear.spec.ts` are the existing guards; check they still mean what they say.
- [ ] Update `docs/correctness.md` Theorem 9 — its `held` paragraph asserts the liveness this ticket is restoring — and the premise sentence in `validatePendOperations`' own doc comment, which is what made the case invisible to review.
- [ ] Re-examine the two `noteStuckReservation` NOTEs and the `coordinator-repo:pend-held-uncorroborated` path; say in the handoff what a wedge looks like in the logs after the fix.

# Note from `a-write-reported-torn-can-already-be-saved` (landed 2026-09-17)

What that ticket settled, for the "reuse what it settles" item above: a member decides whether its OWN content was built from a committed `(actionId, rev)` from a per-block `lineageFloor` in `BlockMetadata` plus the revision index (`IBlockStorage.lineageOf`, answers `contains | excludes | behind | unknown`); the cohort-level answer is folded by `judgeCohortLineage` in db-core, asked by the writer through `ITransactor.getLineage`. It is deliberately member-local and read-only — no member consults a peer to answer. That is a different question from this ticket's: your stuck member is BEHIND (its `latest` is below the record's revision, so `lineageOf` answers `behind`), and what it needs to know is whether the COHORT committed the action its pending record names, which only the cohort can say. The revision each pending record was pended at (`savePendingTransaction`'s `rev`) is still the discriminator this ticket proposes; nothing in the landed change surfaces it. Reuse the shape (a local fact kept where the write happens, a verdict enum rather than a boolean) rather than the predicate.
