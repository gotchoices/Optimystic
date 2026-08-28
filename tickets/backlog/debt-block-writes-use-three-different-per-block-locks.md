description: Three different parts of the storage layer each take their own lock before writing a block, so two of them can run at the same time on the same block and overwrite each other's work.
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-storage.spec.ts
difficulty: hard
severity: corruption
likelihood: unusual
tradeoffs: The overlap needs two writers hitting the same block at the same instant and has never been observed in the field, while the fix has to solve a re-entrancy problem first (see below) — a maintainer may reasonably judge a narrow, unobserved race not worth destabilising the locking of the most write-critical file in the package.
----

# One block, three locks

Every path that writes a block's revision records or its metadata first takes a per-block lock so
concurrent writers do not interleave. There are three such paths, and each invented its **own lock
name**:

| Path | Lock it takes |
|---|---|
| `StorageRepo.commit` / `saveReplicatedBlock` / `withBlockCommitLatch` | `StorageRepo.commit:<blockId>` |
| `BlockStorage.saveForwardRevision` (reached by `saveReplica` / `saveDeletion`) | `BlockStorage.saveReplica:<blockId>` |
| `BlockStorage.ensureRevision` (the restore-a-missing-revision path) | `BlockStorage.ensureRevision:<blockId>` |

Different names are different locks. Two of these can therefore be inside their "critical section"
for the *same block* at the same time, and each one's read-then-write of the same records is not
actually protected from the other.

## What goes wrong

Two concrete interleavings, both on one block:

**A restored revision overwrites a just-committed one.** `ensureRevision` now checks, before writing
anything, that the archive a peer handed back does not contradict what this node already holds
(`vetRestoredArchive` → `noDivergentRewrite`, added by `restore-trusts-any-archive-a-peer-returns`).
That check reads storage; the write happens afterwards. A commit or a replica push landing in
between writes revision N under action X — and the restore, whose check ran when N was absent, then
writes revision N under action Y. The block's "latest" still names X while a read of revision N
serves Y's content. The guard that was added specifically to make this impossible is defeated by
timing alone.

**A metadata update is lost.** `ensureRevision` and `saveForwardRevision` both do read-metadata →
modify → write-metadata, under different locks. Either can overwrite the other's change wholesale —
losing a revision-coverage extension, or losing an advance of `latest`. This half predates the
restore-vetting work; it is the same root cause.

## Why it is not a one-line fix

The obvious repair — have `ensureRevision` take the commit lock too — deadlocks. `ensureRevision` is
already reachable from *inside* the commit critical section: `StorageRepo.internalCommit` holds
`StorageRepo.commit:<blockId>` and calls `readCommitBase` → `IBlockStorage.getBlock` →
`ensureRevision`. Acquiring the same lock again on that path would block on itself forever.

So the work is to settle what the per-block write lock actually is, and make all three paths agree on
it, without reintroducing that self-block. Options worth weighing, not a decision:

- One lock name for all block writes, plus a way for a path already holding it to proceed
  (re-entrancy, or hoisting the acquisition to a single outer place so nested code never acquires).
- Keep the locks separate but make the restore write conditional — re-check under the write, or
  write-if-absent at the storage layer — so an interleaved write is detected rather than clobbered.

The end state to aim for is an invariant, not a patch: **a block's revision records and metadata are
only ever written while holding one named lock for that block**, stated where a reader will meet it
and ideally checkable rather than remembered.

## Evidence

`grep -n "Latches.acquire" packages/db-p2p/src/storage/*.ts` shows the three call sites and their
three distinct key expressions; `commitLatchKey` is defined at `storage-repo.ts:28`, the
`saveReplica` key at `block-storage.ts:303`, the `ensureRevision` key at `block-storage.ts:390`. The
commit-path reach into `ensureRevision` is `storage-repo.ts:1036` (`readCommitBase`) →
`storage-repo.ts:1219` (`storage.getBlock`).

repro: static — read from the code, not observed. What would confirm it: a test that stalls
`vetRestoredArchive` between its check and `saveRestored`'s write (an instrumented `IRawStorage`
whose `getRevision` awaits a latch the test releases), lands a `saveReplicatedBlock` for the same
revision in the gap, and then asserts the revision record still names the committed action.
