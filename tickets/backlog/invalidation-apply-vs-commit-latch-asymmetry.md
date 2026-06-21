description: Investigate whether reverting a transaction can race a normal write to the same block and corrupt which version is considered current, because the two paths guard that bookkeeping with different locks.
prereq:
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts
difficulty: medium
----

# Invalidation apply vs. commit: per-block latch asymmetry

## Background

This was surfaced during review of `invalidation-delete-restore-and-created-block-reversal`
(see `tickets/complete/`). It is **pre-existing** — the new `saveDeletion` tombstone path merely
inherits the same property the restore path already had — so it was out of scope for that ticket,
but it is a real latent concern worth confirming or closing.

## The asymmetry

Both the invalidation-apply path and the normal commit path do a read-modify-write of a block's
`meta.latest` (and `meta.ranges`), but under **different** named latches:

- `BlockStorage.saveReplica` / `BlockStorage.saveDeletion` acquire `BlockStorage.saveReplica:<blockId>`.
- `StorageRepo.commit` → `internalCommit` runs under `StorageRepo.commit:<blockId>`.
- `StorageRepo.saveReplicatedBlock` (the churn re-replication path) deliberately wraps its
  `saveReplica` call in the **outer** `StorageRepo.commit:<blockId>` latch precisely so its RMW of
  `latest` is mutually exclusive with a concurrent local commit on the same block (see its doc
  comment).

`applyInvalidation` (in `dispute/invalidation.ts`) calls `storage.saveReplica(...)` (restore branch)
and `storage.saveDeletion(...)` (delete branch) **directly**, NOT wrapped in the
`StorageRepo.commit:<blockId>` latch. So an invalidation reversal and a normal commit on the *same*
block are serialized only if they happen to contend on the same latch — and they do not. Two
concurrent RMWs of `meta.latest` under disjoint latches can interleave, so the monotonic guard in
`saveReplica`/`saveDeletion` can read a stale `latest` relative to a commit that advanced it (or
vice-versa), risking a lost update / non-monotonic `latest`.

## What to determine

1. Can `applyInvalidation` actually run concurrently with a `StorageRepo.commit` on the same block in
   production? The network-facing path is `ClusterMember.applyConsensusInvalidation → onInvalidate →
   applyInvalidation`; commits funnel through the cluster/coordinator. If the cluster already
   serializes apply-vs-commit for a given block at a higher level, this is moot (then: document that
   invariant and close).
2. If they can race, the fix is likely to make the invalidation apply path acquire the same
   `StorageRepo.commit:<blockId>` latch the churn path uses before its `saveReplica`/`saveDeletion`
   RMW — but `applyInvalidation` lives in the dispute module and only has an `IBlockStorage`, not the
   `StorageRepo`, so the latch acquisition would need to be threaded through `InvalidationContext`
   (or `saveReplica`/`saveDeletion` themselves taught to take the outer latch). Decide the cleanest
   seam.

## Use case / expected behavior

A block being reverted by an invalidation while a legitimate later commit targets the same block must
not leave `meta.latest` pointing at the wrong (or a rolled-back) revision. The two writers must agree
on a single monotonic `latest`, regardless of interleaving.
