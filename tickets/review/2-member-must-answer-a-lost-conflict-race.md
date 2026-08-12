description: When two machines wrote the same data block at once, the machines that picked the other write said nothing back to the loser, so the losing write looked like "nobody answered" and could not be retried sensibly. Now the loser gets a signed "you lost to X, try again" answer, and the failure surfaces as a normal retryable conflict.
prereq: abandoned-pend-holds-the-block
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, docs/correctness.md
difficulty: hard
----

# Review: a member that loses a conflict race now answers

Implementation of `2-member-must-answer-a-lost-conflict-race` (arm 1 was
`abandoned-pend-holds-the-block`, already landed). All four layers of the ticket's shape were
built, plus the phase-fixpoint refactor its 2b section added.

## What was built

**1. Third vote kind** — `packages/db-core/src/cluster/structs.ts`. `Signature` is now a
discriminated union: `approve` | `reject` (optional `rejectReason`) | `conflict` (required
`conflictWith` = the winning transaction's messageHash). I chose the union over the flat
"optional field" fallback the ticket allowed: the compile-time guarantee (a `conflict` without
its `conflictWith` cannot typecheck) came cheap — the only construction sites that needed fixing
were three test helpers that built `{ type, signature }` from a variable, plus two test reads of
`rejectReason` that now need a type narrow first. All production construction sites already used
literals. `conflictWith` is folded into the signed payload exactly like `rejectReason`
(`computeSigningPayload` / new `signedVoteExtra` helper), so the claim is integrity-protected and
signature verification covers it.

**2. The member answers** — `packages/db-p2p/src/cluster/cluster-repo.ts`:

- `hasConflict` → `findConflict`, returning `{ blockedBy: messageHash } | undefined`.
- New phase `OurConflictVoteNeeded` signs the conflict vote; the record is **never persisted**
  (the member holds the winner; persisting the loser would double-reserve the blocks).
- New terminal phase `ConflictSuperseded` — conflict votes made super-majority unreachable —
  distinct from `Rejected`; members clear such records immediately. Conflict votes are counted
  toward NEITHER approvals NOR the rejection threshold anywhere.
- **Phase fixpoint (ticket 2b):** `processUpdate` now loops phase→handle→recompute until the
  phase stops advancing (labelled loop, cap 8 as a bug guard; only the three vote-adding phases
  continue, each strictly grows the record, so it terminates). The two old hand-written
  re-checks (`Rejected` after promise, `Consensus` after commit) fell out of the loop, and the
  4-peer "promise collected during commit phase" latency case now promises AND commits in one
  delivery (test locks this). The stale "shouldn't normally be reached" comment is gone;
  the `Promising` case now states what it means (we voted, waiting on the cohort).

**3. Coordinator distinguishes the outcome** — `cluster-coordinator.ts`: counts conflicts
separately; check order is rejections-over-allowance → `ValidatorRejectionError` (unchanged),
then conflicts-present-and-approvals-short → new `ConflictRaceLostError` (carries
`conflicts: Record<peerId, winningHash>` from the signed votes), then the legacy shortfall
error with its message **byte-identical** (a NOTE at the throw site says why, naming the sereus
matcher; a test asserts the exact string). Additionally, per the NOTE the
`abandoned-pend-holds-the-block` review left behind: when the conflict+reject votes *prove*
super-majority unreachable, the coordinator reuses `broadcastAbandonment` so members free the
loser's blocks immediately instead of waiting out the 2 s staleness sweep; below that proof bar
it still broadcasts nothing.

**4. Retryable result, not error** — `coordinator-repo.ts` `pend` converts
`ConflictRaceLostError` into `{ success: false, conflict: true, reason }` — the `StaleFailure`
shape `Collection.sync` and the multi-collection `pendPhase` already retry via
`isConflictFailure`. `staleAt` deliberately absent (confirmed-only; a rival pend is not a
revision claim; test asserts absence).

`docs/correctness.md` Theorem 1 Case 2 and Theorem 9 now describe the conflict vote, that it is
not a validity rejection, and that a retry must be a fresh transaction (a conflict vote occupies
the member's vote slot for that messageHash forever). `backlog/feat-occ-priority-reservation`'s
premise ("a losing race is answered") is now true; only its stale `hasConflict` symbol reference
was touched.

## Verified

- `yarn workspace @optimystic/db-p2p test` — 1591 passing, 44 pending, 0 failing.
- `yarn workspace @optimystic/db-core test` — 1365 passing.
- Root `yarn build` — clean across all packages.
- Regression test landed red-first in spirit: `cluster-repo.spec.ts` › "answers a lost conflict
  race with a conflict vote naming the winner" (update X, then conflicting Y on `block-shared`;
  before the fix Y came back with no vote at all).
- Coordinator retry re-presentation: `scheduleCommitRetry`/`retryCommits` re-present
  `state.record`, which carries the merged promises — so a conflict-voted member always sees its
  own vote and `!record.promises[ourId]` is false; it is never asked to approve the same
  messageHash again. Verified by code-reading, not by a test.

## Use cases to poke at in review

- Member level: lost race → conflict vote naming winner; conflict vote survives signature
  validation on redelivery; conflict-voted loser's blocks are NOT reserved (three tests under
  `conflict detection`); 4-peer promise+commit in one delivery (`phase fixpoint` describe).
- Coordinator level (`cluster-coordinator-supermajority.spec.ts`): conflict answer →
  `ConflictRaceLostError` with structured conflicts map; proof-carrying abandonment broadcast
  reaches every member; silent cohort keeps the byte-identical shortfall message.
- Repo level (`coordinator-repo-stale-classification.spec.ts`): lost race returns
  `{ success:false, conflict:true }`, no `staleAt`, no stale-classification re-read, storage
  pend never called.

## Known gaps / flags for the reviewer

- **Not verifiable from this repo:** the end-to-end gate is the sereus scenario
  (`../sereus/packages/integration-tests/.../control-write-degraded-cohort-member.integration.ts`,
  ≥ 5 runs of the healthy-trio case). Deferred to whoever works that repo. The sereus blocked
  ticket (`tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio.md`) was updated
  with the landing notes: shortfall message unchanged (their matcher keeps working), no
  classifier change needed, `ConflictRaceLostError` exists and is retryable if it ever escapes
  by a non-pend path.
- **Behavior change from the fixpoint:** a record arriving with the full quorum's promises (or
  a single-peer cohort) now runs promise → commit → consensus in ONE delivery. Four existing
  tests assumed the old one-phase-per-delivery behavior and were updated to match the new
  contract — two byzantine equivocation tests (given a third peer so the record stays retained
  for the merge that detects equivocation), the race-resolution test (now asserts the conflict
  vote instead of the old silent abstention), and the transient-apply-fault test (the throw now
  surfaces from the first update). Worth checking those rewrites preserve their original intent.
- **Pre-existing sharp edge the fixpoint makes more frequent:** `OurCommitNeeded` has always
  cleared the member's reservation (`shouldPersist = false`) once the commit is signed; the
  fixpoint means that can now happen on the FIRST delivery when the record already carries
  super-majority. The safety argument is Theorem 9's quorum intersection (a rival can never
  assemble its own super-majority once the winner has one), not the reservation — but if the
  reviewer disagrees with that reading, this is the place to push.
- `detectEquivocation` treats ANY vote-type flip as equivocation, including conflict→approve. A
  member that conflict-votes Y and later approves the SAME messageHash would be penalized. I
  believe this is unreachable through honest paths (every coordinator re-presentation carries
  the merged conflict vote, so the member never re-votes), and it is conservative in the right
  direction, so I left it. Flagging in case the reviewer sees a path I missed.
- A single-peer cohort whose lone member conflict-votes now raises `ConflictRaceLostError`
  where the old code (skipping the `peerCount > 1` shortfall guard) proceeded to commit with
  zero approvals. Strictly more correct, but it is a behavior change on 1-peer clusters.
- `dispute-service.verifyPromiseSignature` reconstructs payloads with `rejectReason` only; it
  cannot verify a conflict vote's payload. Safe today — it is only ever called on `approve`
  votes (`resolveDispute` filters first) — but a future caller passing a conflict vote would
  get a false "invalid". Its inline parameter type still accepts the union silently.
