description: When a storage node fails partway through applying a write that the rest of the cluster accepted, it keeps a leftover record of that write forever, which makes it report a phantom conflict on every later write to the same data. Delete those leftovers at the two moments they become impossible to use.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/src/cluster/cluster-repo.ts, docs/repository.md
difficulty: medium
repro: verified
----

# Drop pending records that can no longer be promoted

## Background — the two records a write leaves behind

A write lands on a node in two steps:

1. **pend** — `StorageRepo.pend` writes a *pending record* for the write, keyed by its action id,
   into the block's pending namespace (`IRawStorage.savePendingTransaction`).
2. **commit** — `StorageRepo.commit` → `internalCommit` materializes the new content, writes the
   revision entry, then calls `promotePendingTransaction`, which **atomically moves** the record
   from the pending namespace into the committed namespace (a single `rename` on the filesystem
   backend, a synchronous two-map swap in memory — see `file-storage.ts:215` and
   `memory-store-driver.ts:123`).

That atomic move is the existing invariant, stated here for the first time because the fix
generalizes it:

> **Invariant P:** a block never holds a pending record and a committed record for the same action
> id at the same time.

Today `promotePendingTransaction` is the *only* writer that maintains Invariant P. Every other route
that writes a committed transform for a block — replica persist, tombstone persist — ignores the
pending namespace entirely.

## The defect

`StorageRepo.commit` stops processing a batch on the first per-block failure. Two routes reach that
stop, and both leave pending records that nothing will ever promote:

- **The mid-loop break** (`storage-repo.ts:663`). `internalCommit` throws for one block — in
  practice `MissingBaseRevisionError`, this node holding no materializable base for that block — and
  the loop `break`s. Blocks later in `toCommit` were never reached and keep their pending records.
- **The pre-loop throw** (`storage-repo.ts:622`). This node never received the pend for one block in
  the batch, so `commit` throws *before* the per-block loop runs. **Every** block in the batch keeps
  its pending record.

In both cases `ClusterMember.applyConsensusOperation` (`cluster-repo.ts:1276`–`1327`) tolerates the
divergence and calls `reconcileDivergentCommit`, which pulls the committed revision from a cohort
peer for **every** `commit.blockIds` entry (`cluster-repo.ts:1451`–`1465`) and persists it through
`StorageRepo.saveReplicatedBlock` → `BlockStorage.saveReplica`. That advances each block's `latest`
to the committed revision — past the revision the leftover pending records were pended at — so a
commit retry now partitions those blocks as already-done or stale and never revisits the pendings.

The leftovers are then permanent, and `StorageRepo.pend` reports them as conflicting actions
(`storage-repo.ts:412`, `452`) on every later write to those blocks. Under `policy: 'f'` the node
refuses the pend outright; it therefore also misses the matching commit, and can only catch up by
replication — which needs enough corroborating peers. The node looks healthy, serves reads, and
silently contributes nothing to that block's writes forever.

A third, smaller route reaches the same state: `ClusterMember` tolerates an **ahead** divergence
(`cluster-repo.ts:1302`) with no reconcile — the node already holds the committed revision because
replication got there first, so `commit` returns stale via `missedCommits` and the pending record
for that action is dead on arrival.

Both `commit` routes are pinned by passing specs named `KNOWN GAP: …` in
`packages/db-p2p/test/storage-repo.spec.ts:1865` and `:1881`, under `mixed batch (one block
committable, one with no base)`.

## The fix — two arms, one root cause

The root cause is that *nothing owns deleting a pending record once it becomes unpromotable*. Two
sites make it unpromotable; each gets the deletion.

### Arm 1 — `StorageRepo.commit` drops the batch's pendings when it gives up for a divergence reason

When commit abandons a batch **because this node has diverged from the agreed history**, delete the
pending record for `request.actionId` on every `toCommit` block. `deletePendingTransaction` is a
no-op when the record is absent, so blocks that already landed (record promoted), blocks that were
`recovered` (record gone), and the refusing block itself (`refuseMissingBase` already deleted it)
need no special-casing.

**Discriminate by failure kind — this is the part that must not be skipped.** `ClusterMember`
already splits commit failures into *divergence* (tolerate + reconcile) and *genuine fault*
(propagate for retry) at `cluster-repo.ts:1296`–`1328`. Arm 1 applies the same split one layer down:

| failure at `StorageRepo.commit` | drop the batch's pendings? | why |
| --- | --- | --- |
| `MissingBaseRevisionError` from `internalCommit` | **yes** | `ClusterMember` reconciles every block in the batch, so all of them advance past the action |
| the pre-loop `Pending action … not found` throw | **yes** | same — this is the canonical "behind" signal and reconcile follows |
| any other `internalCommit` throw (raw storage fault, etc.) | **no** | `ClusterMember` propagates this for retry; a retry can still replay the pendings, so keep them |

`refuseMissingBase`'s doc comment (`storage-repo.ts:857`–`866`) already accepts exactly this
tradeoff for the single refusing block — "the block converges by replication instead of by a replay
the retry could have done". Arm 1 extends it to the batch's other blocks, and *only* for the failure
kinds where reconcile is guaranteed to follow.

Deletion must run **inside** commit's `try` block, while the per-block latches are still held, and
must not touch `collectionBlocks` — blocks that landed durably before the break still emit their
change events.

The pre-loop throw's message must stay byte-identical: `ClusterMember.isMissingPendingActionError`
matches on it, and the spec asserts it contains `Pending action` and does **not** contain
`MISSING_BASE_REVISION_REASON`.

### Arm 2 — `BlockStorage.saveForwardRevision` maintains Invariant P

`saveForwardRevision` (`block-storage.ts:240`) is the shared write path for `saveReplica` and
`saveDeletion`. Its `saveRestored` call writes the committed transform for `actionId`
(`block-storage.ts:405`). Add a `deletePendingTransaction(actionId)` immediately after, so writing a
committed record for an action always removes that action's pending record — the same guarantee
`promotePendingTransaction` gives, now held by every forward writer.

Scope it deliberately:

- **On the write path only.** The monotonic guard (`block-storage.ts:257`) returns early when an
  equal-or-newer revision is already held; leave that a true no-op. The earlier call that wrote the
  revision is the one that owed the deletion.
- **`saveForwardRevision`, not `saveRestored`.** `saveRestored` is also reached from
  `ensureRevision`'s historical-range restore, which runs under `BlockStorage.ensureRevision:<id>`
  and can overlap a live commit that holds only the commit latch — deleting a pending there could
  race a concurrent `promotePendingTransaction` and turn it into a spurious throw.
  `saveForwardRevision` has no such overlap: it holds `BlockStorage.saveReplica:<id>`, and its only
  `StorageRepo` entry point (`saveReplicatedBlock`) additionally holds the per-block commit latch,
  so it is already mutually exclusive with a live commit.
- **Only `actionId`, not a sweep of every committed pending.** O(1), race-free, and covers the
  evidence. Record the broader sweep as a tripwire (below) rather than building it.

Arm 2 is what covers the ahead-divergence route, where `commit` returns stale early and Arm 1 never
runs.

### Deliberately unchanged

`commit`'s stale/`missedCommits` early return (`storage-repo.ts:566`) does **not** delete pendings.
On the client path `TransactorSource.transact` already issues a `cancel` for a failed commit
(`transactor-source.ts:132`), and on the consensus path Arm 2 removes the record when the block
advances by replication. Widening the stale path would be a behaviour change with no failing case
behind it.

`StorageRepo.get`'s read-driven promotion loop, which aborts remaining context revisions on a
`MissingBaseRevisionError` (`storage-repo.ts:235`–`249`), also leaves pendings behind. Those blocks
heal through `CoordinatorRepo`'s read-repair → `saveReplicatedBlock`, so Arm 2 clears them. No third
site.

## Edge cases & interactions

Each of these should be a test or an explicit assertion in an existing one.

- **Sibling landed before the break** (`[OK, BLOCK]` order, spec `:1835`). `OK` committed and its
  record was promoted; the cleanup must be a no-op there, must not roll `OK` back, and `OK`'s change
  event must still fire.
- **Sibling never reached** (`[BLOCK, OK]` order, spec `:1845`). `OK` stays at no revision; its
  pending record is now deleted. Existing assertions must still hold.
- **The two `KNOWN GAP` specs** (`:1865`, `:1881`). Flip both `to.equal(false)` assertions to
  `to.equal(true)`, drop the "Tracked by …; flip this assertion when that lands" wording, and rename
  them off the `KNOWN GAP:` prefix — after this ticket the only remaining `KNOWN GAP:` in the file
  belongs to `debt-pending-only-insert-unreadable-with-context`.
- **Non-divergence fault retains pendings.** New test: inject a raw-storage fault so `internalCommit`
  throws something that is *not* a `MissingBaseRevisionError` mid-batch; assert the not-yet-reached
  sibling still holds its pending record (via `state.pendings` from `get`, or `BlockStorage`
  directly), and that a retry of the same `(actionId, rev)` commits it. This is the regression guard
  for the discriminator; without it Arm 1 silently degrades every transient fault into a reconcile.
- **Idempotent retry.** A block partitioned as `alreadyDone` is skipped by the pre-loop pend check
  and is not in `toCommit`; confirm it is untouched by the cleanup.
- **Crash-D3 `recovered` blocks.** Their pending record is already gone and they are skipped by the
  internalCommit loop; the cleanup must be a harmless no-op and must not disturb the recovered-block
  change-event loop at `storage-repo.ts:634`–`645`.
- **Throw shape preserved.** Assert the pre-loop throw still carries `Pending action` and still
  omits `MISSING_BASE_REVISION_REASON` after cleanup runs.
- **Arm 2 on a fresh replica.** `saveReplica` onto a block holding a pending record for the same
  action id: revision lands, pending record gone, a later `policy: 'f'` pend is accepted.
- **Arm 2 on a tombstone.** Same through `saveDeletion` — the forward-tombstone path writes a
  committed transform too.
- **Arm 2 monotonic no-op.** `saveReplica` at an equal-or-older revision returns early and must not
  delete anything (nothing was written).
- **Delete-of-absent is a no-op.** Already true on both backends (`memory-store-driver.ts`,
  `file-storage.ts:123` swallows `ENOENT`); no conformance change needed, but do not introduce a
  code path that assumes the record exists.
- **Latch discipline.** Arm 1's deletions happen inside commit's `try`, before `finally` releases
  the latches. Arm 2's happen inside `saveForwardRevision`'s latch. Neither acquires a new latch, so
  neither can deadlock against commit's sorted multi-latch acquisition.

## Tripwires to record in code (NOT tickets)

- At the Arm 2 deletion site: `// NOTE: deletes only this revision's actionId, not every pending whose action is already committed. A broader sweep would repair records orphaned by routes that do not carry the committing actionId; if orphaned pendings ever show up in the field on blocks whose committing action id differs, widen to a sweep over listPendingTransactions filtered by getTransaction.`
- At the Arm 1 discriminator: `// NOTE: a non-divergence fault keeps the batch's pendings so a retry can replay them. If ClusterMember ever stops retrying propagated commit faults, this arm becomes dead weight and the discriminator can collapse to "always drop".`

## TODO

### Phase 1 — Arm 1: commit-side cleanup

- Add a private helper on `StorageRepo` that deletes `request.actionId`'s pending record across a
  given set of block storages, tolerating absence.
- Call it before the pre-loop `Pending action … not found` throw, over the `toCommit` set, leaving
  the thrown message unchanged.
- Call it after the mid-loop `break`, over the `toCommit` set, **only** when the caught error is a
  `MissingBaseRevisionError`; retain pendings for every other error.
- Add the discriminator `NOTE:` tripwire comment.
- Extend `StorageRepo.commit`'s doc/comments so the divergence-vs-fault split is stated at the site,
  not only in `refuseMissingBase`.

### Phase 2 — Arm 2: forward-write invariant

- In `BlockStorage.saveForwardRevision`, delete `actionId`'s pending record after `saveRestored`.
- State Invariant P in `IBlockStorage`'s doc for `promotePendingTransaction` / `saveReplica` /
  `saveDeletion` so the next writer of a forward path inherits it.
- Add the sweep `NOTE:` tripwire comment.

### Phase 3 — tests

- Flip and rename the two `KNOWN GAP` specs at `storage-repo.spec.ts:1865` and `:1881`.
- Add the non-divergence-fault-retains-pendings test (and its retry-succeeds assertion).
- Add `block-storage.spec.ts` coverage for Arm 2: replica clears a matching pending record,
  deletion clears one, monotonic no-op clears nothing.
- Add an assertion to the `[OK, BLOCK]` spec that the landed sibling's change event still fires.

### Phase 4 — docs and validation

- Add Invariant P to `docs/repository.md` alongside the commit description (~lines 75–90): a block
  never holds a pending and a committed record for the same action id, and every forward writer
  maintains it.
- `yarn build` from root, then `yarn test:db-p2p` (or `yarn test` from `packages/db-p2p`), streaming
  output with `tee`. Grep the run for the two flipped specs.
- Do **not** run `yarn test:integration` inside this ticket — it exercises real TCP meshes and
  routinely exceeds the runner's idle window. Note the deferral in the review handoff.
