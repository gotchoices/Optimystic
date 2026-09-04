description: A block can get permanently stuck refusing all writes because of a leftover "write in progress" marker, and until now the logs described every refusal as an ordinary lost race — indistinguishable from normal, healthy contention. The node now says the real condition out loud, once, so an operator can find it by searching the logs.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/stuck-reservation-named.spec.ts, docs/repository.md
difficulty: medium
----

# Review: naming a block wedged behind a reservation that will never clear

## What was built

One new log line, `coordinator-repo:stuck-reservation`, emitted once per episode by
`CoordinatorRepo` when a block's pending-conflict refusals stop being explicable as a lost race.

The discriminator is **repetition against an unchanged holder**. A healthy rival reserves a block
only for its own pend-to-commit window, so at most (concurrent writers − 1) distinct actions can lose
to it before it commits or cancels and the block changes hands. A stranded record has no such bound:
the same holding action id refuses distinct, unrelated actions forever. The counter is therefore
**distinct refused action ids per (block, holder)** — not elapsed time (a slow writer is not a stuck
one) and not raw refusal count (a retrying writer reuses one action id, minted once in
`syncInternal` in `packages/db-core/src/collection/collection.ts`).

### Changes, by file

**`packages/db-p2p/src/repo/coordinator-repo.ts`**

- `StuckReservationWatch` — per-block episode state: the sorted holder action ids, the set of
  distinct action ids they have refused, and a say-once `reported` flag. Kept in its own
  `stuckReservations` LRU (1000 entries), deliberately *not* folded into the existing
  `unsettledAheadClaims` entry: that one belongs to the read-repair path and clears when a block
  converges on a revision, this one belongs to the write path and clears when a block accepts a
  write. The reasoning is in the field's doc comment.
- `STUCK_RESERVATION_DISTINCT_ACTIONS = 8`, with the calibration argument in its doc comment.
- `stuckReservationMessage` — operator prose in the same register as the existing
  `cohortTooSmallMessage` / `soleHolderMessage`: what is stuck, the only two things that clear it (a
  cancel for that action id, or that action's own commit landing), that nothing on the node expires
  it, and that the line is a diagnosis and not a control path.
- `noteStuckReservation` — called from `classifyPendingConflictRejection`, which already re-reads
  local storage to confirm the rival. Counts the refusal per block, resets on a holder change, emits
  once at the threshold, then drops the id set (so the set is bounded by the threshold).
- `clearStuckReservations` — forgets an episode, so a *later* wedge on the same block can still
  speak. Called from the two events the message itself names as cures: a pend the blocks accepted,
  and a cancel for the holding action.
- `pend` was split: the responsibility check and the new "a successful pend clears the episode" step
  stay in `pend`, and the cluster body moved verbatim into a new private `pendThroughCluster`. No
  behaviour change in the moved code — it is a mechanical extraction to give the success path one
  place to observe.
- `coordinator-repo:pend-conflict-classified` gained a `distinctRefusedActions` field, carried on
  *every* classification rather than only stuck ones, so a healthy deployment's real figure is
  readable from its own logs. This is what the negative spec measures.

**`packages/db-p2p/test/stuck-reservation-named.spec.ts`** (new, 3 tests) and a paragraph in
**`docs/repository.md`** under "A pending record's lifetime is bounded by its writer".

## How the threshold was chosen — and what it does not cover

Measured, not asserted. The healthy-contention arm of the new spec drives six rounds of "a holder
pends, two rivals lose to it, the holder commits" through the in-process mesh and reads the counter
back off the classification lines: a healthy holder tops out at **2** distinct refused actions, and
the count resets on every holder change. `concurrent-diary-append-acknowledgement.spec.ts` races
three writers at one diary and cannot exceed that either, for the same structural reason. 8 is four
times the measured figure; a genuinely stuck block clears it trivially (the field instance refused
hundreds).

**Where the margin runs out, stated plainly:** a block with more than 8 *distinct* writers racing it
inside a single pend-to-commit round trip could reach 8 with a perfectly healthy holder. That is a
false line and nothing else — the counter never refuses, expires, or deletes anything — and the
remedy is to raise the number, not to add a control path. This is in the constant's doc comment.

## Use cases to exercise

**The wedge itself.** Pend two blocks through consensus, commit only the tail (a client that walked
away from the sibling). Every member keeps the sibling's pending record; nothing will ever promote or
remove it. This is the same mechanism `torn-commit-cancels-abandoned-blocks.spec.ts` pins, reused
here rather than re-derived.

**What should be true afterwards:**

- Seven further distinct writers → refused, classified, **silent**.
- The eighth → exactly one `coordinator-repo:stuck-reservation` line naming the block id, the holding action id, the
  count, and the prose. (The structured fields are what a log search finds; the prose is what an
  operator reads.)
- Four more writers → refused, classified, **silent again**. A thousand slightly different lines
  would be the same failure this replaces.
- Cancel the holder, write and commit normally, wedge the block again under a *different* holder,
  drive eight more → named again, with the second holder's id. A second episode must be able to
  speak.
- Six rounds of genuine contention (holder pends, rivals lose, holder commits) → nothing at all, and
  the measured per-holder count stays at 2.

## Verification run

- `yarn lint` — clean.
- `yarn build` — clean.
- `yarn typecheck` — clean.
- `yarn test` (repo root, all packages) — passes. `db-p2p` alone: **2526 passing, 0 failing, 49
  pending**. No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.
- The new spec runs in ~280 ms.
- `yarn test:integration` was **not** run (env-gated, real TCP meshes); nothing in this change
  touches transport.

## Known gaps — treat these as the starting point, not the finish line

- **Only the coordinator site is instrumented.** `ClusterMember.validatePendOperations` in
  `packages/db-p2p/src/cluster/cluster-repo.ts` still logs its per-member view unchanged. That was
  the ticket's instruction ("start at the coordinator"), but it means a member sees nothing about the
  pattern its own votes contribute to.
- **Refusals that do not arrive as a cohort-wide validator rejection are not counted.** If only part
  of a cohort holds the stranded record, the pend can still reach approval super-majority and the
  refusal comes back through the retained local apply verdict instead of through
  `classifyPendingConflictRejection`. That block goes unnamed. Recorded as a `NOTE:` on
  `noteStuckReservation`; it is the weaker condition (the write does land on the healthy members), so
  it was left uncounted rather than counted from a place that cannot see the cohort's verdict. Worth
  a reviewer's judgement on whether that is the right call.
- **The count is per coordinator.** A block's coordinator is normally stable, but churn or a routing
  change moves it: the count then restarts on the new coordinator, and the old one could name the
  same episode a second time. Recorded as a `NOTE:` at the map declaration. No spec covers it.
- **`distinctRefusedActions` saturates at the threshold** once an episode has been reported, because
  the ids are dropped at that point. Deliberate (the field exists for calibration, not accounting)
  and documented, but a reader could misread it as an exact count.
- **The multi-holder shape is never exercised.** `holders` is an array because `state.pendings` can
  in principle carry more than one rival, but a member's own pend refuses a second reservation, so no
  spec produces it. The comparison and the message both handle it; neither is tested.
- **Mesh harness only.** No real-libp2p coverage, and no coverage of an LRU eviction re-arming the
  say-once flag.
- **The counter is deliberately inert.** Nothing acts on it. Deciding when a durable pending record
  may actually be removed stays with backlog `debt-unpromotable-pending-records-need-a-sweep`, whose
  whole difficulty is that deleting a live reservation is worse than the leak.

## Tripwires parked in code (see `## Review findings` when this closes)

- Coordinator migration restarting or duplicating an episode — `NOTE:` at the `stuckReservations`
  field in `coordinator-repo.ts`.
- Partially wedged blocks going unnamed — `NOTE:` on `noteStuckReservation` in the same file.
- The threshold's false-positive window above 8 concurrent distinct writers — in the
  `STUCK_RESERVATION_DISTINCT_ACTIONS` doc comment.
