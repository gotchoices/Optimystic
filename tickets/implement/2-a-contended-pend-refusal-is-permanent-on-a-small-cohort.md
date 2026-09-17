description: When two machines write to the same data at the same moment, one of them can be told its write was rejected as invalid and give up, when all that actually happened is that it needed to wait its turn and try again. Give that "not right now" answer its own kind so it is never mistaken for a permanent verdict.
architecture: docs/correctness.md
files:
  - packages/db-core/src/cluster/structs.ts (`Signature`, `clusterVoteSigningPayload`, `clusterVoteVerificationPayload` — the vote kinds and the bytes each one signs)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations` pending-conflict branch, `evaluatePromise`, `handlePromiseNeeded`, `handleConflictVoteNeeded`, `getTransactionPhase`, the phase loop's `shouldPersist`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (vote counting in `executeClusterTransaction`, the `rejected-by-validators` and `conflict-race-lost` branches, `ConflictRaceLostError`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`pend`'s catch arm, `classifyPendingConflictRejection`, `noteStuckReservation`)
  - packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts (the mesh reproducer; its header comment names this defect and must be rewritten)
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts ("CoordinatorRepo pend — promise-phase pending-conflict rejection")
  - packages/db-p2p/test/stuck-reservation-named.spec.ts (rides on the same classification path; must stay green)
  - docs/correctness.md (Theorem 1 Case 2 and Theorem 9 prose describing the `conflict` vote; "Pend refusal reporting")
repro: verified
difficulty: medium
----

# What is wrong

A cohort member has exactly one way to say "no" to a pend: a `reject` vote. The coordinator counts every `reject` toward a permanent-failure threshold and, past it, throws `ValidatorRejectionError` — the answer that means "this write is invalid and will be invalid on every retry".

One of the things a member says "no" to is not a validity judgement at all. In `validatePendOperations` (`packages/db-p2p/src/cluster/cluster-repo.ts`), the branch whose reason reads `pending conflict: block … held by unresolved action(s) …` fires when the requested blocks are reserved by a *different* unresolved pending action. That reservation is removed the moment the rival commits or cancels. The condition is transient by construction, and the write will succeed on retry — but it is answered with the permanent verdict.

On a small cohort one such vote is enough. `maxAllowedRejections = peerCount − ceil(peerCount × superMajorityThreshold)` is **zero** for any cohort of three or fewer members at the default threshold (two members at 0.67 or 0.75, three at 0.75), so a single member's "someone else is holding this right now" becomes `ValidatorRejectionError` for the whole transaction.

The distinction this walks around is one the codebase already draws deliberately. `ClusterCoordinator`'s vote-counting comment says a `conflict` vote must count toward neither approvals nor rejections, "or a lost race would masquerade as a validator rejection (permanent) or as silence — both wrong". `docs/correctness.md` says the same in prose at Theorem 1 Case 2 and Theorem 9. There is simply no vote kind for the refusal this branch needs to make, so it borrows the wrong one.

# Reproduction (verified, this run)

`packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts` with `PairsPerRun` temporarily raised from 4 to 8 — two nodes, `clusterSize: 2`, `superMajorityThreshold: 0.67`, 2–17 ms of latency on each remote cluster delivery, 3 runs per execution. Built at `46609072` (`yarn workspace @optimystic/db-core run build` then the same for `@optimystic/db-p2p`), then four executions of:

```
cd packages/db-p2p && yarn test -- --grep "Concurrent writes on a two-member cohort"
```

Three passed; one failed on run 3 with:

```
pair 1 B: Error: Some peers did not complete: 12D3KooWPvD1…[block:zIuvvTIqPSSxdIdkbzf5hlByOqW1kzY8OUezHpDs1z4](in-flight)
cause=Transaction rejected by validators (1/2 rejected): 12D3KooWQJTb…: pending conflict:
block zIuvvTIqPSSxdIdkbzf5hlByOqW1kzY8OUezHpDs1z4 held by unresolved action(s) E6X9xxgV3uLMTCMHTwGZew
```

`1/2 rejected` is the whole defect in one line: one member of two said "not now", and that was reported to the writer as a rejection by validators. No `TornActionError` appeared. The spec was restored to `PairsPerRun = 4` afterwards; nothing else in the tree was touched.

# The shape of the fix

**Make the refusal kind representable, then give the transient kind a vote that does not count as a rejection.** The reason a boolean-plus-prose result forces the wrong answer is that `evaluatePromise` returns `{ valid: boolean; reason?: string }` — one channel for two different kinds of "no" — and `handlePromiseNeeded` can only turn `valid: false` into `reject`.

Add a third `Signature` variant for "your blocks are held right now", alongside the existing `conflict`:

```ts
export type Signature =
  | { type: 'approve';  signature: string }
  | { type: 'reject';   signature: string; rejectReason?: string }
  | { type: 'conflict'; signature: string; conflictWith: string }  // rival's messageHash (resolveRace winner)
  | { type: 'held';     signature: string; heldBy: string }        // rival's ACTION id, from storage's pending list
```

The two retryable kinds stay distinct because they know different things. A `conflict` vote comes from the in-memory reservation table, where the member holds the rival's whole `ClusterRecord` and can name its `messageHash`. This new one comes from durable storage's pending list, which carries only an **action id** — and it fires precisely in the window where the rival has left the in-memory table (cleared at its pend-consensus) but not yet storage (cleared at its commit or cancel), so no `messageHash` is available to name. That is why `conflictWith` cannot be reused as-is: it is documented and consumed as a `messageHash`, and packing an action id into it would put two id spaces in one unlabelled signed field.

Each variant's extra is folded into the signed bytes by `clusterVoteSigningPayload`, which takes a single string — `heldBy` being one action id keeps that contract intact with no encoding scheme. Where several rivals are found, name the one the refusal returns on, exactly as the reason prose does today.

Backwards compatibility is explicitly not a constraint here (`AGENTS.md`), so this is a plain wire addition rather than a negotiated one.

## What follows from the new vote kind

- **Member phase machine** (`getTransactionPhase`): `held` votes must not count toward `Rejected` (the filter is already `type === 'reject'`, so this is free) and *should* join `conflict` in the `ConflictSuperseded` threshold, so a member whose blocks are provably unable to reach super-majority clears the loser's record instead of reserving its blocks against the very retry meant to win. Decide deliberately whether a `held` vote also forces `shouldPersist = false` the way a conflict vote does; on a cohort large enough that one `held` vote is not terminal, the current reject behaviour (persist) is defensible — say which you chose and why.
- **Coordinator** (`executeClusterTransaction`): count `held` separately, never in `rejectionCount`, and surface a `held`-answered shortfall as its own retryable error carrying peerId → rival action id — sibling to `ConflictRaceLostError`, checked in the same place (after the rejection threshold, before the generic shortfall). Mirror the conflict branch's `broadcastAbandonment` gate: broadcast only when the merged record itself proves super-majority is unreachable.
- **The generic-shortfall message is load-bearing wire text.** A downstream repo matches `Failed to get super-majority: …` verbatim. Keep it byte-identical and keep `held` votes out of its rejection count, exactly as the existing NOTE demands for `conflict`.

## The safety net this also closes

`CoordinatorRepo.classifyPendingConflictRejection` already exists to catch this `ValidatorRejectionError` and convert it to a retryable conflict — but it only converts when it can corroborate the rival in the coordinator's **own** storage, and under latency the refusing member is routinely ahead of the coordinator, so the corroboration misses and the rejection escapes as a throw. That is why the failure is intermittent rather than constant. The sibling `classifyStaleRejection` carries a `NOTE:` anticipating exactly this and naming a quorum read as the cure if it ever showed up in practice; it has now shown up, for the pending-conflict sibling.

With a signed `held` vote the quorum read is unnecessary: the refusal is *already* signed evidence from the member that holds the rival, so retryability stops depending on a local re-read. **Demote the local re-read from gate to enricher** — keep it to fill `StaleFailure.pending` and to feed `noteStuckReservation` when it succeeds, and return the retryable conflict either way. The `ConflictRaceLostError` arm in `pend`'s catch already shows the un-enriched shape (`{ success: false, conflict: true, reason }`).

Do **not** change `classifyStaleRejection` in this ticket. Its own rejection (stale revision, from the branch just above the one being changed) is a different arm of the same method, and it is the only place a losing writer learns the revision it lost to (`StaleFailure.staleAt`). Moving it to a non-counting vote would take that number away and belongs in its own ticket; say so in the review handoff if the work makes the case obvious.

Keep `noteStuckReservation` fed. It is the only thing that says out loud when a block is wedged behind a reservation that will never clear, its doc comment says it is fed only by the classifier, and `test/stuck-reservation-named.spec.ts` asserts the log line fires. A fix that silently starves it trades one defect for a worse one.

## What is not a fix

Retrying on `ValidatorRejectionError` in the writer erases the distinction the type exists to carry and would make a genuinely invalid write retry forever. Classifying the coordinator's reject votes by matching the reason prose is also out: that prose is fed to `computeSigningPayload` and signed, and the codebase has twice refused to put semantics into it for that reason — the `held` variant is the structured version of the same idea.

# TODO

- Add the `held` variant to `Signature` in `packages/db-core/src/cluster/structs.ts`, with its `heldBy` (rival action id) folded into `clusterVoteSigningPayload` and read back by `clusterVoteVerificationPayload`. Document on the variant why it is distinct from `conflict` (different id space, different window).
- Replace the `{ valid: boolean; reason?: string }` result of `validatePendOperations` / `evaluatePromise` with a discriminated refusal that can say *which kind* of no it is. Only the pending-conflict branch returns the transient kind; every other refusal (membership, stale revision, commit revision, refused pend, content digest, custom validator) keeps today's meaning.
- Have `handlePromiseNeeded` emit a signed `held` vote for the transient kind, and keep the `cluster-member:validation-pending-conflict` log tag byte-identical (specs capture by tag substring).
- Extend `getTransactionPhase` so `held` votes join `conflict` in the `ConflictSuperseded` threshold and never in `Rejected`; settle and document the `shouldPersist` question above.
- Count `held` separately in `ClusterCoordinator.executeClusterTransaction` and throw a dedicated retryable error carrying peerId → rival action id. Leave `rejectionCount`, the `rejected-by-validators` branch and the generic-shortfall message untouched.
- Catch the new error in `CoordinatorRepo.pend` and return a `StaleFailure` with `conflict: true`; reuse the existing corroboration body to fill `pending` and feed `noteStuckReservation` when it confirms, and return the conflict regardless when it does not.
- Replace the `NOTE:` block in `validatePendOperations` that currently describes this defect and names this ticket — it is the tripwire for the bug being fixed, so it goes rather than lingering as a false warning.
- Update the `NOTE:` on `classifyStaleRejection` whose revisit condition ("if that shows up in practice") has now tripped for its sibling: say what changed, and that the stale arm is deliberately left on local corroboration.
- Member-tier spec: a pend whose blocks are held by a different unresolved storage pending record produces a `held` vote, not a `reject`, and the vote's signature verifies over the payload including `heldBy`.
- Coordinator-tier spec: on a two-member cohort at `superMajorityThreshold: 0.67`, one `held` vote yields a retryable conflict and never `ValidatorRejectionError`. `test/cluster-coordinator-supermajority.spec.ts` is the nearest existing home.
- Update `test/coordinator-repo-pend-divergence.spec.ts` ("promise-phase pending-conflict rejection"): the rejection it injects is no longer the shape that arrives, and the uncorroborated case now returns a conflict instead of throwing.
- Raise `PairsPerRun` to 8 in `test/concurrent-two-member-writes-do-not-tear.spec.ts` and rewrite its header comment: the paragraphs explaining why it ships at 4, and the "read the message before assuming the escape broke" triage list, both exist only because of this defect. Run it several times — it is a sampling reproducer, and one green execution proves nothing.
- Update `docs/correctness.md` where it describes the `conflict` vote as the single non-counting refusal (Theorem 1 Case 2, Theorem 9, and "Pend refusal reporting"), so the two retryable kinds and what each one can name are stated once, in prose.
- Validate: `yarn workspace @optimystic/db-p2p run build`, `yarn workspace @optimystic/db-core run build`, `yarn typecheck`, then the db-core and db-p2p suites in the foreground with no redirection. `yarn lint:docs` after the docs edit.
