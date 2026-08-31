description: A storage node can be left holding a leftover "write in progress" marker for a write that already finished, and that marker makes the node refuse every future write to that block forever.
files:
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.pend — the unlatched revision read in the per-block loop at ~line 512, and the latched save fan-out at ~line 604)
  - packages/db-p2p/src/storage/block-storage.ts (savePendingTransaction — the seam an invariant check could live at)
  - docs/repository.md (Invariant P — a pending record and a committed record never coexist for one action)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Closing it means re-reading the block's revision inside the write latch on every pend, which adds one storage read per block per pend to the hot write path — a maintainer may reasonably judge the race too narrow to pay for, or prefer a cheap background sweep for leftover markers instead.
----

# `pend` can leave a permanent, unclearable write reservation on a block

## What goes wrong, in plain terms

When a client writes, the storage node first records a "this write is coming" marker for each
block it touches (a *pending record*), then later turns that marker into a real committed
revision. Turning it into a commit is the only thing that removes the marker.

`StorageRepo.pend` decides whether to write a marker by reading the block's current revision, and
it writes the marker afterwards. Those two steps are not done together: the revision read is
unprotected, while the write takes the block's write latch. A commit that lands in the gap between
them is invisible to the decision that already ran, so the marker gets written for a revision that
is already taken.

Nothing ever removes such a marker:

- The follow-on commit sees the block is already at that revision and skips it (the `alreadyDone`
  partition), so it never promotes the marker.
- `cancel` would delete it, but `cancel` only runs when the write *fails*. In the interleaving
  below the write succeeds, so nothing calls it.

From then on, that node reports the leftover marker as a conflicting in-flight action to every
later writer of that block — `StorageRepo.pend`'s own scan of outstanding markers, and
`ClusterMember.validatePendOperations`'s rival check, both refuse on it. The node keeps serving
reads and looks healthy while contributing nothing to that block's writes. `docs/repository.md`
already describes exactly this end state under **Invariant P**; what it does not yet say is that
`pend` itself can create it.

## The interleaving

One node, one block X, one action A (A touches several blocks; this is the retry of a write whose
blocks committed in groups — some landed, the rest were refused):

1. A's retry pends X. `pend` reads X's revision: still behind, so X is neither satisfied nor
   stale, and X is queued for a marker.
2. A's earlier commit for X arrives and lands. X advances to the requested revision and A's
   original marker is promoted away.
3. A's retry reaches its save step, takes X's write latch, and writes a marker for A.

X now holds both a committed record and a marker for action A. A's next commit routes X to
`alreadyDone` and returns success, so the write completes and no `cancel` follows. The marker
stays forever.

The same gap strands a marker when the commit that lands in step 2 belongs to a *different*
action; that one does not violate Invariant P (the invariant is per action) but the marker is
equally unpromotable and wedges the block the same way.

## Why this is filed as a boundary invariant, not a point fix

The narrow patch is to re-read the revision inside the latch, immediately before saving, and skip
the save when the revision is already taken. That closes this instance but leaves the same
check-then-act split available to any future caller.

The stronger shape is to make the bad state unrepresentable at the storage seam: have
`BlockStorage.savePendingTransaction` — which already runs under the block write latch and already
reads the block's metadata to seed it — refuse (or no-op) when the block's committed revision is
already at or past the revision being pended. No caller can then create a marker that cannot be
promoted, and Invariant P becomes enforced rather than merely documented. Whichever shape is
chosen, `docs/repository.md`'s Invariant P section should end up naming it.

## Expected behavior

- A pend never leaves behind a marker that no commit can promote and no cancel will remove.
- A pend whose revision was taken while it was in flight is refused (or skipped, when the taker is
  the pending action itself) rather than silently writing a marker.
- A node that loses this race stays able to accept later writes to the block.

## Notes

- Pre-existing: the check-then-act split predates the torn-action work
  (`torn-action-pend-tier-carve-out`), which only added a third possible outcome to the unlatched
  decision. The existing comment above the loop in `StorageRepo.pend` acknowledges the race but
  concludes "the commit is the final arbiter" — true for whether the write lands, false for the
  marker, which no later commit revisits.
- `repro: static` — read from the code and from the latch boundaries, not observed. Confirming it
  needs an injected delay between `pend`'s revision read and its save, with a commit for the same
  block landing in that window; the assertion is that the block's pending list is non-empty after
  the action's commit reports success.
