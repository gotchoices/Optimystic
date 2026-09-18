description: When a storage node applies a change to a block, nothing stored alongside that change records which version of the block it was written against — so wherever the sender did not volunteer that version separately, the node can apply the change to the wrong version and end up holding different content than the rest of the group under the same version number.
files: packages/db-core/src/network/struct.ts, packages/db-core/src/transform/digest.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-block-storage.ts
difficulty: hard
repro: static
severity: corruption
likelihood: unusual
tradeoffs: Closing it properly means changing what a pend puts on the wire and what block storage keeps for a pending change, plus a compatibility story for senders that do not supply it — and the common case is already covered by the commit-time guard, so a maintainer may reasonably wait for evidence that the remaining two paths actually bite in practice.
----

# A pended change is stored without the version it was written against

## The one thing that is wrong

A change to a block is a list of edits — insert this, splice that. Applying it to the wrong starting content produces wrong content, silently: the node records the result under the new version number and carries on, holding different bytes than every other node at that same number. This is the defect that ticket `a-commit-over-a-gapped-base-forks-the-block` was filed for.

That ticket's fix works, but it plugs the leak downstream of the root cause. The version a change was written against travels **separately from the change itself**: the author puts it in an optional, per-block declaration attached to the *commit* message (`CommitRequest.blockDigests[blockId].baseRev`), while the change itself arrives one round earlier, at pend, and is stored on its own. So the two can be separated, and wherever they are, the node applying the change has nothing to check against.

Two places where they are separated today, both in `packages/db-p2p/src/storage/storage-repo.ts`:

- **A commit that declares nothing for the block.** The declaration is optional by design — an author that would have to fetch a block over the network just to describe it leaves it out, a deletion has nothing to describe, and an author running older code sends none at all. Those commits apply to whatever the node happens to hold, exactly as before the guard. `internalCommit` abstains on purpose; the guard's own comment says so.
- **The read-driven promotion in `StorageRepo.get`.** When a reader tells a node "these changes are already committed elsewhere", the node finishes applying any of them it holds. There is no commit message here at all, so there is no declaration to check. Worse, that loop walks the list in version order and **silently skips** any entry whose change it does not hold — so a node that missed one change to a block will apply the *next* one straight over the stale copy. That is the same fork, reached by a second door.

## Why the obvious shortcut does not work

Version numbers are handed out per **collection**, not per block. A block only takes a number when some change touches it, so a node holding block X at version 1 and being asked to commit X at version 7 is routine — versions 2 through 6 touched other blocks. Any rule of the form "refuse unless my version is one less than the one being committed" rejects ordinary correct writes; that was tried, it broke normal operation, and the decision ticket recording why is `st-commit-contiguity-guard-premise` (now retired, see `complete/`). The same reasoning kills the promotion-loop variant: "I hold no pending change for that entry" is the *normal* case for the many changes in a collection that never touched this block, so it cannot be read as evidence of a gap.

The information genuinely is not derivable locally. It has to be carried.

## What would close it

Keep the base version **with** the change, from the moment the change is accepted:

- The pend carries, per block, the committed version the author's edits were computed against — the same number `blockDigests[blockId].baseRev` carries today, moved to where the edits are (or duplicated there).
- Block storage keeps it alongside the pending record, so any code path that later applies that record can check it, whether or not a commit message is present.
- Every apply site then makes the same check the commit guard makes today, and the "no declaration, so abstain" arm shrinks to "an author that genuinely did not read the block", which is a much smaller and more honestly-named hole.

This is a representation change, not another guard: it makes "a stored change without the version it applies to" unrepresentable, instead of adding a third place that has to remember to look.

Worth settling as part of the design, not left to the implementer:

- What an apply site does when the base is **absent** (an author that wrote blind, or a peer running older code). Refusing is safe but rejects writes that work today; abstaining preserves them but keeps a hole.
- Whether the number belongs on the wire pend request, on the stored pending record, or both — a receiver that stores what it was told still has to decide whether to trust it, though a wrong value can only cause a refusal, never a fork.
- Whether the read-driven promotion should keep applying changes at all once a cheaper alternative exists (it could decline and let block repair supply the version instead), which would close that arm without any format change.

## A third place they are separated: on the writer, before anything is sent

Added 2026-09-17 from ticket `refreshed-collection-caches-a-block-older-than-its-log-entry`, which narrowed this without closing it (that ticket's instructions were to leave it to this one).

The two arms above are about a storage node applying edits to a version the writer never saw. The same separation exists one step earlier, inside the writer's own collection handle. A staged edit is kept as a list of operations with **no record of the content it was computed against**; the only link to a version is a copy of the block taken when the edit was staged, and that copy is deliberately *replaced* with whatever the handle's memory holds for the block whenever that content changes (`Tracker.update` "re-pins against the new base"; `Tracker.peekMaterialized` falls back to the live cached block when the copy has gone stale). That is sound only while a block's content cannot change under staged edits without the edits being re-made — which the handle guarantees for changes it learns about from the log (a refresh re-stages every pending action), and for nothing else.

The case that escapes: a machine answers a read with content older than the handle asked for (it has not caught up — the situation that ticket is about). An edit is staged against that older content. Storage then catches up, the next read of the block returns the newer content, and the staged operations now sit on a block they were never computed against. No refresh notices, because the log did not move. At commit the handle describes the block as "the newer version plus my edits" and declares the newer version as its base — so the storage-side guard sees exactly the version it holds and passes, and every node computes the same wrong content and agrees on it.

Seen, in db-core, against the in-memory test transactor (which has no commit-time guard, so this shows the wrong content but not the guard passing): a one-leaf tree holding key 5; a rival inserts key 1 while the reading handle is served the leaf as it was; the handle stages an insert of key 9 (computed as "position 1" in the old one-entry leaf); storage catches up; the handle syncs. The committed leaf reads back in the order `1, 9, 5` — a mis-ordered B-tree leaf. The scratch spec was not kept.

How this differs before and after that ticket, so nobody re-measures it against the wrong baseline. **Before:** the older content was kept in memory permanently, so staged edits stayed consistent with it, the handle declared the *older* version as its base, and the storage-side guard refused the commit — loudly, and on every retry, until some other write happened to touch the block. **After:** the older content is no longer kept, so the base can change under staged edits as soon as storage catches up. If the block is not read again before the commit, the handle still declares the older version (it keeps the content it staged against describable for exactly this reason) and the guard still refuses. If the block *is* read again after storage catches up — a second statement in the same transaction touching the same block is enough — the declaration follows the newer content and the guard passes. The window is the time a machine lags (one read-repair window, 10 s by default), and it needs a write staged inside that window over a block another writer just changed.

What would close this arm is the same representation change as the other two, applied at the staging site: keep, with each block's staged operations, the version they were computed against, fixed at the first operation and never replaced; when the handle's content for that block moves to a different version, treat it as a conflict and re-stage the pending actions (the handle already has the machinery — it is what a refresh does) rather than re-describing the block. `files:` for this arm: `packages/db-core/src/transform/tracker.ts` (`update`, `peekMaterialized`), `packages/db-core/src/transform/base-pins.ts`, `packages/db-core/src/collection/collection.ts` (`mustReplay`, `replayActions`), `packages/db-core/src/transform/cache-source.ts` (the unkept answer it keeps describable).

What was run and what was inferred. Run, in db-core, with a transactor that records what each commit declares: in the scenario above the commit declares the *older* version as the leaf's base when the block is not read again before the commit, and the *newer* version when it is read once more after storage catches up (older version 1, newer version 2; declared 1 and 2 respectively). Inferred, not run: what a real storage node does with each — refuse the first and accept the second — which follows from the guard's rule (refuse unless the declared base is the version held) but needs a real `StorageRepo` cohort to see. What would confirm it is the scenario above through the fork-guard suite's harness, with the staging handle reading the block once more after the lagging member catches up and before it commits: expect the commit accepted and the leaf mis-ordered on every member.

## How this was found

Read during the review of `a-commit-over-a-gapped-base-forks-the-block` — by following the guard's own "this only checks what was declared" comment to the paths where nothing is declared. Not reproduced: no test drives the promotion path with a missing intermediate change. What would confirm it is a `StorageRepo` test in the shape of the existing fork-guard suite — seed a block, let a second member miss one update to it, hand that member the pend for the *next* update only, then read with a context naming both as committed, and compare the two members' content.

## A fourth place: the pend-time rival check has no base to compare against

Added 2026-09-17 from the review of `a-member-that-missed-a-commit-refuses-every-later-write`. Not a new defect in the storage node; the same missing fact, now load-bearing at one more site.

That ticket made a pending record a reservation for the revision it was pended at (`BlockMetadata.pendingRevs`), and both rival checks now let a pend through when the record claims a revision *below* the one the pend requests (`isReservationAgainst`, `packages/db-p2p/src/storage/pending-claim.ts`): the collection has moved past that slot, so the newcomer must have read the block after that change landed. That inference is what the whole fix rests on, and it is true whenever the machine answering the newcomer's read held the rival's pending record, because every read carries the list of committed actions and the answering machine finishes any held record for a listed action before it answers.

The inference is false in one shape, and the pend cannot see it. From four members up the promise bar is a super-majority, so one member can miss the rival's pend entirely. If that member answers the newcomer's read while the rival's second-stage commit (the blocks after the log tail) is still in flight, it serves the block one change short; a handle that has no floor for the block (a freshly opened one walks no log entries and so has none) accepts the answer. The newcomer pends past the rival's slot, and the members that hold the rival's record now approve where they used to refuse. At commit their local content matches the base the newcomer declared, so the commit-time guard passes, the transform applies over the stale base, and the sweep deletes the rival's record as dead. The rival's change to that block is gone while the log entry says it happened. Three-member cohorts are not exposed: every member holds every pend. Inferred from code, not reproduced (`repro: static`); what would confirm it is a four-member mesh spec that delays one rival's second-stage commit, opens a fresh handle whose block read routes to the member that missed the pend, and checks that block's content after both commits.

With the base carried on the pend, the rival check gets the discriminator it lacks: a record is superseded only when the newcomer's declared base for that block is at or past the record's claimed revision. A newcomer that built on the older content then declares the older base, is held as before, and re-reads after the rival lands. That is the same comparison the commit guard makes today, one round earlier, and it is the reason this arm belongs here rather than in a ticket of its own.

## Note: a commit no longer counts as a rival, which widens arms one and four slightly

Added 2026-09-17 from the review of `committing-a-block-deletes-a-pending-record-that-is-already-gone`, which reviewed triage commit `12399f79`.

That commit stopped the cluster's conflict check (`operationsConflict`, `packages/db-p2p/src/cluster/race-resolution.ts`) from treating a commit message as a rival to another action's pend or commit. It still conflicts with an invalidation. The change fixed an observed tear on two-member cohorts. A writer's log tail had landed, and the next writer's pend, built on that log tail, won a conflict vote against the first writer's data-block commit. It was kept.

Before that commit, the conflict vote was a timing-dependent second chance against the two shapes that arms one and four describe. The first is a rival commit that declares no base for a block. The second, from four members up, is a rival that read the block from a member that never received the first writer's pend. The vote fired only while the first writer's data-block commit was still in its own promise round at a member. Each member drops its reservation when it signs the commit, so the window after that was never covered. When the race went the rival's way, the vote tore the first writer, and the rival still landed over the older content. So the vote was never the guard, and nothing replaces it here. Carrying the base with the pend still closes both shapes, now with that promise-round window added to them. The safety argument at `operationsConflict`'s doc comment and in `docs/correctness.md` (Theorem 1, Case 2) now names both shapes and points here.
