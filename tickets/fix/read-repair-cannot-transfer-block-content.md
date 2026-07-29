----
description: When a node notices it is behind on a piece of data, it can now correctly work out which version the rest of the cluster has — but it still has no way to actually fetch that newer data, so it silently stays behind until the next write reaches it.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts
difficulty: hard
----

# Read-repair selects the right revision but cannot fetch it

## Status: reproduced, not fixed

A failing-by-design spec already exists and passes today because it asserts the broken
behavior:

```
cd packages/db-p2p && yarn test:verbose --grep "CONTENT convergence"
```

`packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts` wires two nodes' real
`StorageRepo`/`BlockStorage` over an in-process stand-in for the sync protocol, diverges
them (node A at rev 2, node B at rev 1), reads through B's `CoordinatorRepo`, and asserts
that B's `latest` pointer stays at rev 1 and its block payload stays at `v1`. Inverting
that last spec is this ticket's acceptance test.

## What happens today

`bug-read-repair-unrepairable-small-cluster` fixed *selection*: `queryClusterForLatest`
now excludes the reader's own revision and returns the cohort-corroborated
`(rev, actionId)`, and `CoordinatorRepo.fetchBlockFromCluster` logs `cluster-fetch:synced`
at the correct newer revision. Everything after that point is a no-op.

The "restoration" is one line (`coordinator-repo.ts`, in `fetchBlockFromCluster`):

```ts
await this.storageRepo.get({ blockIds: [blockId], context: { committed: [corroborated], rev: corroborated.rev } });
```

Two independent reasons that moves no bytes:

1. **The commit context only promotes a LOCAL pending.** `StorageRepo.get`'s context
   branch (`storage-repo.ts`) walks `context.committed` entries above `latest.rev` and,
   for each, calls `blockStorage.getPendingTransaction(actionId)` — promoting only if the
   node already holds that pending. A node that never participated in the action has no
   pending, so the loop does nothing and `meta.latest` is never advanced.

2. **`ensureRevision` never fires for a FORWARD revision.** The follow-up
   `blockStorage.getBlock(context.rev)` would, in principle, restore through the
   `restoreCallback` (`RestorationCoordinator` → `SyncClient`). It does not: `setLatest`
   records coverage as the open-ended span `[E, +∞)` (`block-storage.ts`), so
   `inRanges(2, [[1]])` is already true and `ensureRevision` returns immediately. The
   descending walk in `materializeBlock` then resolves the requested rev 2 down to the
   node's own rev-1 materialization and returns it — silently, with no error. Only revs
   *below* the earliest held rev `E` can miss `inRanges`, which is why the restore path is
   reachable for historical gaps but never for catching up.

Block-transferring restoration exists only on the commit path: `reconcileBlock` →
`fetchArchiveFromPeer` → `storageRepo.saveReplicatedBlock` (`libp2p-node-base.ts`), driven
by `ClusterMember` when a member commits a block it never pended.

Consequence: a node that misses a commit broadcast stays behind until a later commit or a
churn/rebalance pass happens to push the block to it.

**Update (`bug-member-commits-unmaterializable-revision`, landed).** Two things this ticket
previously had to work around are now fixed, and one of its edge cases is now settled:

- `cluster-fetch:synced` is emitted only when `latest` actually advanced; a no-op restore logs
  `cluster-fetch:not-restored`. The logs are now honest evidence, so the acceptance test for
  this ticket can assert `cluster-fetch:synced` directly.
- The **block entirely missing locally** edge case below is decided, not open: the read path
  deliberately does NOT acquire a never-seen block, because turning every read of a genuinely
  absent block into a network fetch is unacceptable (an insert probes for collisions this way).
  `BlockStorage.getBlock`'s early return now says so in place. If this ticket's chosen mechanism
  wants read-driven acquisition of a never-seen block, it must gate it on something narrower than
  "no local metadata" — e.g. only when the caller supplies a cluster-corroborated `context.rev`.
- Commit-path acquisition covers strictly more than it used to: a member that holds the pend but
  missed the block's creating revision now refuses and reconciles instead of wedging, so this
  ticket is no longer the only route by which a block reaches a lagging member.

Still true and still this ticket's job: `cluster-tx:read-repair-applied` never fires for a
content gap (the revs never move, so it logs `cluster-tx:read-repair-noop`), and read-repair
moves no bytes.

## Why the mesh harness hides this

`packages/db-p2p/src/testing/mesh-harness.ts`'s `clusterLatestCallback` does something the
production callback in `libp2p-node-base.ts` does not: after reading the peer's latest it
writes the peer's block into local storage itself ("simulate data sync"). Every read-repair
assertion that runs on the harness therefore observes convergence that the real code path
does not provide. Any fix should also make the harness stop faking this, or the harness
will keep masking regressions here.

## Shape of the work (not yet decided — this is the research this ticket owes)

At least these options exist; pick one and justify it:

- **Give `CoordinatorRepo` a block-fetch callback** mirroring `fetchArchiveFromPeer`, and
  persist through the existing `saveReplicatedBlock` funnel (which already holds the
  per-block commit latch and is monotonic). Reuses a proven path; means read-repair needs
  the same content-agreement gate reconcile has (`selectQuorumBlock`) rather than trusting
  the single peer it fetched from.
- **Make the read path's restore reachable** by distinguishing "revisions I can reconstruct"
  from "revisions I have", so `ensureRevision` calls the restore callback for a forward rev
  instead of resolving it downward. This touches `meta.ranges` semantics, which several
  comments in `block-storage.ts` deliberately reason about — high blast radius.

Whichever is chosen, the fix must also settle:

- **Advancing `latest`.** `saveRestored` writes revisions but never touches `meta.latest`;
  `saveForwardRevision` (used by `saveReplica`/`saveDeletion`) does, under the block commit
  latch, with a monotonic guard. A read-driven advance must be at least as careful.
- **Content trust.** Read-repair currently verifies nothing about a peer's bytes. Reconcile
  requires a byte-identical hash across a quorum before persisting; read-repair pulling
  content without an equivalent gate would be a trust regression, and in a two-member cohort
  there is no second server to compare against at all.
- **Whether `markBlocksSeen` should fire when the transfer fails**, so a failed pull does
  not suppress the next attempt for the read-repair window.

## Edge cases & interactions

- Block entirely **missing** locally (no metadata at all): `BlockStorage.getBlock` returns
  `undefined` before `ensureRevision` runs, so today's read path cannot restore a
  never-seen block. That early return is now documented as deliberate (see the update above) —
  if the chosen fix covers this case it must not make a genuinely-absent block cost a fetch.
- **Pending-only block asked for an explicit rev.** A block whose metadata exists only because
  `savePendingTransaction` seeded it (`latest === undefined`, empty `ranges`) does reach
  `ensureRevision`, which then *throws* `revision N not found during restore attempt` when the
  restore yields nothing. `fetchBlockFromCluster` swallows that as `cluster-fetch:error`, but
  any other caller of `StorageRepo.get` with a context sees a read fail where "absent" is the
  honest answer. Decide whether an unobtainable forward revision should be an error or an
  absence; it is entangled with the `meta.ranges` semantics this ticket already owns.
- **Reader ahead of the cohort** — must remain a no-op (already guarded in
  `fetchBlockFromCluster`; keep it guarded once bytes can actually move).
- **Concurrent local commit** during a read-driven persist — must serialize on
  `commitLatchKey`, like every other writer of `meta.latest`.
- **Tombstones / deletes** — a forward revision may be a delete; `saveDeletion` handles this
  shape on the replica path, a read-driven path must not resurrect a deleted block.
- **Pruned materializations** — the serving peer may hold only a forward transform for the
  target rev (checkpoint retention), so a fetch must tolerate an archive without a block.

## TODO

- [ ] Decide the transfer mechanism and record the tradeoff.
- [ ] Make the lagging node's `latest` and content actually converge on a read.
- [ ] Decide and implement the content-trust gate for read-repair-fetched bytes.
- [ ] Invert the `KNOWN GAP` spec in `coordinator-repo-read-repair-content.spec.ts`, plus the
      `cluster-fetch:not-restored` assertion in the `selects the peer's newer revision` spec
      (it should become `cluster-fetch:synced` once bytes really move).
- [ ] Revisit `markBlocksSeen` on a no-op restore: `fetchBlockFromCluster` still marks the block
      seen when nothing was restored, suppressing retry for the whole window. Left unchanged
      deliberately (dropping it would make every read of a stale block re-poll the cohort while
      the transfer is still missing) — reconsider once the transfer exists.
- [ ] Stop the mesh harness from faking data sync inside `clusterLatestCallback`.
- [ ] Update `docs/transactions.md` § "What a repair pass will and will not accept" — it
      currently documents this gap as known.
