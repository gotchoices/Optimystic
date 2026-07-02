description: When a block is read, the code that promotes its pending version to current runs without the lock that every other writer takes, so a read racing a write can silently roll the block back to an older version or mix up two writers' data.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts
difficulty: medium
----

# Read-driven promotion bypasses the per-block commit latch

`StorageRepo.get()` promotes a landed pending transaction by calling `internalCommit`
directly (`storage-repo.ts:168`), **without** first acquiring the per-block commit latch
(`withBlockCommitLatch(blockId, ...)`, exported and already used by `commit()`,
`saveReplicatedBlock`, and the dispute/invalidation path). `internalCommit`'s own comment
asserts it must run "within the locked critical section of commit()".

Because the promotion loop runs the `getLatest → save → promote → setLatest` sequence
unlatched, a read-driven promotion racing a concurrent `commit()` (or another promotion) on
the same block can interleave two such sequences. Observable consequences:

- `setLatest` regresses non-monotonically — `meta.latest` can move *backward* to an older
  revision after a newer one was already visible.
- The two writers can cross-write `revs/<N>` entries for different `actionId`s, so the
  materialization served for revision N depends on interleaving.

This is the same class of lost-update / non-monotonic-`latest` defect that
`5-invalidation-apply-commit-latch` (complete) closed for the invalidation-apply path, but on
a **different** unlatched write site — the read-driven promotion inside `get()`. The latch
key and helper already exist; this site was simply never brought under them.

Expected behavior: the promotion decision and the `getLatest`/`save`/`setLatest` writes must
execute under `withBlockCommitLatch(blockId, ...)`, with the pending re-checked *inside* the
latch (a concurrent commit may have already promoted or superseded it between the unlatched
read and latch acquisition). After the fix, no interleaving of a read-driven promotion with a
concurrent commit or promotion on the same block can regress `meta.latest` or cross-write a
`revs/<N>` entry.

## Reproduction notes

- Drive two concurrent operations on one block: a `get()` that triggers promotion of a landed
  pend, and a `commit()` (or a second `get()`), and assert `meta.latest.rev` is monotonic and
  each `revs/<N>` holds a single consistent actionId. The existing latch tests in
  `packages/db-p2p/test/storage-repo.spec.ts` are the model for injecting interleaving via
  gated micro-yields.

Suggested-fix hint: wrap the promotion loop body in `withBlockCommitLatch(blockId, ...)` and
re-read the pending inside the latch before promoting; mirror the scope already used by
`saveReplicatedBlock`.
