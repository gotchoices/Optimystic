description: A storage node will accept a new version of a block even when it skipped one or more intermediate versions, applying the new change on top of stale data and then serving a wrong result that diverges from other nodes — with no signal that anything is missing.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts
difficulty: medium
----

# Commit accepts non-contiguous revisions — divergent materializations served silently

`StorageRepo.commit()` only rejects a request when `latest.rev >= request.rev`
(`storage-repo.ts:385-411, 540-550`); it never checks that the incoming revision is
*contiguous* with what the node already has. A replica that missed one or more intermediate
commits (e.g. was offline, or lost them) accepts a rev-N pend and materializes the rev-N
transform on top of its **stale local base** (rev < N-1). The result is a materialization that
diverges from every up-to-date replica, is then served to readers, and is cached as the
authoritative rev N.

The gap is also invisible to the restoration machinery, because pends seed
`ranges: [[0]]` (see companion finding `st-pend-seeds-open-ended-ranges`), which makes every
revision look locally present — so `ensureRevision` never fires to fetch the missing
predecessor.

Expected behavior: a commit whose `request.rev` is more than one ahead of `latest.rev`
(`latest.rev < request.rev - 1`) is treated as a gap. The node must either trigger
`ensureRevision`/restore to reconstruct the missing predecessor(s) before applying the
transform, or fail the commit with a distinct "behind" result the caller can act on — never
silently materialize on a stale base.

After the fix, applying a rev-N transform when the local latest is older than rev N-1 does not
produce a locally-cached divergent block; the missing predecessor is either restored first or
the commit is rejected as behind.

## Reproduction notes

- Seed a repo at some rev K, then submit a commit for rev K+2 (skipping K+1) and assert the
  node does not serve/cache a block materialized on the K base — it either restores K+1 or
  returns a distinct behind/gap result.

Interaction: this fix is most effective alongside `st-pend-seeds-open-ended-ranges` (honest
`meta.ranges` is what makes the gap detectable by restoration), but the contiguity check in
`commit()` stands on its own.

Suggested-fix hint: add a contiguity guard next to the existing `latest.rev >= request.rev`
staleness check.
