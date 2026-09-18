description: Every commit spent one extra storage operation deleting its own pending record, which the commit had already moved to the committed store. The commit path now skips that delete. Crash recovery keeps it, because recovery is rare and a retried write can leave a real record there. This review also covered a conflict-rule change that tess's test-failure triage made during the same run.
files:
  - packages/db-p2p/src/storage/block-storage.ts (`setLatest`, `recover`, `sweepDeadClaims`)
  - packages/db-p2p/src/storage/i-block-storage.ts (`setLatest` precondition)
  - packages/db-p2p/test/block-storage.spec.ts (describe 'BlockStorage pending claims — a record claims the slot it was pended at')
  - packages/db-p2p/src/cluster/race-resolution.ts (`operationsConflict`, from triage commit 12399f79)
  - packages/db-p2p/test/race-resolution.spec.ts
  - docs/correctness.md (Theorem 1, Case 2), docs/repository.md
----

# What landed

**The commit path no longer deletes a record that is already gone.** A block's metadata keeps a "claim" for each pending record: the revision it was pended at (`BlockMetadata.pendingRevs`). When `latest` advances, `BlockStorage.sweepDeadClaims` deletes every record whose claim is at or below the new latest. On commit, `promotePendingTransaction` moves the committing action's record from pending to committed but leaves its claim behind. The sweep then issued a raw delete for a record that no longer existed, one wasted operation per commit. `setLatest` now drops that claim before the sweep, inside the metadata write it already makes. Rival records at or below the new latest are swept exactly as before.

**Crash recovery (`recover`) still deletes.** The implementer made `recover` skip the delete too. This review reverted that part (see findings). `recover` redoes a `setLatest` that was lost in a crash, and it runs only after one, so the extra operation costs nothing that matters.

**Triage commit `12399f79`, kept with its safety argument corrected.** In the cluster's conflict check, a message made only of commits no longer counts as a rival to another action's pend or commit. It still conflicts with an invalidation, and a mixed message still conflicts. This fixed an intermittent tear on two-member cohorts. Writer A's pend was built on writer B's newly landed log tail, and it won a conflict vote against B's data-block commit, so B tore.

# Review findings

## Triage commit 12399f79: the change to the conflict rule (the priority of this pass)

**Was a test weakened to hide a failure? No.** The replaced case asserted the old rule: a commit racing another action's pend conflicts. The triage deliberately changed that rule, and the old case pinned exactly the behaviour that caused the tear. The replacement cases cover both argument orders and pin the two limits of the exclusion: a commit still conflicts with an invalidation, and a mixed commit-and-pend message still conflicts. The existing pend-against-pend case still asserts a conflict. A regression in either direction fails a unit case. A regression that makes commits conflict again fails `concurrent-two-member-writes-do-not-tear.spec.ts` only intermittently (the triage measured about 1 in 9 under six-way load), so the unit cases are the reliable net and the mesh spec is only corroboration.

**Does it widen the lost-update window found by the review of `a-member-that-missed-a-commit-refuses-every-later-write`? Yes, slightly. It opens no new one.** The triage's safety argument claimed that a Y pended past X's slot "was built on X", so a member X has not reached refuses Y's commit. That refusal is the fork guard in `StorageRepo.internalCommit`: `typeof declaredBaseRev === 'number' && !transform.insert && latest?.rev !== declaredBaseRev`. It compares against the base Y **declared**. So it fires on any member that is behind Y's declared base, at any cohort size, but only if Y declared a base. It cannot catch a Y whose declared base was itself missing X's change. Two shapes reach that:

- **Y's commit declares no base for the block.** This happens at any cohort size, for example a block the writer cannot describe, or a writer running older code. It is arm one of `backlog/bug-a-pended-transform-does-not-carry-its-base`.
- **Y read the block from a member that never received X's pend.** This happens from four members up, and it is that ticket's arm four.

**What the old rule did in those shapes.** It gave a second chance that depended on timing. The conflict vote fired only while X's data-block commit was still in its own promise round at a member. Each member drops its reservation when it signs the commit (`shouldPersist = false` on `OurCommitNeeded` in `cluster-repo.ts`), so nothing covered the window after that. When the race went Y's way, the vote superseded X's commit, so X tore, and Y still landed over the older content. The vote never guaranteed anything, and carrying the base remains the fix. Restricting the exclusion by cohort size would bring back the observed tear and still close nothing, so I did neither. Instead:

- I corrected the doc comment on `operationsConflict` and the Theorem 1 Case 2 bullet in `docs/correctness.md`. Both now name the two shapes, say the exclusion widens their window without opening a new one, and point to the backlog ticket. The small-cohort caveat is no longer undocumented.
- I appended a note to `backlog/bug-a-pended-transform-does-not-carry-its-base` recording that the conflict vote's promise-round window no longer applies to those arms.

**Two, three and four members.** At every size the fork guard fires on a member that is behind a declared base. It never fires for an undeclared base. The remaining question is whether Y's declared base can lack X's change.

- **Two and three members:** the promise bar is every member (ceil(2 × 0.75) = 2, ceil(3 × 0.75) = 3; `DEFAULT_SUPER_MAJORITY_THRESHOLD` is 0.75). So every member promised X's pend. The earlier review concluded that every member therefore holds it. If so, `StorageRepo.get` promotes X's record before serving Y's read, and Y's declared base includes X. I did not verify independently that a member finishes applying the pend before it answers a read. If it does not, the stale-read shape also reaches three members, and the same backlog ticket covers it.
- **Four members:** the bar is 3 of 4, so one member can miss X's pend. Y's declared base can then lack X's change, and the guard does not fire. This is arm four, and it is inferred from code, not reproduced.

**Other checks on the triage change.**

- A commit-only message against a pend of the same action is still handled first by the same-action check.
- A cancel-only message is still excluded first.
- Against an invalidation, the new check falls through to the block-overlap test as intended.
- `recordPriority` and `resolveRace` are unaffected, because commit records carry priority 0 and are now arbitrated only against invalidations.
- The `packages/db-p2p/docs/cluster.md` excerpt matches the code.

## The implement-stage change

- **Fixed: the `recover` residual was reachable through a documented route.** The implementer's NOTE said a stray same-action pending record could reach `recover` only after two lost `setLatest`s. But `StorageRepo.recoverBlock` is public and calls `recover` directly. A retry re-pending its own slot after one lost `setLatest` (allowed, because `savePendingTransaction` checks only `latest`) followed by `recoverBlock` would drop the record's claim and leave the record behind. A pending record with no claim is the strongest reservation, and no path sweeps one, so it would block every later write to the block. I restored the delete in `recover`, removed the NOTE, and added the test 'recover deletes a same-action record re-pended while its setLatest was owed'. I reworked the two-lost-`setLatest`s test to assert that recovery advances and all claims are dropped, and I relaxed the delete assertion in 'recover sweeps the claims the lost setLatest owed' to `[winner, 'a-loser']`. The per-commit saving is unaffected, because it is all on the commit path.
- **Fixed: `setLatest` had an unstated precondition.** It now drops the committing action's claim without deleting anything. That is correct only if promotion ran first. Its only caller is `internalCommit`, straight after `promotePendingTransaction`. I stated the precondition on `IBlockStorage.setLatest`.
- **Docs:** `docs/repository.md` (the dead-claim sweep section) now says that commit drops its own claim without a delete and that `recover` deletes. The describe block's header comment in the spec was updated to match.
- **Checked, no issue:**
  - The commit-path tests pin that the winner is not deleted and rivals still are.
  - `saveForwardRevision` keeps its own explicit delete, which is correct because no promotion precedes it.
  - `recordClaim` keeps `pendingRevs` absent when it is empty.
- **Hygiene:** no file-size concern from this diff. The comments state reasons rather than narrate code.
- **Performance:** the one wasted raw operation per commit is gone. Sereus's downstream op counts were not re-measured here, because this repo has no solo-strand op-count spec.

## Tests and validation

- `tsc --noEmit` in `packages/db-p2p`: clean.
- Targeted specs (block-storage, race-resolution, pending-claim, storage-repo, member-missed-commit-heals-at-commit, concurrent-two-member-writes-do-not-tear): 231 passing.
- Full `yarn test` in `packages/db-p2p`: 3023 passing, 63 pending, 0 failing. The flake the implementer reported did not recur in this run.

## Tripwires and tickets

- No new ticket. The widened window is evidence for the existing `backlog/bug-a-pended-transform-does-not-carry-its-base`, so it went there as a note rather than as a separate ticket. It is indexed here.
- No new `NOTE:` comments. The implementer's `recover` NOTE was retired because this review fixed its cause.
