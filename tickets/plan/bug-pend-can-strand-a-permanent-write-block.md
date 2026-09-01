description: A storage node can be left holding a leftover "write in progress" marker for a write that already finished, and that marker makes the node refuse every future write to that block forever.
files:
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.pend — unlatched revision read in the per-block loop ~line 544, latched save fan-out ~line 641)
  - packages/db-p2p/src/storage/block-storage.ts (BlockStorage.savePendingTransaction, ~line 158 — the seam an invariant check could live at)
  - packages/db-p2p/src/storage/i-block-storage.ts (~line 74 — the interface signature that would have to carry the revision)
  - packages/db-core/src/network/stale-failure.ts (isOwnRevision — the single "is this our own committed revision?" rule)
  - docs/repository.md (Invariant P, ~line 132 — a pending record and a committed record never coexist for one action)
repro: static
difficulty: medium
----

# `pend` can leave a permanent, unclearable write reservation on a block

## What goes wrong, in plain terms

When a client writes, the storage node first records a "this write is coming" marker for each
block it touches (a *pending record*), then later turns that marker into a real committed
revision. Promotion at commit is the only thing that removes the marker on the success path.

`StorageRepo.pend` decides whether to write a marker by reading the block's current revision, and
writes the marker afterwards. Those two steps are not done together: the revision read
(`blockStorage.getLatest()`, in the per-block loop) is unprotected, while the write
(`savePendingTransaction`) takes the block's write latch. A commit that lands in the gap between
them is invisible to the decision that already ran, so a marker gets written for a revision that
is already taken.

Nothing ever removes such a marker:

- The follow-on commit sees the block already at that revision and skips it (`commit`'s
  `alreadyDone` partition skips `internalCommit`, the only promoter), so the marker is never
  promoted.
- `cancel` would delete it, but `cancel` only runs when the write *fails*. In the interleaving
  below the write succeeds, so nothing calls it.

From then on, that node reports the leftover marker as a conflicting in-flight action to every
later writer of that block — `StorageRepo.pend`'s own `listPendingTransactions` scan, and
`ClusterMember.validatePendOperations`'s rival check, both refuse on it. The node keeps serving
reads and looks healthy while contributing nothing to that block's writes.
`docs/repository.md`'s **Invariant P** already describes this end state, and already names `pend`'s
mirror-image obligation not to create the coexistence; what it does not yet say is that `pend`'s
own check-then-act split can create it anyway.

## The interleaving

One node, one block X, one action A (A touches several blocks; this is the retry of a write whose
blocks committed in groups — some landed, the rest were refused):

1. A's retry pends X. `pend` reads X's revision: still behind, so X is neither `satisfied` nor
   stale, and X is queued for a marker.
2. A's earlier commit for X arrives and lands. X advances to the requested revision and A's
   original marker is promoted away.
3. A's retry reaches its save fan-out, takes X's write latch, and writes a marker for A.

X now holds both a committed record and a marker for action A. A's next commit routes X to
`alreadyDone` and returns success, so the write completes and no `cancel` follows. The marker
stays forever.

The same gap strands a marker when the commit that lands in step 2 belongs to a *different*
action; that one does not violate Invariant P (the invariant is per action) but the marker is
equally unpromotable and wedges the block the same way.

## Why this wants an invariant at the seam, not a point fix

The narrow patch is to re-read the revision inside the latch, immediately before saving, and skip
the save when the revision is already taken. That closes this instance but leaves the same
check-then-act split available to any future caller of the pend path.

The stronger shape is to make the bad state unrepresentable at the storage seam:
`BlockStorage.savePendingTransaction` already runs under the block write latch and already reads
the block's metadata (to seed it when absent), so it is one comparison away from being able to
refuse a marker that can never be promoted. It cannot do that today because its signature —
`savePendingTransaction(actionId, transform, latch)` on both `BlockStorage` and `IBlockStorage` —
never receives the revision being pended, so the design work includes deciding how the revision
reaches it and what the seam does when it sees a taken one.

The three outcomes the seam has to distinguish are the same three `pend` already distinguishes,
and `isOwnRevision` is the existing single-sourced rule for two of them:

- committed revision **equals** the pended revision **and** the committing action is this same
  action → this is the writer's own durable half of a torn write; no marker (today's `satisfied`
  carve-out, reached by the unlatched read).
- committed revision is **at or past** the pended revision otherwise → the pend lost the race;
  refuse rather than write an unpromotable marker.
- no revision named at all (an insert-only claim, `rev === undefined`) → no revision comparison
  applies; the existing insert-collision handling in `pend` is unchanged.

## Expected behavior

- A pend never leaves behind a marker that no commit can promote and no cancel will remove.
- A pend whose revision was taken while it was in flight is refused — or skipped, when the taker
  is the pending action itself — rather than silently writing a marker.
- A node that loses this race stays able to accept later writes to the block.
- Whichever shape is chosen, `docs/repository.md`'s Invariant P section names it, so the invariant
  reads as enforced rather than merely asked-for.

## Cost to weigh during design

Closing this means the block's committed revision is read **inside** the write latch on every pend
— one extra storage read per block per pend on the hot write path, unless the design finds a way
to reuse the metadata read `savePendingTransaction` already performs (it reads metadata only to
seed an absent blob today, so on an existing block that read is currently skipped). A cheap
background sweep for leftover markers is the alternative worth explicitly rejecting or adopting,
not ignoring: it costs nothing on the write path but leaves the bad state reachable and the
invariant unenforced between sweeps.

## Notes

- Pre-existing: the check-then-act split predates the torn-action work
  (`torn-action-pend-tier-carve-out`), which only added a third possible outcome (`satisfied`) to
  the unlatched decision. The existing comment above the loop in `StorageRepo.pend` acknowledges
  the race but concludes "the commit is the final arbiter" — true for whether the write lands,
  false for the marker, which no later commit revisits.
- `ClusterMember.validatePendOperations` only *reads* state to vote; it writes no pending records,
  so it is a victim of a stranded marker, not a second producer. The producer is the storage tier.
- `repro: static` — read from the code and from the latch boundaries, not observed. Confirming it
  needs an injected delay between `pend`'s `getLatest()` and its save fan-out, with a commit for
  the same block landing in that window; the assertion is that the block's pending list is
  non-empty after the action's commit reports success. `packages/db-p2p/test/block-storage.spec.ts`
  (~line 1697) already pauses *inside* `savePendingTransaction` for the metadata-seed race and is
  the pattern to copy.
