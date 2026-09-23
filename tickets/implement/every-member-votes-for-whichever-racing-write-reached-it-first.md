description: When two people write at the same time, neither write gets through on the first try — each machine votes for whichever of the two reached it first, so nobody gets enough votes and both have to start over. One of them should simply win, and the other should succeed on its second try.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises` — the fan-out that sends a vote-less record; `presignLocalCommit` is the shape to mirror)
  - packages/db-p2p/src/cluster/race-resolution.ts (`resolveRace` — the arbiter whose tie-breaks are never reached)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`findConflict` — the member-side scan that consults it)
  - packages/db-p2p/test/transaction-node-count-sweep.spec.ts (already reports the defect; its explanatory comment is wrong and its round-1 assertion is deliberately loose)
  - docs/correctness.md (Theorem 9, whose proof sketch rests on a step that never runs)
difficulty: medium
----
# Every member votes for whichever racing write reached it first

## What is wrong

When two writers race for the same block, each cohort member is supposed to pick the same winner: `resolveRace` in `packages/db-p2p/src/cluster/race-resolution.ts` is a total, deterministic function, and Theorem 9 in `docs/correctness.md` rests on every honest member computing the identical answer from it.

In a first-round collision it never gets the chance. `resolveRace`'s first comparison is the count of `approve` promise votes, and that comparison always decides — so the priority and message-hash tie-breaks below it, which are the parts that make every member agree, are dead code in exactly the case they exist for.

The counts always differ, and they differ for a reason that has nothing to do with either write's progress:

- `ClusterCoordinator.collectPromises` fans the record out to every cohort member **before any member has voted**, so the record a remote member receives carries zero approvals.
- The member it lands on has, by then, already voted on the rival — its own coordinator's record, or simply whichever arrived first — and that held record therefore carries at least that member's own approval.

So the comparison is one-versus-zero, every time, in favour of whatever the member saw first. The member votes `conflict` on the newcomer. Arrival order, not the arbiter, decides.

On a two-member cohort where each writer coordinates through its own node this is not merely non-deterministic, it is a guaranteed double loss: `ClusterCoordinator.updateMember` invokes the local member in-process while the rival's record is still on the wire, so each member holds its own coordinator's write and refuses the other's. Neither write reaches the promise bar. Both writers back off and re-drive. Which one gets through next is decided by backoff jitter, not by the hash.

That is the multi-re-drive the parent ticket was asked to find. It is also why a run appears to "settle into a pattern": the first mutual collision sets the two clients' backoff phases relative to each other, and they tend to stay in or out of phase for the rest of the run.

## Reproduction (verified)

Already in the tree, no setup: `packages/db-p2p/test/transaction-node-count-sweep.spec.ts` prints a table whose last column reports how the first round went.

```
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/transaction-node-count-sweep.spec.ts"
```

At `23b0fa1a`, three consecutive runs, every cohort size from 2 to 5 reports `round 1: both lost` — with no artificial latency at all. The spec passes: it deliberately does not assert that a writer wins the first round.

A second measurement, counting pend and commit rounds per side (a wrapper over `ITransactor.pend`/`.commit`, two-member mesh, 4 concurrent pairs per run, 2–15 ms of random latency on each remote cluster delivery in both directions — the same latency injection `packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts` uses):

| | pend rounds per run | refused | of which `conflict` | of which `held` | commit rounds | refused commits |
| --- | --- | --- | --- | --- | --- | --- |
| two members, baseline | 20, 24, 24 | 12, 16, 16 | 12, 14, 16 | 0, 2, 0 | 8 | 0 |
| four members, baseline | 15, 18, 13 | 7, 10, 5 | 6, 9, 4 | 0, 0, 1 | 8 | 0 |

Every refusal is at the **pend** phase. There were no commit refusals of any kind in any run.

## What this rules out

The parent ticket listed three candidates. Measured against the runs above:

- **`backlog/bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy`** — not this. That path needs `cohortCanMissAPend` (four members and up at the default threshold) and ends in a refused *commit*; here there were no commit refusals at any size, and the two-party relay shape the parent ticket measured is a cohort where every member must approve every pend.
- **A retry whose refresh does not adopt the winner's revision (a below-floor or lagging-replica read)** — not this. Every successful re-pend asked for a bumped revision, and no answer carried `staleAt` or `commit-not-durable`.
- **A retry that re-pends before the winner's record is released, and is `held` again** — this does happen, but it is secondary: 0 to 2 of the 12–16 refusals in a run. It disappears entirely once the symmetric conflict is fixed, because the loser stops colliding with a winner that is mid-commit.

## The fix

Have the coordinator collect its own member's promise **before** fanning the record out, and send the record carrying that promise — exactly what the commit round already does in `presignLocalCommit` (`packages/db-p2p/src/repo/cluster-coordinator.ts`), whose doc comment explains the same reasoning for commits.

Then two racing records arrive at each member carrying one approval each, the counts tie, the priority and hash tie-breaks finally run, and every member computes the same winner. The loser's member clears its own transaction and approves the winner, which reaches the bar on the first round.

### Measured with a prototype of exactly this

Same harness, same runs:

| | pend rounds per run | refused | of which `conflict` | of which `held` |
| --- | --- | --- | --- | --- |
| two members, pre-vote | 12, 12, 12 | 4, 4, 4 | 4, 4, 4 | 0, 0, 0 |
| four members, pre-vote | 12, 13, 12 | 4, 5, 4 | 4, 4, 4 | 0, 0, 0 |

One winner and exactly one re-drive per contended pair, identical across runs — the behaviour the maintainer's direction describes. The sweep table's round-1 column becomes `node 0 won` at sizes 2 and 3. The winner alternates between the two nodes across pairs, because the message hash decides and it varies per write.

The whole `db-p2p` suite passes with the prototype (3109 passing) **once the pre-vote replaces the local member's call in the round rather than being an extra attempt before it**. Getting that wrong fails `packages/db-p2p/test/cluster-coordinator-promise-retry.spec.ts` ("does NOT retry the LOCAL cluster on a throw"), which pins the contract that the local member is invoked exactly once in the promise phase — so a pre-vote that throws must count as that one call and its failure recorded in the round's summary (and its reputation accounting), not retried by re-including self.

### What the fix does not reach

At three members and up, a member that is *not* one of the two coordinators still votes for whichever record reached it first: its own approval re-inflates that record to two against the newcomer's one, and the tie-break is bypassed again one layer out. With the prototype the sweep table still reports `round 1: both lost` at sizes 4 and 5.

Closing that needs something structurally different — a member cannot retract an approval it has already signed, so "first arrival wins that member's vote" is not a rule that can simply be relaxed: relaxing it lets a member that approved a write which went on to reach super-majority also approve its rival, which is the split-brain `resolveRace`'s approvals-first order exists to prevent. Do not attempt it in this ticket. Record it instead (see the TODO below), so the next reader meets it rather than re-deriving it.

## Theorem 9 is overstated and must be corrected either way

`docs/correctness.md` Theorem 9 states "Under contention, at least one of the conflicting transactions commits per conflict cycle", and its proof sketch opens with "When conflicting transactions race, `resolveRace()` deterministically selects exactly one winner." Measured, no conflicting transaction commits in the first round at any cohort size from two to five, because the deterministic selection is never exercised. The statement is true only across a *retry* cycle, not per round. That correction is owed whether or not the residual above is ever closed.

`packages/db-p2p/test/transaction-node-count-sweep.spec.ts` carries the same misreading in the comment above its round-1 report, which attributes the all-lose round to storage keeping whichever pending record arrived first and both coordinators hearing a cohort refusal (`CoordinatorRepo.pendThroughCluster`, `cohortPendRefusals`). At sizes 2 and 3 that is not what happens: the pends never reach consensus at all — they are refused at the vote with `Conflict race lost`, raised by `ClusterCoordinator` and returned by `CoordinatorRepo.pend`. The comment describes a different, secondary path.

## TODO

- Collect this node's own member's promise before the fan-out in `ClusterCoordinator.collectPromises`, merge its promises into the record, and send that record to the remote members — mirroring `presignLocalCommit`'s shape and its doc comment.
- Exclude self from the round when the pre-vote ran, on the throw path as well as the success path, so the local member is still invoked exactly once in the promise phase. Record the pre-vote's outcome (success or failure) in the round's `summary` so the existing per-peer logging and reputation accounting see it.
- Check the interaction with `backlog/bug-a-late-promise-invalidates-the-commit-signatures-already-collected`: merging promises here happens before any commit signature exists, so it cannot invalidate one — confirm that stays true and say so at the site.
- Tighten `packages/db-p2p/test/transaction-node-count-sweep.spec.ts` at cohort size 2 to assert that exactly one writer wins the first round and the other loses exactly once, and correct the comment that explains the all-lose round.
- Correct Theorem 9 in `docs/correctness.md`: say plainly that `resolveRace`'s arbitration only decides when the two records reach a member with comparable approval counts, what makes that hold now, and that the guarantee is per retry cycle rather than per round.
- Record the three-members-and-up residual as a `NOTE:` at `resolveRace` in `packages/db-p2p/src/cluster/race-resolution.ts`: a non-coordinator member still votes for whichever record reached it first, the tie-break is still bypassed there, and why the approvals-first order cannot simply be relaxed to fix it.
- Document the promise-round pre-vote in `docs/internals.md` beside the existing commit-round description, and in `packages/db-p2p/docs/cluster.md` where the promise phase is described.
- Run the `db-p2p` suite and `yarn check`.
