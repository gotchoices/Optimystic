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

## How this was found

Read during the review of `a-commit-over-a-gapped-base-forks-the-block` — by following the guard's own "this only checks what was declared" comment to the paths where nothing is declared. Not reproduced: no test drives the promotion path with a missing intermediate change. What would confirm it is a `StorageRepo` test in the shape of the existing fork-guard suite — seed a block, let a second member miss one update to it, hand that member the pend for the *next* update only, then read with a context naming both as committed, and compare the two members' content.
