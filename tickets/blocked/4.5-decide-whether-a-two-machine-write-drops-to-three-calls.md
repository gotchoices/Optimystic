description: A one-row write on a two-machine group still sends the other machine four requests. A design that cuts this to three without changing any signed data is ready, but the ticket that asked for it said to decide only once the reporter has re-measured write latency now that each request costs one network round trip instead of two. This needs that measurement and a yes or no.
architecture: docs/correctness.md#theorem-1-consensus-safety-no-conflicting-commits
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/cluster/i-cluster.ts, packages/db-core/src/cluster/structs.ts, docs/correctness.md, docs/internals.md, packages/db-p2p/docs/cluster.md
----

# Decide whether a two-machine write drops to three requests

**Blocked on:** a dependency outside this repository plus a decision. The reporter of GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29) re-runs `message-latency.mjs` on a relayed two-machine pair (and, if possible, on phones) now that `a-request-reuses-a-pre-negotiated-stream` has landed, and a maintainer accepts or declines the design below with those numbers in hand. The planning ticket (`feat-fewer-consensus-calls-per-write`) set that condition itself: "the value of 4 → 3 must be weighed against consensus risk with that number in hand."

**To accept:** record the measured numbers at the bottom of this ticket and delete it (or move it to `complete/`). Two implement tickets are already written and wait on this one: `a-cluster-request-carries-owed-consensus-deliveries`, then `a-two-member-pend-defers-its-final-delivery-to-the-commit`.

**To decline:** delete this ticket and both implement tickets, and add an accepted-tradeoff `NOTE:` at `commitTransaction` in `packages/db-p2p/src/repo/cluster-coordinator.ts` saying that a two-member write costs four requests to the other member, why that was kept, and the revisit condition (for example, "if a re-measure shows writes on two-machine groups dominated by the request count").

## What we know now

A write is two agreement rounds with the group, one after the other: **reserve** (the "pend": store the change as pending on every machine) and **commit** (make it the new committed version). Each needs two requests from the machine coordinating the write to the other machine — one to collect its vote, one to deliver the decision — so a two-machine write is four requests. The reporter measured about 290 ms per half on Node over a public relay, and 3.0–3.6 s per half on phones, before stream reuse. Stream reuse removes one network round trip from each request, so the expected write is now about four relay round trips instead of eight. The proposal below makes it three.

Per write, on a two-machine group, at one relay round trip per request after stream reuse:

| | requests to the other machine | relay round trips |
| --- | --- | --- |
| today (after stream reuse) | 4 | ~4 |
| proposed | 3 | ~3 |

So the saving is about one quarter of a write's network time on a two-machine group, and nothing on groups of three or more (see *Why only two machines*). Nobody has measured the after-stream-reuse number yet; that is what this ticket waits for.

## The proposal, in plain terms

Within one agreement round the other machine has to hear from the coordinator twice, and that cannot be avoided without changing what the signatures cover: its "apply" step needs the coordinator's commit signature, and the coordinator's commit signature covers the other machine's vote, so the vote has to travel first. So each round costs two requests. The saving comes from **overlapping the two rounds**: the reserve round's second request ("the group decided — apply it") is not urgent, because a reserved change only matters once its commit arrives. So on a two-machine group the coordinator holds that message back for a moment and sends it inside the commit round's first request. The other machine applies the reservation first, then votes on the commit, in that order, from one request.

Two pieces make that possible:

1. **Keep a signature the other machine already sends.** On a two-machine group the other machine, while answering the reserve vote, already signs its commit signature in the same answer (it sees both approvals at once). Today the coordinator throws that signature away and asks for it again a round later. The proposal keeps it when it was signed over exactly the votes the coordinator ends up with (on two machines it always is), so the coordinating machine reaches the decision, and applies it, as soon as the first answer comes back.
2. **Let one request carry decisions the coordinator still owes.** A request to a machine may carry, ahead of its own record, any already-decided records that machine has not yet been sent. The receiving machine applies them first, in order, then handles the request. That is ticket `a-cluster-request-carries-owed-consensus-deliveries`, which also helps on its own: a decision that a machine missed (today re-sent by a background timer) now reaches it with the next ordinary request.

The commit step still takes two requests (piece 1 turns its second request from a vote request into the "apply it" message, which is the same count), and its acknowledgement to the writer still waits until the other machine reports it holds the write, exactly as today.

## Why it keeps the guarantees in `docs/correctness.md`

No signed byte layout changes, no new kind of vote, and no threshold changes. Every record a machine accepts is still validated by the same `ClusterMember.update` path and needs the same signatures; the proposal changes only *when* a decided record reaches the other machine and *which request carries it*.

- **Theorem 1 (who wins a collision).** Both records still go out carrying the coordinating machine's own vote, so the vote-count comparison in `resolveRace` (`packages/db-p2p/src/cluster/race-resolution.ts`) runs exactly as now. The other machine votes on the commit only after applying the reservation in the same request, so its content check (`validateCommitOperations`) still runs against its own pending copy.
- **Theorem 6 (a saved write is durable).** Unchanged. The commit is acknowledged only when a strict majority — both machines, on a group of two — report holding it.
- **Theorem 9 (progress under contention).** Unchanged in kind. A machine already stops holding its in-memory reservation for a record once it signs that record's commit, and before applying it; on a two-machine group that gap gets longer (up to the moment the commit arrives). What blocks a rival write during the gap is the coordinating machine's stored pending record, which answers the rival with a "held" vote, and on two machines one such vote already stops the rival. This is the same reasoning the existing text gives ("the safety argument is quorum intersection, NOT the reservation").
- **Theorem 14 (durable commit proofs).** Unchanged: proofs are built from records with the same signatures over the same hashes. A signature is kept only when the vote map it was signed over equals the record's, so no proof ever carries a mismatched signature.
- **Who applies first** (*A behind member actively reconciles* in `docs/internals.md`). On a two-machine group the coordinating machine now applies first and the other machine second, instead of the reverse. That is the order a group of four or more already uses, and the existing second-reconcile step for a coordinating machine that is behind covers it.
- **Machines on an older build.** A machine advertises on its answers that it understands carried records. The coordinator holds back a decision only for a machine that has advertised it; anything else gets today's four requests. An older coordinator never sends carried records.

## The one rule that changes, and the proposed text

`docs/correctness.md` §2 says a reserve that one member refused when applying it has to reach the writer as a retryable conflict, and today that refusal arrives with the reserve's answer. Under the proposal, on a two-machine group, the other machine applies the reservation only when the commit's first request arrives, so its refusal arrives during the commit. The proposal answers the commit with that refusal, as the same retryable conflict, and the writer re-reads and retries exactly as it would have. Proposed addition to that paragraph:

> On a two-member cohort the remote member's apply of the pend is carried on the first request of the action's commit, so its refusal reaches the coordinator there rather than with the pend's answer; `CoordinatorRepo.commit` answers a commit that was not acknowledged with that refusal, the same retryable conflict the pend would have returned. A pend answer on a two-member cohort therefore rests on the coordinating member's own verdict alone, which is the residual this paragraph already names for a member reached only by the commit-retry timer, moved into the ordinary path for that one cohort size.

## Alternatives considered and rejected

- **Answer the vote and the commit in one request** (the planning ticket's second direction). The other machine cannot apply on its own signature alone: on a group of two, a decision needs both commit signatures, and the coordinator's cannot exist before the other machine's vote, because it covers that vote. Making it possible means either a new signed layout (breaking stored proofs, Theorem 14) or letting one machine apply on fewer commit signatures than a strict majority. Both weaken a stated guarantee for one request; rejected.
- **Fold reserve and commit into one agreement** (the third direction). Four requests become two, but the stored reservation is what collision handling, "held" votes, slot holds (Theorem 9) and the writer's half-finished-write recovery (`Collection.completeOwnEntry`) are built on. Rejected as too wide for one request's saving.
- **Send the commit's vote request inside the reserve's decision**, as the planning ticket first framed it. That needs the coordinating machine to vote on the commit before it has applied the reservation, so its content check would have nothing to check. The proposal is the same overlap the other way round: the coordinator applies first (piece 1), so its vote on the commit is a real check.

## Why only two machines

On three machines the reserve vote needs all three approvals, so neither remote machine can sign its commit while answering the vote, and the coordinator cannot apply before a second request. Groups of three or more keep four requests. Two machines is an ordinary, supported size here (`docs/architecture.md`, *Supported deployment sizes*), and it is the reporter's.

## If we do nothing

Writes on two-machine groups keep costing four requests to the other machine. Nothing is wrong; it is one round trip slower than the floor this protocol allows without weakening a guarantee.

## How reversible

Fully. Holding back the decision has a setting (`pendDeliveryDeferralMs`, `0` turns it off and restores today's four requests). Carried records are an optional field older machines ignore. No stored data, signed layout or wire field an older build depends on changes, so reverting is a code revert.

## Measured numbers

(Record here: setup, per-request time, per-write time, before and after stream reuse.)
