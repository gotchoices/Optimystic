description: When two machines wrote the same data block at once, the machines that picked the other write said nothing back to the loser, so the losing write looked like "nobody answered" and could not be retried sensibly. Now the loser gets a signed "you lost to X, try again" answer, and the failure surfaces as a normal retryable conflict.
prereq:
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, packages/db-p2p/docs/cluster.md, docs/correctness.md, docs/internals.md
----

# Complete: a member that loses a conflict race answers

Arm 2 of `fix/lost-conflict-race-abstains-and-orphans-the-block` (arm 1 was
`1-abandoned-pend-holds-the-block`). Implemented in `dcaf7d5`, reviewed and extended here.

## What shipped

**A third vote kind.** `Signature` (`packages/db-core/src/cluster/structs.ts`) became a
discriminated union: `approve` | `reject` (optional `rejectReason`) | `conflict` (required
`conflictWith`, the winning transaction's `messageHash`). The union means a `conflict` without its
winner cannot typecheck. Each variant's extra field is folded into the signed payload, so it cannot
be rewritten in transit.

**The member answers instead of abstaining.** `hasConflict` became `findConflict`, returning the
winner's hash rather than a boolean. Two new phases in `cluster-repo.ts`: `OurConflictVoteNeeded`
(sign the conflict vote; never persist the record — this member holds the winner, and keeping the
loser would reserve the same blocks twice) and `ConflictSuperseded` (terminal but retryable, when
conflict votes make super-majority unreachable). Conflict votes count toward neither approvals nor
the permanent-rejection threshold at any site.

**A phase fixpoint.** `processUpdate` now loops phase → handle → recompute until the phase stops
advancing, replacing two hand-written re-checks. A record arriving with the cohort's super-majority
is promised, committed and applied in one delivery.

**The coordinator distinguishes the outcome.** Rejections-over-allowance → `ValidatorRejectionError`
(unchanged); then conflicts-present-and-approvals-short → new `ConflictRaceLostError` carrying
`peerId → winning hash` as data; then the legacy shortfall error, byte-identical, reserved for a
genuinely silent cohort. When the merged votes *prove* super-majority unreachable the coordinator
also reuses `broadcastAbandonment` so members free the loser's blocks immediately.

**A retryable result, not an error.** `CoordinatorRepo.pend` converts `ConflictRaceLostError` into
`{ success: false, conflict: true, reason }` — the `StaleFailure` shape `Collection.sync` and the
multi-collection `pendPhase` already retry via `isConflictFailure`. `staleAt` is deliberately absent:
a rival pend holding the blocks is not a revision claim.

## Review findings

Read the implement diff first, then the handoff. Checked: the phase machine against every vote
combination the thresholds admit, the coordinator's classification order, the pend conversion, the
signed-payload seam, every `Signature` consumer in the repo, and every doc file the change touched
or should have touched. Ran `yarn lint`, `yarn build`, `yarn test` (all workspaces): clean, 0
failing, 4001 passing across the monorepo (db-p2p 1596, db-core 1365).

**Fixed in this pass (minor):**

- **Two copies of the signed vote preimage, one already stale.** `dispute-service`'s
  `verifyPromiseSignature` rebuilt `hash:type[:extra]` itself with only `rejectReason`, so it could
  not verify a conflict vote — safe today only because its one caller filters to `approve` first,
  and its parameter type was a structural lookalike that accepted the union silently. Extracted
  `clusterVoteSigningPayload` / `clusterVoteVerificationPayload` into db-core beside `Signature`;
  `cluster-repo` and `dispute-service` both build the preimage there now, and the dispute
  parameter is typed `Signature`. (The "cluster" prefix distinguishes these consensus votes from
  the dispute subsystem's unrelated arbitration votes, which own a same-named helper.) The
  implementer flagged this gap and left it; the shared helper retires the whole class rather than
  patching the one instance. Test-file `signVote` helpers stay independent by design — a test that
  re-derives the format is a check on it.
- **`PhaseResult` carried `conflictsWith` as an optional field**, forcing a `conflictsWith!`
  assertion at the only site that reads it — the same "make the bad state unrepresentable" move the
  implementer applied to `Signature`, not applied one type over. Now a union keyed on the phase.
- **Stale `hasConflict` references** in `resolveRace`'s doc comment (two sites).
- **`packages/db-p2p/docs/cluster.md` was materially out of date** — and not touched by the
  implement commit. Its phase enum and flow diagram predated both new phases, its
  `handlePromiseNeeded` snippet showed a `rejectTransaction(record, 'Conflict detected')` call that
  has never existed (the real old behaviour was silence — exactly the bug this ticket fixed), its
  conflict-detection snippet was the old boolean `hasConflict`, and its abandonment section listed
  only the `rejected-by-validators` broadcast. Rewritten: both new phases, the three vote kinds and
  why silence is never one of them, the fixpoint's one-delivery consequence, the `findConflict`
  snippet, the conflict-race-lost broadcast and its proof bar, and the shared vote preimage.
- **`docs/internals.md`'s pend-failure taxonomy claimed "every unconfirmed rejection still
  throws"** — no longer true, since a lost race is *returned* without any local confirmation.
  Added that case, including why it carries no `staleAt`. Also qualified the "promise-phase
  rejection stays prose-only" note, which now has a structured counter-example in the same union.
- **`tickets/backlog/debt-cluster-member-race-logic-has-no-home.md`** named `hasConflict`, an
  in-flight sequencing dependency that has now landed, and a line count that moved
  (1954 → 2034, `wc -l packages/db-p2p/src/cluster/cluster-repo.ts`).

**Tests added (5).** The implementer's tests covered the happy path and the member's own vote well;
these cover the integrity claim, the not-a-rejection claim, and the coordinator's ordering:

- a conflict vote whose `conflictWith` is altered in transit fails signature validation (this is
  what "folded into the signed payload" actually buys, and nothing asserted it);
- other members' conflict votes below the threshold do **not** suppress this member's own vote
  (conflict ≠ reject at the member);
- conflict votes above the threshold make the member abstain *and* release the blocks, so a fresh
  transaction on the same block gets a clean approve;
- at the coordinator, a genuine `reject` outranks a co-occurring `conflict`
  (`ValidatorRejectionError`, not `ConflictRaceLostError` — otherwise a permanently-invalid write
  would be retried forever);
- a transaction that reaches super-majority *despite* a conflict vote still commits — a conflict
  vote refuses, it does not veto.

**Tripwires recorded (conditional; no tickets filed):**

- Signing a commit releases this member's reservation, and the fixpoint means that can now happen on
  the *first* delivery rather than a round-trip later. The safety argument is quorum intersection
  (Theorem 9), not the reservation. `NOTE:` at the `OurCommitNeeded` branch in
  `getTransactionPhase`, naming the fix if a lost update between commit-signing and consensus-apply
  ever shows up: hold the reservation until `handleConsensus`.
- `ConflictRaceLostError.conflicts` (which transaction won) is dropped at the pend boundary because
  `StaleFailure` has no field for it and the retry loop only needs "retryable". `NOTE:` at the
  conversion site: add a typed field if a caller ever needs the winner; never parse it back out of
  `reason`.

**Considered and not filed (major candidates that did not survive):**

- *A member that conflict-voted can still be asked to commit that same record*, when the rest of the
  cohort supplied super-majority. Traced against the pre-change code: the old silent-abstention path
  reached the identical branch, so this is unchanged behaviour, and it is correct — the commit rule
  is the cohort's approval count, not this member's own vote. Documented at the site rather than
  ticketed.
- *`detectEquivocation` treats a conflict→approve flip as equivocation.* Agreed with the
  implementer's reading: every coordinator re-presentation carries the merged conflict vote, so an
  honest member never re-votes that hash, and the failure direction is conservative. No path found;
  left alone.
- *Single-peer cohorts now raise `ConflictRaceLostError` where the old code committed with zero
  approvals.* Reviewed as strictly more correct.
- Noticed while reading, outside this diff and currently unreachable: the coordinator's commit
  majority counts `Object.keys(record.commits).length` rather than approving commits only. No
  producer emits a non-approve commit today, so nothing is wrong now; not this ticket's site.

**Not verifiable here:** the end-to-end gate is a sereus integration scenario in another repo
(`control-write-degraded-cohort-member`). The shortfall message stayed byte-identical (a test now
pins the exact string), so that repo's matcher keeps working; the blocked ticket
`control-write-hears-zero-approvals-from-healthy-trio` already carries the landing notes.
