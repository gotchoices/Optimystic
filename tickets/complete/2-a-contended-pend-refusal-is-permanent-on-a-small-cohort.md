description: When two machines wrote to the same data at the same moment, one could be told its write was permanently invalid when all that had happened was that it needed to wait its turn. That "not right now" answer now has its own kind, so it is never mistaken for a permanent verdict.
architecture: docs/correctness.md
files:
  - packages/db-core/src/cluster/structs.ts (`Signature` — the `held` variant; `clusterVoteVerificationPayload`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`PromiseVerdict`, `invalidVerdict`, `verdictOf`, `validatePendOperations`, `evaluatePromise`, `handlePromiseNeeded`, `signPromiseVerdict`, `getTransactionPhase`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`BlocksHeldError`, the `pend-blocks-held` branch and `refusalsProveUnreachable` in `executeTransaction`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`answerBlocksHeld`, `corroborateHeldBlocks`, `noteStuckReservation`, `pendThroughCluster`)
  - packages/db-p2p/src/cluster/commit-proof.ts (`countApprovals` doc)
  - packages/db-p2p/test/cluster-pend-held-vote.spec.ts
  - packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts
  - packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts
  - docs/correctness.md, docs/internals.md
----

# What landed

A cohort member used to have exactly one way to refuse a pend: a `reject` vote, which the coordinator counts toward a permanent-failure threshold and turns into `ValidatorRejectionError` — the answer meaning "this write is invalid and will be invalid on every retry". One of the things it refused was not a validity judgement at all: the requested blocks were reserved by a *different* unresolved pending action, a reservation removed the moment that rival commits or cancels. On a cohort of three or fewer members the permanent-rejection threshold allows zero rejections at the default super-majority, so one member's "someone else is holding this right now" sank the whole transaction permanently.

That refusal now has its own vote kind, `held`, carrying the rival's action id in the signed payload. The member returns a discriminated `PromiseVerdict` instead of a boolean-plus-prose; the coordinator counts `held` apart from both approvals and rejections and raises the retryable `BlocksHeldError`; and `CoordinatorRepo.pend` converts that into a `StaleFailure` with `conflict: true` unconditionally, using its own storage re-read only to enrich the answer with rival action ids rather than to gate retryability.

The implement stage's own account of the change is accurate and is not restated here. What follows is the review.

# Review findings

## What was checked

The implement diff was read first, before the handoff summary. Beyond that:

- **Vote-kind threshold arithmetic at both tiers.** Every site in `packages/*/src` that reads `Signature['type']` was enumerated and inspected: `ClusterMember.getTransactionPhase`, the approval count in `packages/db-p2p/src/cluster/race-resolution.ts`, `countApprovingCommitVotes`, `pendCohortDurability`, `buildCommitCert`, `countApprovals` in `packages/db-p2p/src/cluster/commit-proof.ts`, the coordinator's four counters, and the dispute path's `verifyPromiseSignature`. No path counts `held` as an approval or a rejection, and no path treats "not `approve`" as "rejected".
- **Whether the change can let a write COMMIT that previously would have been refused** — the safety direction. It cannot, and the reason is arithmetic rather than inspection: the rejection branch fires only when `rejectionCount` exceeds `peerCount − superMajority`, which forces approvals below super-majority, so the branch this change removes votes from could never have been the one standing between a record and its commit. Theorem 1 is untouched.
- **The `refusalsProveUnreachable` change to the conflict branch's broadcast gate** (a review TODO). It is a strict improvement: the sum now matches exactly what a member re-derives as `ConflictSuperseded` from the same signed votes, where before it under-counted whenever a `held` vote was present, and under-counting only ever suppressed a broadcast that was in fact justified.
- **Whether removing `classifyPendingConflictRejection` leaves a reachable `ValidatorRejectionError` that is really transient** (a review TODO). `validatePendOperations` is the only producer of the pending-conflict reason, and it no longer produces a reject. The commit-tier sibling `validateCommitAgainstRefusedPend` still rejects, but it is a commit-record refusal that never reaches `CoordinatorRepo.pend`, and its own doc records that outcome as intended.
- **Whether a persisted `held` record can block its own retry.** It cannot: `resolveRace` ranks on approve votes first, a `held` record carries none, and the retry arrives with a higher aged priority, so `findConflict` clears the dead record rather than naming it the winner.
- **Retry termination.** The un-gated conversion makes this refusal retryable indefinitely in principle; `Collection.syncAttempts` bounds it with `maxAttempts`, `maxStalledAttempts` and `deadlineMs`, so a wedge ends at a loud `SyncRetryExhaustedError` rather than spinning.
- **Docs.** `docs/correctness.md` (Theorem 1 Case 2 table, Theorem 9) and `docs/internals.md` (the pend answer-class bullets) were read against the code they describe and are accurate, including the "three or fewer members" claim at the real default threshold of 0.75. Every other tracked doc was grepped for vote-kind prose; none enumerates them, so none was stale.
- **Lint, doc-lint, typecheck, both suites**, plus a targeted mutation check of the one new test (below).

## Major findings

**None.** Not "looks good" — the two places a defect of this shape would live were traced specifically. The first is the safety direction (could a non-counting vote let something commit), settled by the arithmetic above. The second is the retryability direction (could a permanent verdict now be softened into an endless retry), settled by the precedence order — `reject` is checked before `held` at both tiers, with tests on both — and by the bounded retry loop. Nothing was filed, and nothing was deferred to a later release.

## Minor findings — fixed in this pass

- **`answerBlocksHeld` dropped `BlocksHeldError.heldBy` silently.** The sibling `ConflictRaceLostError` arm carries an explicit note saying its `conflicts` map is dropped at the `StaleFailure` boundary and must never be recovered by parsing `reason`; the new arm did the same thing with no such note, and the handoff listed it as a gap with no home. A matching `NOTE:` now sits on `answerBlocksHeld`, including why the members' action ids must not be folded into `pending` — they are a different claim from the rivals this node read out of its own storage.
- **Four comments made stale, or left stale, by the new vote kind.** The `Promising` phase comment in `ClusterMember`'s phase loop ("we have already voted (approve, reject, or conflict)"), `detectEquivocation`'s "(approve↔reject)" — now stated as the type-generic rule it actually is — `countApprovals` in `packages/db-p2p/src/cluster/commit-proof.ts`, and `pendThroughCluster`'s "the two optimistic-concurrency classifiers a rejection is run through", which after this change describes neither the count nor the mechanism.
- **`handlePromiseNeeded` buried two awaits inside an object literal.** Restored to the named-local shape its sibling `handleConflictVoteNeeded` uses a few lines below.

## Test-coverage findings — one arm added

The implementer's tests cover the member tier, the coordinator tier's precedence and error class, and the coordinator-repo conversion. One safety-relevant property was uncovered on both the new held branch and the pre-existing conflict branch: that an abandonment broadcast is **withheld** when the record does not prove super-majority unreachable. Every existing arm asserts the broadcast *fires*; none asserts it stays silent below the bar, which is the direction that matters — an ungated broadcast is the unauthenticated "forget this" the shortfall note refuses to send, and it would clear live reservations on every member.

Added to `packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts`: a five-peer cohort at threshold 0.75 (super-majority 4, one rejection allowed) answering approve, approve, approve, held, silent — refused with `BlocksHeldError`, with no broadcast. It asserts off the coordinator's own `cluster-tx:abandon-broadcast` log line rather than off the mocks' inboxes, because the broadcast is fire-and-forget and "no record arrived" could only ever be a timing claim. Verified by mutation: removing the `refusalsProveUnreachable` gate fails it, restoring the gate passes it.

Two coverage gaps the handoff names were examined and deliberately left:

- **No test of a `held` → other-kind equivocation flip.** `detectEquivocation` compares the vote type generically and has existing coverage; a per-kind test would pin nothing the mechanism does not already guarantee.
- **The member-tier spec recomputes the v1 promise-hash preimage by hand.** The handoff calls this a silent-drift risk; it is not. The spec asserts the vote *does* verify, so a change to `computeClusterPromiseHash`'s preimage fails that assertion loudly rather than passing vacuously.

## Tripwires — parked in code, indexed here

- **The un-corroborated arm of `answerBlocksHeld` does not feed `noteStuckReservation`, and it is now reached far more often** (it used to throw). A block wedged behind a reservation only remote members can see therefore goes unnamed by the say-once stuck-reservation line. Parked as a second `NOTE:` on `noteStuckReservation`, beside the existing partial-cohort one, stating what is still observable (the per-occurrence `coordinator-repo:pend-held-uncorroborated` line with the holding action ids, and the writer's retry ceiling), why feeding it a guess would be worse than leaving it unfed, and that the cure — count on the member side — is the one the existing note already names.

## Accepted tradeoffs

- **`classifyStaleRejection` stays gated on local corroboration.** Its `NOTE:` revisit condition has demonstrably tripped for its former sibling, and the implement stage rewrote the note to say so and to say why the stale arm is not following: `StaleFailure.staleAt` is the only place a losing writer learns the revision it lost to, and it can only be reported from a revision this node read itself. The decision is recorded at the site with its own condition; not re-filed.
- **`validateCommitAgainstRefusedPend` still refuses with a `reject` vote on a small cohort.** Its doc states the resulting hard failure as the intended outcome and names the channel that is supposed to answer cleanly instead. Left alone.

## Empty categories, with reasons

- **Nothing filed to `blocked/`.** No specification silence or contradiction was reached: `docs/correctness.md` already owns the vote-kind taxonomy and the change extends it consistently.
- **No pre-existing failures to report.** Both suites were green before and after the review edits, so `tickets/.pre-existing-error.md` was not written.
- **No size-debt ticket.** `cluster-repo.ts` measured 2867 lines and `coordinator-repo.ts` 3191 (`wc -l`), which is large, but this change added roughly a hundred lines to the first and fifty to the second; the split is a standing concern about those files rather than a finding about this diff, and `tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md` already claims the second file.

# Validation

Run from a clean rebuild of `@optimystic/db-core` and `@optimystic/db-p2p`, after the review edits:

- `yarn lint` — clean. `yarn lint:docs` — 46 documents, 146 anchored citations, 650 file mentions, 368 links, all resolve. `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-core test` — 1782 passing.
- `yarn workspace @optimystic/db-p2p test` — 2977 passing (the added arm), 63 pending, 0 failing.
- `concurrent-two-member-writes-do-not-tear.spec.ts` at its raised contention level is a sampling reproducer with unseeded delays, so one green run proves nothing. Five further executions (three runs each, 27–32s per execution) were all green, on top of the four the implement stage measured — nine consecutive green executions at the new level.
