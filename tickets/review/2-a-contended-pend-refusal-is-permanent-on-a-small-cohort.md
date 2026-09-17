description: When two machines wrote to the same data at the same moment, one could be told its write was permanently invalid when all that had happened was that it needed to wait its turn. That "not right now" answer now has its own kind, so it is never mistaken for a permanent verdict.
architecture: docs/correctness.md
files:
  - packages/db-core/src/cluster/structs.ts (`Signature` — the new `held` variant; `clusterVoteVerificationPayload`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`PromiseVerdict`, `invalidVerdict`, `verdictOf`, `validatePendOperations`, `evaluatePromise`, `handlePromiseNeeded`, `signPromiseVerdict`, `getTransactionPhase`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`BlocksHeldError`, the `pend-blocks-held` branch and `refusalsProveUnreachable` in `executeTransaction`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`answerBlocksHeld`, `corroborateHeldBlocks`, `pend`'s catch arm, the `classifyStaleRejection` NOTE)
  - packages/db-p2p/test/cluster-pend-held-vote.spec.ts (new, member tier)
  - packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts (new describe, coordinator tier)
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts (rewritten describe)
  - packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts (one assertion updated)
  - packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts (`PairsPerRun` 4 → 8, header rewritten)
  - docs/correctness.md (Theorem 1 Case 2, Theorem 9, "Pend refusal reporting")
  - docs/internals.md (the pend answer-class bullet list)
----

# What was built

A cohort member used to have exactly one way to say no to a pend: a `reject` vote, which the coordinator counts toward a permanent-failure threshold and turns into `ValidatorRejectionError` — the answer meaning "this write is invalid and will be invalid on every retry". One of the things it said no to was not a validity judgement at all: the requested blocks were reserved by a *different* unresolved pending action, a reservation removed the moment that rival commits or cancels. On a cohort of three or fewer members the permanent-rejection threshold allows zero rejections at the default super-majority, so one member's "someone else is holding this right now" sank the whole transaction permanently.

That refusal now has its own vote kind.

**Wire.** `Signature` gains a fourth variant, `{ type: 'held'; signature; heldBy }`. `heldBy` is the rival's **action id**, which is a different id space from `conflict`'s `conflictWith` (a messageHash) — the two cannot share a field, because a `conflict` vote reads the member's in-memory reservation table (which holds the rival's whole record) while a `held` vote reads durable storage's pending list (which holds only ids), and the held window is precisely where no messageHash exists any more. `heldBy` is folded into the signed payload by `clusterVoteSigningPayload` and read back by `clusterVoteVerificationPayload`, so the claim is integrity-protected rather than free-floating prose. No backwards-compatibility negotiation (per `AGENTS.md`).

**Member.** `validatePendOperations` and `evaluatePromise` now return a discriminated `PromiseVerdict` instead of `{ valid: boolean; reason? }`. Only the pending-conflict branch returns the transient `held` kind; every other refusal (membership, block-unavailable, stale revision, commit revision, refused pend, content digest, custom validator) keeps today's meaning through `invalidVerdict` / `verdictOf`. `signPromiseVerdict` is the single place a verdict becomes a vote. `getTransactionPhase` counts `held` with `conflict` for the terminal-but-retryable `ConflictSuperseded` threshold and never for `Rejected`.

**Coordinator.** `executeTransaction` counts `held` separately and, after the rejection threshold and the conflict branch, raises `BlocksHeldError` carrying peerId → rival action id. `rejectionCount`, the `rejected-by-validators` branch, and the generic-shortfall message are untouched — the last is byte-identical wire text a downstream repo matches verbatim, and it is still pinned by an assertion.

**Coordinator repo.** `CoordinatorRepo.pend` catches `BlocksHeldError` and returns a `StaleFailure` with `conflict: true` **unconditionally**. The local re-read that used to gate the conversion is demoted to an enricher (`corroborateHeldBlocks`): when it corroborates, the rivals fill `StaleFailure.pending` and feed `noteStuckReservation`; when it does not — the ordinary shape under delivery latency, where the refusing member is ahead of the coordinator — the conflict is returned bare. `classifyPendingConflictRejection` is gone: the refusal it existed to catch no longer arrives as a `ValidatorRejectionError`, and keeping it would have converted genuine validation faults into silent retries whenever this node happened to hold a pending record for the block.

## Decisions taken, for the reviewer to weigh

**`shouldPersist` on a `held` vote: persist (unchanged from the reject behaviour).** Documented at the `OurPromiseNeeded` branch of the phase loop. A `conflict` vote clears the record because that member holds the *winner* in its in-memory table and persisting the loser would reserve the same blocks twice. A `held` vote has no such twin — the rival lives in durable storage, not in that table — so this record's entry is the only one, and dropping it would only make the member forget a transaction the rest of the cohort may still carry to super-majority. Where one `held` vote *is* terminal (small cohort), the recomputed phase is `ConflictSuperseded`, which clears the record anyway.

**Precedence.** A genuine `reject` outranks a `held` (permanent beats transient); a `conflict` outranks a `held` (both retryable, but a messageHash is strictly more actionable than an action id). Both orderings are asserted.

**The abandonment-broadcast gate now includes `held`.** `refusalsProveUnreachable = rejections + conflicts + held > maxAllowedRejections` — the same sum a member re-derives as `ConflictSuperseded`/`Rejected` from the signed votes, which is what makes the broadcast proof-carrying. The conflict branch's gate moved to this shared expression; before `held` existed it under-counted nothing, and now it would.

**`classifyStaleRejection` deliberately untouched.** Its `NOTE:` revisit condition ("if only remote members saw it, extend with a quorum read") has now demonstrably tripped for its former sibling, and the NOTE says so and says what the cure actually was. The stale arm is left on local corroboration because `StaleFailure.staleAt` — the only place a losing writer learns the revision it lost to — can only be reported from a revision this node read itself. **Moving it to a non-counting vote is its own ticket and this work did not make that case obvious enough to file one:** unlike the pending-conflict arm, no measured failure points at it, and the fix would have to answer what replaces `staleAt` first.

# How to exercise it

Build first — the test harness refuses a stale build:

```
yarn workspace @optimystic/db-core run build && yarn workspace @optimystic/db-p2p run build
```

**Member tier** — `packages/db-p2p/test/cluster-pend-held-vote.spec.ts` (new, 5 arms). A rival unresolved pending action produces `held` and not `reject`; `heldBy` names it; the vote verifies over the payload including `heldBy` and stops verifying when `heldBy` is rewritten; a redelivered pend for the holding action itself is approved; and a stale revision still outranks the transient refusal.

```
cd packages/db-p2p && yarn test -- --grep "a pend queued behind a live reservation"
```

**Coordinator tier** — `cluster-coordinator-supermajority.spec.ts`, describe "ClusterCoordinator blocks held by a rival unresolved action" (6 arms). The headline: on a **two-member cohort at `superMajorityThreshold: 0.67`** (super-majority 2, `maxAllowedRejections` 0 — the measured shape of the defect), one `held` vote yields `BlocksHeldError` and never `ValidatorRejectionError`. Also: the proof-carrying abandonment broadcast; reject and conflict both outranking held; the generic-shortfall text staying byte-identical; and a cohort at 0.51 committing *despite* a held vote (it refuses, it does not veto).

```
cd packages/db-p2p && yarn test -- --grep "ClusterCoordinator"
```

**Coordinator-repo tier** — `coordinator-repo-pend-divergence.spec.ts`, describe "CoordinatorRepo pend — blocks held by a rival unresolved action". Corroborated → conflict with `pending` filled; uncorroborated → conflict returned bare (this is the arm that used to throw); the request's own action never corroborates against itself; and a genuine `ValidatorRejectionError` still throws even when local storage holds a pending record for the block.

**The regression that must stay fed** — `stuck-reservation-named.spec.ts` rides the same classification path (`coordinator-repo:pend-conflict-classified` and its `distinctRefusedActions`, then `coordinator-repo:stuck-reservation`). It is green unchanged; a fix that starved `noteStuckReservation` would have traded one defect for a worse one.

**The mesh reproducer** — `concurrent-two-member-writes-do-not-tear.spec.ts` now ships at `PairsPerRun = 8` (was 4) and its header is rewritten: the paragraphs explaining why it shipped at 4, and the "read the message before assuming the escape broke" triage list, both existed only because of this defect. It is a *sampling* reproducer — random, unseeded delivery latency — so one green execution proves nothing.

```
cd packages/db-p2p && yarn test -- --grep "Concurrent writes on a two-member cohort"
```

Measured this run: **4 consecutive executions green at 8** (3 runs each, ~28s per execution). The ticket recorded 2 of 3 executions failing at 8 on the pre-fix build, with `1/2 rejected … pending conflict: block … held by unresolved action(s)`.

# Validation run

- `yarn workspace @optimystic/db-core run build`, `yarn workspace @optimystic/db-p2p run build` — clean.
- `yarn typecheck` — clean.
- `yarn lint` — clean. `yarn lint:docs` — 46 documents, all citations resolve.
- `yarn workspace @optimystic/db-core test` — 1782 passing.
- `yarn workspace @optimystic/db-p2p test` — 2976 passing, 63 pending, 0 failing.

One pre-existing spec needed a one-line update rather than a papering-over: `coordinator-repo-stale-classification.spec.ts`, "rethrows when the request carries no rev", asserted `storage.getCalls === 1` *because* the removed pending-conflict classifier ran a speculative rev-independent read on every validator rejection. With that classifier gone the count is 0, which is the intended consequence — the read now happens only on the path that has signed evidence to enrich. The assertion and its comment were updated to say that.

# Known gaps — treat the tests as a floor

- **Nothing exercises a `held` vote end-to-end on a real mesh under the member→coordinator→writer path with a *partial* cohort.** The coordinator-tier arms use mock clients; the mesh arms reach the held path only incidentally (`stuck-reservation-named` and the two-member reproducer). A cohort where only *some* members hold the rival — one large enough that `held` is not terminal — is covered by reasoning and by the 0.51 "refuses but does not veto" arm, not by a mesh test.
- **`corroborateHeldBlocks` scans every block of the request on every held refusal.** It re-reads what `validatePendOperations` already read on the member side. Fine at current block counts; it is one `get` on a path that is already answering a failure.
- **The un-enriched answer carries no `pending` and no `staleAt`.** `BlocksHeldError.heldBy` (peerId → action id) is dropped at the `CoordinatorRepo` boundary because `StaleFailure` has no field for it — the same deliberate drop the `ConflictRaceLostError` arm documents. A caller that wanted to *wait on* the holder rather than re-race it would need a typed field; nothing should recover it by parsing `reason`.
- **`noteStuckReservation` is fed only on the corroborated path.** Under heavy latency a wedged block on a remote member could therefore go longer before being named. That is not new — the counter was always local-corroboration-only — but the uncorroborated path is now *reached more often*, because it no longer throws. Worth a reviewer's eye on whether the stuck-reservation signal needs a second feed.
- **Equivocation accounting treats a `held`→anything flip as equivocation**, which is correct and free (`detectEquivocation` compares `type`), but no test covers a `held` flip specifically.
- The member-tier spec recomputes the v1 promise-hash preimage by hand to verify the signature. If `computeClusterPromiseHash`'s preimage ever changes, that helper drifts silently rather than failing loudly.

# TODO for review

- Adversarial pass over the vote-kind threshold arithmetic: confirm no path counts `held` as an approval or a rejection, at either tier.
- Check the `refusalsProveUnreachable` change to the *conflict* branch's broadcast gate is a strict improvement and not a behaviour change anyone depended on.
- Confirm removing `classifyPendingConflictRejection` leaves no reachable `ValidatorRejectionError` that is really a transient refusal.
- Sanity-check the docs edits (correctness.md Theorem 1 Case 2 table and Theorem 9 addition, internals.md bullet) against the code they describe.
