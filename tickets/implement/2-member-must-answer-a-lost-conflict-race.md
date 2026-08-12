description: When two machines write the same data block at once, the machines that pick the other write simply say nothing back to the loser, so the losing write is reported as "nobody answered" — indistinguishable from the whole group being offline, and the caller has no way to know it should just try again.
prereq: abandoned-pend-holds-the-block
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts, docs/correctness.md
difficulty: hard
----

# A member that loses a conflict race must answer

Arm 1 of `fix/lost-conflict-race-abstains-and-orphans-the-block`. Land
`abandoned-pend-holds-the-block` first: that one stops a dead reservation from holding the
block, this one makes the refusal visible and correctly retryable. Neither alone is
sufficient.

## What happens today

When a member finds that an arriving transaction conflicts with one it is already holding,
and the held one wins the deterministic race, the member **returns the record unchanged with
no vote of its own in it**. Not an approval, not a rejection — nothing.

The path, in `packages/db-p2p/src/cluster/cluster-repo.ts`:

- `hasConflict(record)` (`:1523`) returns `true` after `resolveRace` says `keep-existing`.
- `getTransactionPhase` (`:764`) gates its `OurPromiseNeeded` return on
  `!record.promises[ourId] && !this.hasConflict(record)` (`:780`), so a blocked record skips
  the branch that would have produced a vote.
- It then falls through to `TransactionPhase.Promising` (`:791`), whose `processUpdate` case
  (`:460-466`) does nothing at all and logs `cluster-member:phase-promising-blocked`. The
  comment there — *"This state shouldn't normally be reached since OurPromiseNeeded is checked
  first"* — is wrong: this is the only way it is reached, and it is reached every time a race
  is lost.

The coordinator counts votes at `cluster-coordinator.ts:337-339`, finds none, and raises

```
Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)
```

which is byte-for-byte the message it raises when the cohort was genuinely unreachable. The
member made a decision and reported it as silence.

Reproduced deterministically, no network: `update` a member with pend X on `block-shared`,
then with conflicting pend Y on the same block. Y comes back with `promises: {}` and
`commits: {}` — no signature from that member in either map. (Throwaway spec built from the
existing helpers in `packages/db-p2p/test/cluster-repo.spec.ts`; the test to land is under
*TODO*.)

`docs/correctness.md` already specifies the intended behaviour — §Theorem 1 Case 2 says "The
loser is rejected", §Theorem 9 says "The loser is rejected and may retry". The implementation
never made that true.

## Why "just emit a reject vote" is the wrong fix

Two independent things break if the losing member signs an ordinary `reject`:

1. **It becomes a permanent refusal.** `getTransactionPhase` computes
   `maxAllowedRejections = peerCount - superMajority` (`cluster-repo.ts:770`), which is `0` at
   the default threshold on a three-member cohort. One reject ⇒ `TransactionPhase.Rejected`.
   The coordinator's mirror of that test (`cluster-coordinator.ts:344`) then raises
   `ValidatorRejectionError` — the "a validator says this write is invalid" error. A lost race
   is not that. It is "try again in a moment".

2. **It silently turns off the consumer's retry.** The consuming repo classifies retryability
   from the coordinator's error text
   (`../sereus/packages/cadre-core/src/control-write-retry.ts`). It matches
   `Failed to get super-majority: \d+/\d+ approvals \(needed \d+, 0 rejections\)` and retries
   it; it deliberately never retries anything reporting a non-zero rejection count, and never
   retries `Transaction rejected by validators`. So emitting rejections here would take a case
   that is retried today and make it un-retried — a regression, in the same change that was
   supposed to fix the bug.

And the reason must not be classified from the reject text either. This repo has already
settled that: `CoordinatorRepo.classifyStaleRejection` states the rule at
`coordinator-repo.ts:966-969` — *"The signed reject-reason text is never consulted — it is
free-form wire-visible prose and must not become control flow."* A `conflict:lost-race` string
prefix would be exactly that.

## The shape of the fix

The vote vocabulary is the root: it is `approve | reject`, and there is no way to say "not
now". Absence is overloaded to mean both "I am not reachable" and "I am refusing you in favour
of another transaction". Give the third outcome its own representation, so the phase machine
cannot express the abstention.

**1. A third vote category** — `packages/db-core/src/cluster/structs.ts:3-7`:

```ts
export type Signature =
	| { type: 'approve'; signature: string }
	| { type: 'reject'; signature: string; rejectReason?: string }
	/**
	 * This member refuses the transaction *for now*: it holds a conflicting transaction that
	 * won the deterministic race. Retryable — NOT a validity judgement, and never counted
	 * toward the permanent-rejection threshold. `conflictWith` is the winner's messageHash:
	 * structured, signed, and readable without parsing prose.
	 */
	| { type: 'conflict'; signature: string; conflictWith: string };
```

A discriminated union rather than another optional field, so a `conflict` without its
`conflictWith` does not typecheck. If the union proves too disruptive to the existing
construction sites, a flat `type: 'approve' | 'reject' | 'conflict'` with an optional
`conflictWith` is acceptable — say which you chose and why in the review hand-off.

`computeSigningPayload` (`cluster-repo.ts:704`) already appends the reason to the signed
payload; sign `conflictWith` the same way so the claim is integrity-protected in transit.
`verifySignature` (`:727`) reconstructs the payload from the signature object and needs the
matching branch.

Every other site that reads a vote type filters *positively* on `'approve'` and is unaffected:
`commit-cert.ts:25`, `dispute-service.ts:396`, `coordinator-repo.ts:1120`,
`cluster-repo.ts:785`/`:796`. The sites that need real changes are the two that count
rejections: `cluster-repo.ts:773` and `cluster-coordinator.ts:339`.

**2. The member answers** — `cluster-repo.ts`:

- `hasConflict` returns the blocking transaction's identity rather than a bare boolean —
  `{ blockedBy: messageHash } | undefined`. That is what makes `conflictWith` available, and
  it removes the boolean that currently loses the information.
- Add `TransactionPhase.OurConflictVoteNeeded`, returned when
  `!record.promises[ourId]` and a conflict is found. Its `processUpdate` case signs the
  conflict vote.
- That case must **not** persist the record (`shouldPersist = false`). The member is holding
  the winner, not this one; persisting the loser would reserve the block a second time and is
  half of what made the observed failure self-sustaining.
- Add a terminal phase for "this record can no longer reach super-majority because of conflict
  votes" — distinct from `Rejected`, so the logs and the reputation-adjacent paths keep
  meaning what they say. Members clear such a record rather than holding it.
- Delete the now-false comment at `:461-462` and make the bare `Promising` case explicit about
  what it means (all it should cover is "we have already voted, still waiting on others").

**2b. Added by the review of `abandoned-pend-holds-the-block` — drive the phase to a fixpoint.**
You are about to add two more phases here, so the pattern this arm is about is worth fixing
in the same pass rather than repeating.

`processUpdate` handles exactly one phase per delivery, and each branch that changes the
record then re-checks *by hand* for the one follow-on phase its author had in mind:
`OurCommitNeeded` re-checks for `Consensus`, and `abandoned-pend-holds-the-block` just added a
re-check for `Rejected` after `OurPromiseNeeded`. Any follow-on phase nobody thought to
re-check is silently skipped until the next delivery arrives.

That is not hypothetical. `getTransactionPhase` tests `!record.promises[ourId]` *before* it
tests the commit condition, so a member whose promise the coordinator never collected — normal
whenever the cohort is large enough that super-majority is less than the full peer count, e.g.
four peers at the default 0.75 threshold — receives the commit-phase record, lands in
`OurPromiseNeeded`, adds its promise, and stops. It is now in `OurCommitNeeded` but does not
act on it, so its commit waits for the coordinator's next commit-broadcast retry. Verified by
running it: a 4-peer record carrying three approvals and no vote from the member comes back
with the member's `approve` in `promises` and nothing in `commits`.

The behaviour is correct — the retry loop covers it — so this is latency and fragility, not a
lost commit. The fix is one invariant instead of N hand-written re-checks: after handling a
phase that mutated the record, recompute the phase and handle it again until it stops changing
(bounded — the phases only ever advance — with a small iteration cap so a bug cannot spin).
Then the two existing ad-hoc re-checks and the two phases this ticket adds all fall out of the
same loop, and the next phase added does too.

Consequence worth stating in the code: **a conflict vote is terminal for that record**. Once
it is merged into the promise map, `!record.promises[ourId]` is false forever, so the member
will never approve that same `messageHash`. A retry must be a *fresh* transaction, not a
re-presentation. `CoordinatorRepo.pend` already mints a new message (new expiration ⇒ new
hash) per call, so the normal retry path is fine — verify that the coordinator's own
missing-peer retry (`cluster-coordinator.ts` around `:723`) never re-presents a record to a
peer that has already conflict-voted it.

**3. The coordinator distinguishes the outcome** — `cluster-coordinator.ts:332-375`:

Count conflicts alongside approvals and rejections, and order the checks:

- rejections over the allowance ⇒ `ValidatorRejectionError`, unchanged;
- else conflicts present and approvals short ⇒ a new
  `ConflictRaceLostError` carrying the conflicting peers and the winning hashes;
- else ⇒ the existing shortfall error, with its message **left byte-identical**. That last
  point is load-bearing: it is the string the consumer matches to retry the genuinely-silent
  cohort. Conflicts must not be folded into the `rejections` number that message prints.

**4. The loss surfaces as a retryable result, not an error** — `coordinator-repo.ts:944-949`:

`StaleFailure.conflict` already exists for precisely this, and its own doc says so:
*"True when this failure is an optimistic-concurrency loss — the requested revision was taken,
**or a rival pend holds the blocks** — so a re-read, rebase and re-pend can win"*
(`packages/db-core/src/network/struct.ts`). Catch `ConflictRaceLostError` in `pend` and return
`{ success: false, conflict: true, reason: … }`. Then `Collection.sync` and the multi-collection
`pendPhase` retry it natively through `isConflictFailure`, exactly as they already do for a
confirmed stale revision — and the consuming repo never sees an error at all.

Leave `staleAt` absent: it is confirmed-only, and a lost race is not a revision claim.

## Hand-off to the consumer

Once this lands, the ordinary lost-race path stops producing an error, so
`../sereus/packages/cadre-core/src/control-write-retry.ts` needs no new matcher for it — but
the sereus ticket `tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio.md`
should be told (a) the shortfall message text is deliberately unchanged, so its existing
matcher keeps working for the genuinely-silent cohort, and (b) `ConflictRaceLostError` exists
and is retryable, in case it ever escapes by a path other than `pend`.

## TODO

- Land the regression test first, red: in `packages/db-p2p/test/cluster-repo.spec.ts`, under
  `describe('conflict detection')` — `update` a member with pend X on `block-shared`, assert
  its own approve landed; `update` with conflicting pend Y on the same block; assert
  `result.promises[ourId]` is a `conflict` vote naming X's `messageHash`. (Today it is
  `undefined` — that is the bug.)
- Widen `Signature` in `packages/db-core/src/cluster/structs.ts`; extend the signing payload
  and signature verification to cover `conflictWith`.
- Make `hasConflict` return the blocking transaction's identity; add the conflict-vote phase
  and its non-persisting `processUpdate` case; add the terminal "superseded by conflicts"
  phase; fix the stale comment at `cluster-repo.ts:461-462`.
- Keep conflict votes out of the rejection counts at `cluster-repo.ts:773` and
  `cluster-coordinator.ts:339`.
- Add `ConflictRaceLostError` and the ordered check in `executeTransaction`; leave the
  super-majority shortfall message text untouched and add a `NOTE:` saying why.
- Convert it to `{ success: false, conflict: true }` in `CoordinatorRepo.pend`.
- Update `docs/correctness.md` §Theorem 1 Case 2 and §Theorem 9 to say how the loser is told
  (the conflict vote) and that it is not a validity rejection. `backlog/feat-occ-priority-reservation`
  presumes a losing race is answered; that premise becomes true here — no change needed there,
  but confirm it while you are in the file.
- Run `yarn test` in `packages/db-p2p` and `packages/db-core`. Type-widening `Signature` will
  surface construction sites the compiler catches; check `yarn build` at the root too, since
  the cluster record crosses package boundaries. Report honestly in the review hand-off,
  including anything you could not verify without a real mesh.
- Not verifiable from this repo: the consuming scenario
  (`../sereus/packages/integration-tests/.../control-write-degraded-cohort-member.integration.ts`,
  ≥5 runs of the healthy-trio case) is the end-to-end gate. Note it as deferred to whoever
  works that repo rather than attempting it here.
