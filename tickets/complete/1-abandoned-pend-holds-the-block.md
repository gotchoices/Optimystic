description: A write that was refused, or that nobody is driving any more, used to keep the data block it touched reserved for two seconds — blocking every other machine's write to that block, and each blocked retry reserved it again. Now a refused write is dropped straight away and the machine that gave up tells the others.
prereq:
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, packages/db-p2p/test/cluster-abandonment-e2e.spec.ts, packages/db-p2p/docs/cluster.md, packages/db-core/src/transaction/transaction.ts, docs/correctness.md
----

# Complete: a dead pend no longer keeps the block reserved

Arm 2 of `fix/lost-conflict-race-abstains-and-orphans-the-block`. Arm 1
(`member-must-answer-a-lost-conflict-race`) is a separate follow-on and is still in `implement/`.
No wire format changed, no type changed, no new message type.

## What shipped

Three sites, all in `packages/db-p2p`:

1. **A member no longer retains a transaction it rejected itself.** `processUpdate`'s
   `OurPromiseNeeded` branch (`cluster-repo.ts`) re-evaluates the phase after appending its own
   vote and, on `Rejected`, takes `shouldPersist = false` — mirroring the `OurCommitNeeded`
   branch below it. Previously a member persisted a record it had itself proven could never
   commit, and that record held its blocks in `activeTransactions` — the member's reservation
   table, which `hasConflict` scans — for the full 2-second staleness window.

2. **`resolveRace` ranks by approvals, not by vote-map keys.** `record.promises` is the vote
   map: a `reject` occupies a key exactly as an `approve` does, so counting keys ranked a record
   carrying one rejection above a fresh rival carrying nothing, and kept it out-ranking (and
   blocking) that rival until the sweep fired. New `ClusterMember.approvalCount()` counts
   `approve` votes only — which is also the count the commit rule
   (`approvedPromises >= superMajority`) actually uses, so the ordering now matches the property
   it is asserted to protect instead of a strictly looser one. Priority and hash tie-breaks
   below it are untouched.

3. **A coordinator that abandons a proven-dead transaction tells the cohort.** New
   `broadcastAbandonment()` (`cluster-coordinator.ts`), called from the `rejected-by-validators`
   site, replays the merged record — which carries enough signed rejections to *prove* the
   transaction dead — to every peer via the same `update()` every other phase uses. Each member
   re-derives `Rejected` from signatures it verifies itself and clears immediately.
   Fire-and-forget, per-peer try/catch, never awaited into the caller's throw. The
   `supermajority-failed` site is deliberately not broadcast (no signed evidence there); a
   `NOTE:` at that site says why and points at the follow-on ticket.

Documentation: `docs/correctness.md` §Theorem 1 Case 2 and §Theorem 9 now say *approvals*
throughout and record why the count was narrowed; `packages/db-p2p/docs/cluster.md` refreshed
its stale `resolveRace` snippet and gained a section on the abandonment broadcast;
`packages/db-core/src/transaction/transaction.ts` got a one-word comment fix.

## Review findings

Reviewed the implement diff first, then the surrounding code, then the handoff. Lint clean at
the repo root (`yarn lint`, no output, exit 0). `npx tsc --noEmit` clean in `packages/db-p2p`.
`yarn test` in `packages/db-p2p`: **1583 passing, 44 pending, 0 failing** (36 s). No
pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Checked and found correct — no action

- **The approvals-first safety argument actually holds.** Walked the quorum-intersection case
  by hand at the narrowed count: a member that approved transaction X always holds its own
  approve in its stored copy of X, so X's local approval count is ≥ 1 and it out-ranks any
  fresh rival — which is exactly what the argument needs. Narrowing from all votes to approvals
  cannot weaken it, because rejections were never part of the commit rule. `docs/correctness.md`
  §Theorem 1 Case 2 and §Theorem 9 read accurately after the edit.
- **Re-delivering identical signatures is a no-op, not equivocation.** The handoff correctly
  flagged this as asserted-by-reading only. `detectEquivocation` keeps the first-seen signature
  and only penalizes a *changed* vote type, and never throws. Now asserted by running it (see
  the new test below), not by reading.
- **The broadcast cannot become a different failure.** Every peer call is inside its own
  try/catch, so the `Promise.all` can never reject, and it is `void`ed rather than awaited.
  `updateMember(..., 0, ...)` means no retries. A `peerIdFromString` throw on a malformed id is
  inside the try. Containment is complete.
- **`supermajority-failed` staying silent is right**, for the reason the `NOTE:` at the site
  gives: nobody voted, so the record proves nothing and a broadcast there would be an
  unauthenticated "forget this". Left alone.
- **`staleThresholdMs` left at 2000 is right.** It is the backstop for exactly the cases that
  carry no proof (a crashed coordinator); shortening it would trade one silent failure for
  another. Left alone.
- **No other site counts promise-map keys as progress.** Swept every
  `Object.keys(...promises)` in `packages/*/src`: the only non-logging one left is
  `getTransactionPhase`'s "still collecting" test, where counting *all* votes is what is meant
  (every peer has answered ⇒ collection is over). Correct as is.

### Fixed in this pass — minor

- **Added `packages/db-p2p/test/cluster-abandonment-e2e.spec.ts`**, closing both of the two
  gaps the handoff named as most important. It wires a real `ClusterMember` behind a real
  `ClusterCoordinator` with a remote peer that signs a genuine reject, and asserts the reported
  symptom directly: after the abandonment, a retry on the same block gets the member's approve
  immediately. Confirmed **red** against the un-fixed coordinator (`waitFor timed out after
  2000ms: the member drops the abandoned transaction from its reservation table`) and green
  with the fix. It also asserts the member reported no reputation penalty, which is what turns
  "the replay should not trip equivocation detection" from a reading into a result. The peer
  signs for real deliberately — a stub signature would be thrown out by `validateSignatures`
  before the phase was ever computed, and the test would pass for the wrong reason.
- **Corrected and re-sited the new comment in `processUpdate`.** It sat above an unrelated
  `log()` call rather than the block it explains, and it called the default a "unanimity
  threshold". The default 0.75 yields `maxAllowedRejections === 0` only for cohorts of three or
  fewer (where `ceil(0.75·n) === n`); in a larger cohort one reject is not terminal and the
  re-check simply finds a non-terminal phase. The code was always right; the comment overstated
  its premise.
- **Gave `resolves conflict deterministically based on promise count` a real assertion.** The
  handoff noted its name was now off. It was worse than that: its only assertion was
  `expect(result).to.not.equal(undefined)`, which nothing could fail. Renamed to *approval
  count* and made it assert what it is about — the losing record does not collect the member's
  promise.
- **Documented the abandonment broadcast.** `packages/db-p2p/docs/cluster.md` described the
  member's reservation table and the race resolution but said nothing about a coordinator ever
  releasing a transaction — a new protocol behaviour with no documentation at all. Added a
  *Releasing an Abandoned Transaction* section covering the proof-carrying rule, why
  `supermajority-failed` is excluded, and the fire-and-forget contract.

### Filed — major

- **`processUpdate` advances at most one phase per delivery, with a hand-written re-check per
  branch.** Appended as arm **2b** to `implement/2-member-must-answer-a-lost-conflict-race`,
  which already claims this site and is about to add two more phases to it — so it is one site
  with two arms, not a new ticket. Filed at the invariant rung rather than as a point fix: the
  proposal is to drive the phase to a fixpoint after any branch that mutates the record, which
  retires the whole class instead of adding a third bespoke re-check. The handoff flagged the
  speculative half ("if `getTransactionPhase` ever grows another terminal phase"); the concrete
  half is real today and **verified by running it** — a 4-peer record carrying three approvals
  and no vote from the member comes back with the member's `approve` in `promises` and nothing
  in `commits`, because `getTransactionPhase` tests `!promises[ourId]` before it tests the
  commit condition. Behaviour stays correct (the commit-broadcast retry loop covers it), so
  this is latency and fragility, not a lost commit.
- **`backlog/debt-cluster-member-race-logic-has-no-home.md`** — `cluster-repo.ts` measures
  **1954 lines** (`wc -l packages/db-p2p/src/cluster/cluster-repo.ts`), nearly all one class.
  This diff did not create that and sits well within it, but the race-resolution group it
  touches is a clean, nearly-pure seam whose forty-line safety argument currently lives in the
  middle of an unrelated file, and whose tests already reach through a private-method escape
  hatch. Sequenced behind the in-flight consensus ticket.

### Tripwires — recorded, not ticketed

- **`processCleanupQueue` exempts terminal phases from deletion**, so an expired entry that is
  already `Consensus` or `Rejected` is never removed there. It is not stranded — `hasConflict`'s
  staleness sweep drops it on the next conflicting arrival — but on a member that then goes idle
  it lingers until traffic returns. Pre-existing, self-healing, bounded. Parked as a `NOTE:` at
  the site in `cluster-repo.ts` with the condition that would make it real work.
- **A retry can outrun the fire-and-forget broadcast**, in which case it loses one more race
  before the block frees. Inherent to not blocking the caller's throw, and self-correcting. The
  handoff raised the related worry that the coordinator's 100 ms cleanup timer might fire
  mid-broadcast; it is harmless because the broadcast closes over its own record. Recorded as a
  bullet in the new `cluster.md` section rather than as a ticket.

### Nothing found

- **Resource cleanup**: no timers, sockets or listeners are created by this diff. The
  per-peer cluster client the broadcast creates is created and discarded exactly as the
  commit-broadcast path already does.
- **Type safety**: no `any`, no assertions, no widened types anywhere in the diff.
- **Accepted tradeoffs**: no `NOTE:`-tagged accepted-tradeoff decision sits at any site this
  review touched, so nothing was re-filed against a call a human had already made.

## Deliberately not done

- **`supermajority-failed` was not made to broadcast.** It needs the losers' signed conflict
  votes to be proof-carrying, and those do not exist until
  `member-must-answer-a-lost-conflict-race` lands. That ticket can reuse
  `broadcastAbandonment` unchanged.
- **The extra terminal-phase generalization was not applied here.** It belongs with the ticket
  that is adding the phases, and applying it in this pass would have meant changing consensus
  control flow in a review — see arm 2b above.
