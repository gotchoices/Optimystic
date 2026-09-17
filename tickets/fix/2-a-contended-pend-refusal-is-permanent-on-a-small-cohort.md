description: When two machines write to the same data at the same moment, one of them can be told its write was rejected as invalid and give up, when all that actually happened is that it needed to wait its turn and try again. On a small group of machines a single "not right now" answer is enough to trigger this.
architecture: docs/correctness.md
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations`, the branch that returns `pending conflict: block … held by unresolved action(s)` — it votes *reject*)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (the `rejected-by-validators` branch — every reject past the threshold becomes `ValidatorRejectionError`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`classifyPendingConflictRejection` — the safety net that already converts this rejection into a retryable conflict, and only when it can corroborate the rival in its OWN storage)
  - packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts (raise `PairsPerRun` to 8 to reproduce; it also fails at the shipped 4, about 1 execution in 15)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: A maintainer could reasonably say the writer should simply retry on any failure and treat this as a classification nicety rather than a defect; the counter-argument is that the codebase already draws this exact line on purpose — a conflict vote is deliberately kept out of the rejection count so a lost race cannot masquerade as a permanent verdict — and this path walks straight around it.
difficulty: medium
----

# The invariant being broken

The system distinguishes two reasons a cohort member can refuse a write, and the distinction is load-bearing:

- **A validity judgement** — the write is wrong and will be wrong on every retry. Enough of these is a permanent failure (`ValidatorRejectionError`), and the writer must not retry.
- **An optimistic-concurrency answer** — the write is fine but lost a race or arrived while a rival held the blocks. This is transient, and the writer is expected to refresh and retry.

`ClusterCoordinator` states this in its own vote-counting comment: a `conflict` vote must count toward neither approvals nor rejections, "or a lost race would masquerade as a validator rejection (permanent) or as silence — both wrong". `docs/correctness.md` Theorem 1 says the same thing in prose.

One refusal path does not respect it. When a member's pend validation finds the requested blocks held by a **different unresolved pending action**, it returns a plain invalid verdict, which becomes a `reject` vote. That condition is purely transient — the rival's pending record is removed when the rival commits or cancels — yet it is counted as a validity rejection.

# Why a small cohort turns that into a permanent failure

The coordinator computes `maxAllowedRejections = peerCount - ceil(peerCount * superMajorityThreshold)`. At the default threshold that is **zero for any cohort of three or fewer members**: two members at 0.67 or 0.75, three at 0.75. One reject vote therefore exceeds the threshold on its own, and the coordinator throws `ValidatorRejectionError` — the permanent answer — for what was a "someone else is holding this right now".

A two-machine deployment with two writers touching the same collection hits this whenever the two members briefly disagree about whether a rival's pending record is still standing. The members disagree routinely: one has applied the rival's cancel and the other has not yet, so the first approves and the second rejects.

# Measurement

Reproduced on the mesh harness during the review of `cancelling-a-refused-write-blocks-another-writers-commit`, at optimystic `e46e7d6f` plus that ticket's fix.

`packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts` with `PairsPerRun` raised from 4 to 8 — two nodes, `clusterSize: 2`, `superMajorityThreshold: 0.67`, 2–17 ms of latency on each remote cluster delivery, 8 concurrent write pairs per run, 3 runs per execution. Over three executions, **two failed**, each with three occurrences of:

```
Transaction rejected by validators (1/2 rejected): <peer>: pending conflict:
block <id> held by unresolved action(s) <actionId>
```

surfaced to the caller as `Error: Some peers did not complete: … cause=Transaction rejected by validators`. No `TornActionError` appeared in any of them — the tearing that ticket fixed is gone; this is a different failure reaching the same user.

At the shipped `PairsPerRun` of 4 the spec is *mostly* green, but not reliably: in a second, independent review pass it failed **1 of 15 executions** that were each verified to have run against an unmodified `race-resolution.ts` (source hashed before and after every execution, because two agents were editing the tree concurrently). The failure was this defect, not a tear. So the committed suite does go red on this — rarely enough to read as an unexplained flake rather than as a signal, which is the worst of both.

## A second candidate site: the coordinator's safety net has a hole

There is already a mechanism meant to stop this rejection reaching the caller, and it is worth knowing about before choosing between the two fixes above, because it explains why the failure is *intermittent* rather than constant.

`CoordinatorRepo.classifyPendingConflictRejection` catches exactly this `ValidatorRejectionError` and converts it into a retryable conflict — but it corroborates the claim only against the coordinator's **own** local storage: it re-reads the blocks and requires some block's `state.pendings` to carry a rival action id. When it cannot corroborate, the rejection stays a throw (the method's own doc comment says so: "Unconfirmed — including read errors during confirmation — stays a throw, preserving fail-fast for genuine validation faults").

Under the injected latency the refusing member is routinely *ahead* of the coordinator: it has already applied the rival's pend, the coordinator has not, so the coordinator finds no rival locally and the net misses.

One captured run shows both outcomes side by side, two seconds apart on the same block, same cohort, same shape of rejection:

```
18:31:47.550  coordinator-repo:<A> pend-error  actionId=i8mH6OvZHwMOvvU5IRvB0w
   error='Transaction rejected by validators (1/2 rejected): <B>: pending conflict:
          block hLkUSY5… held by unresolved action(s) s7RBFf3R9St7afvLJhEYKg'
   (no pend-conflict-classified line follows — thrown, and this is the failure the spec reports)

18:31:48.734  coordinator-repo:<A> pend-error  actionId=aZwpPONnjW2gqAV4DOgUFQ
   error='… pending conflict: block hLkUSY5… held by unresolved action(s) Ho1bA41MvrFkhIuIkUtqjA'
18:31:48.735  coordinator-repo:<A> pend-conflict-classified  rivals=[hLkUSY5…:Ho1bA41MvrFkhIuIkUtqjA, …]
18:31:49.361  coordinator-repo:<A> pend-cluster-complete     actionId=aZwpPONnjW2gqAV4DOgUFQ  localVerdict=success
   (corroborated, retried, landed)
```

Captured with `DEBUG='optimystic:db-p2p:coordinator-repo*,optimystic:db-core:collection*'` on the mesh spec at `PairsPerRun` 4.

This does not replace either fix above — a net that catches a miscategorised refusal most of the time is still worse than not miscategorising it — but it is a third place the decision could be made, and it is the cheapest to reason about: the sibling `classifyStaleRejection` already carries a `NOTE:` anticipating exactly this ("when only remote members saw the newer revision (local storage still behind), staleness can't be confirmed locally and the rejection stays a throw. If that shows up in practice, extend confirmation with a quorum read"). **That revisit condition has now tripped**, for the pending-conflict sibling rather than the stale one. Whoever takes this ticket should settle whether the corroboration discipline changes for both classifiers or neither.

# What would fix it, and what would not

The decision to make is **what a member should vote when its pend validation loses to a rival's unresolved pending record**, and there are two places it can be made. They are alternatives, not both:

- **At the vote site** (`validatePendOperations` in `cluster-repo.ts`) — emit the vote type that already means "not now": a `conflict` vote, which the coordinator deliberately keeps out of the rejection count. The obstacle is that a `conflict` vote carries `Signature.conflictWith`, the winner's `messageHash`, and this path knows only the rival's *action id* from storage's pending list — it may hold no cluster record for that rival at all. Whoever takes this on has to decide what `conflictWith` means when the rival is known only to storage.
- **At the aggregation site** (the `rejected-by-validators` branch in `cluster-coordinator.ts`) — classify the reason rather than counting every reject alike. This is cheaper but puts a semantic distinction back into prose that is signed as free text, which the codebase has twice refused to do (both rejection reasons carry comments saying they stay plain prose because they enter the signing payload). A structured refusal kind on the signature would be the honest version, and that is a wire change.

Simply retrying on `ValidatorRejectionError` in the writer is **not** a fix: it erases the distinction the type exists to carry, and would make a genuinely invalid write retry forever.

# Related tickets, and how this one differs

- `bug-a-two-member-cohort-refuses-a-commit-both-members-hold` — also a two-member cohort answering wrongly, but about a **commit's durability verdict**, not a pend's vote classification. Different site, different mechanism.
- `a-write-reported-torn-can-already-be-saved` (in `implement/`) — touches `validatePendOperations`, but its *stale revision* branch, not the pending-conflict branch here.
- `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text` — the same seam seen from the consumer's side: a downstream repository already resorts to matching our error prose to decide what is retryable. A structured refusal kind would serve both.
