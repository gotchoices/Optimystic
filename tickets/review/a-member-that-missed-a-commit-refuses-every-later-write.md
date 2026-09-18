description: A machine that promised a write and then missed its commit kept a leftover "write in progress" marker and vetoed every later write to that data until it happened to read the data itself. Fixed by recording which revision each marker claims, so a marker for a revision the group has already moved past no longer counts as a live rival; a three-machine spec that failed on the old code after about 17 seconds now passes in about a second.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/storage/pending-claim.ts (new: `PendingClaim`, `isReservationAgainst` — the one rule)
  - packages/db-p2p/src/storage/struct.ts (`BlockMetadata.pendingRevs`)
  - packages/db-p2p/src/storage/block-storage.ts (`savePendingTransaction` records the claim; `deletePendingTransaction` drops it; `listPendingClaims`; `sweepDeadClaims` from `setLatest`, `recover`, `saveForwardRevision`)
  - packages/db-p2p/src/storage/i-block-storage.ts (`listPendingClaims` contract)
  - packages/db-p2p/src/storage/storage-repo.ts (`pend`'s apply-time rival scan; `IPendingClaimReader` capability)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations`' rival branch; `reservingRivals`; `nameStuckReservation`)
  - packages/db-p2p/src/repo/stuck-reservation.ts (new: `StuckReservationTracker`, extracted from the coordinator so members can count too)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`noteStuckReservation` and `clearStuckReservations` delegate to the tracker; NOTEs rewritten)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (export the new module from both entries)
  - packages/db-p2p/test/member-missed-commit-heals-at-vote.spec.ts (new: the six-step reproduction, asserting the fixed behaviour)
  - packages/db-p2p/test/cluster-pend-held-vote.spec.ts, block-storage.spec.ts, storage-repo.spec.ts (new sections)
  - docs/correctness.md, docs/internals.md, docs/repository.md (Theorem 9's `held` paragraph; the held bullet; a new Invariant P sub-section on claims and the dead-claim sweep)
  - tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md (arm: what this change settles for that ticket)
difficulty: hard
----

# What was wrong, in one paragraph

A pending record is the durable marker a member stores when it promises a write and removes when the write commits or is cancelled. Both places that check for rival writers — the member's promise vote (`validatePendOperations`) and storage's own apply-time scan (`StorageRepo.pend`) — treated any rival record as a live reservation. A member that promised a write and missed its commit therefore held a record nobody would ever remove (the writer believed the write succeeded, and it had, by majority), and voted `held` against every later pend of that block. At three machines the promise bar is all three, so one such vote refused every write to the block from every machine, until the stuck member happened to read the block itself, which nothing schedules.

# What changed

**A pending record now claims a slot.** Storage keeps the revision each record was pended at, in the block's metadata beside `latest` (`BlockMetadata.pendingRevs`), written in the same metadata write that seeds a fresh block and dropped with the record. It is in the metadata rather than in the record because the raw drivers promote a record by moving its bytes into the committed store unchanged (a rename on the filesystem backend), so the record's value has to stay a plain transform. `IBlockStorage.listPendingClaims` joins the two back together.

**One rule at both rival checks.** `isReservationAgainst(claim, requestedRev)`: a record claiming the requested revision or a later one reserves the block; a record claiming an earlier revision has been superseded by the collection moving on and does not. Revisions are collection-scoped and a writer pends at one past the collection revision it read, so "the requested revision is past the claim" means the incoming writer already read past that slot and built on that commit's outcome (a read under a block's floor is re-asked). The superseded record's action either committed at its slot on the rest of the cohort (this member missed the commit) or lost the slot; either way it is not a rival for the slot being requested. A record with no recorded revision (pre-existing data, or a rev-less pend) reserves, so old data can only refuse more than it should, never less.

**The member comes current through the pend's own commit, not through a reconcile in the vote.** No network I/O was added to the promise vote. When the admitted pend commits, `internalCommit`'s fork guard refuses the base mismatch on the behind member, which triggers the existing behind-reconcile; the block lands at the new revision, and the superseded record is then provably dead.

**Dead records are swept where they become provable.** A record claiming a revision the block has reached can never be promoted (promotion needs `latest.rev < rev`). `BlockStorage.sweepDeadClaims` deletes such records and their claims from `setLatest`, `recover` and `saveForwardRevision`, under the block's write latch. This widens the same-action delete at `saveReplica` exactly as its old NOTE anticipated ("orphaned pendings on blocks whose committing action id differs"), and it is the locally decidable half of what backlog `debt-unpromotable-pending-records-need-a-sweep` asks for. A record with no recorded revision is never swept.

**A wedge that remains is named by the member that holds it.** The counting, threshold and wording of the coordinator's `stuck-reservation` line were extracted into `StuckReservationTracker`; the coordinator's behaviour and log payload are unchanged (its spec passes untouched), and each member now keeps its own tracker fed by its own `held` votes, logging `cluster-member:stuck-reservation` once per episode with `peerId` in the payload. This is the remedy both of the coordinator's old NOTEs named; those NOTEs are rewritten to say what is now true.

# The decision, and what was rejected

The ticket proposed two shapes: heal at the vote by reconciling from the cohort, or add a "behind" vote kind. Neither was built. Reproducing the ticket's six steps showed the fault produces **two** wedges, not one: the missed tail commit on the returning member, and the torn write's non-tail block, whose pending record stands on every member that did not clear it by a read (in the reproduction, two of three). A cohort reconcile cannot cure the second, because nobody committed that block at that revision. What both share is that the record claims a revision the incoming pend has moved past, so the slot rule cures both, keeps the vote local, and needs no new vote kind or signed-payload change. Recorded at the site in `validatePendOperations`' doc comment and branch comment.

The ticket's stated discriminator ("the pending record stores its rev") was verified **false** before building on it: `BlockStorage.savePendingTransaction` checked the revision and discarded it; raw storage kept only the transform. Storing it was the first change.

# How to validate

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/member-missed-commit-heals-at-vote.spec.ts" "test/cluster-pend-held-vote.spec.ts" "test/stuck-reservation-named.spec.ts" "test/torn-commit-cancels-abandoned-blocks.spec.ts" "test/block-storage.spec.ts" "test/storage-repo.spec.ts" --reporter spec
```

- `member-missed-commit-heals-at-vote.spec.ts` is the reproduction. On the pre-change code phase 4 fails with `SyncRetryExhaustedError … Pend blocks held: 2/3 member(s) hold an unresolved rival action` after ~17 s (run and observed before the fix; the log is `tickets/.logs/a-member-that-missed-a-commit.repro.log`). After: the write lands fully durable in ~1.3 s, C's own storage holds the missed revision, the record is gone, and no repo call was routed through C (`onRoute` asserted). Phase 5 then writes from every machine at `full`.
- `cluster-pend-held-vote.spec.ts` second suite: superseded → `approve`; same slot → `held`; later slot → `held`; unknown claim → `held`; only reserving rivals named in `heldBy`; capability-less repo → `held`; member-side `stuck-reservation` said once at 8 distinct writers, silent before and after.
- `storage-repo.spec.ts` last suite: apply-time scan admits a later-slot pend with `pending: []`, still refuses the same slot, and the later commit sweeps the record.
- `block-storage.spec.ts` last suite: claim recorded/dropped/unknown; `setLatest`, `saveReplica` (different action) and `recover` sweep dead claims and leave live and unknown ones.

Full runs done, all green: db-p2p `yarn test` 3010 passing, 63 pending, 0 failing on the final code (log at `tickets/.logs/a-member-that-missed-a-commit.test.log`); quereus-plugin-optimystic 987 passing after a db-p2p rebuild (`tickets/.logs/a-member-that-missed-a-commit.plugin-test.log`); reference-peer 6 passing; `yarn lint:docs` clean; eslint clean on every changed file; `tsc --noEmit` clean. One caution for whoever re-runs: a db-p2p `yarn test` started while `yarn workspace @optimystic/db-p2p build` was rewriting `dist/` reported a single spurious failure; the same suite run alone afterwards was clean. Not chased — run the build and the suite one after the other.

# What a wedge looks like in the logs now

- A superseded record being stepped over: `cluster-member:validation-pending-superseded` (member, per occurrence, with `requestedRev`, `rival`, `claimedRev`) and `pend:superseded-claim` (storage-repo, at apply). Bounded: the record is swept at the next commit on the block, and `sweep-dead-claim` (block-storage) says when.
- A genuine same-slot reservation still refusing: `cluster-member:validation-pending-conflict` now carries `requestedRev` beside `rivals`; after 8 distinct refused writers, `cluster-member:stuck-reservation` once per episode on each member that holds the record, and `coordinator-repo:stuck-reservation` on the coordinator when its own storage corroborates. `coordinator-repo:pend-held-uncorroborated` still logs the un-corroborated arm per occurrence.

# Known gaps and honest notes for the reviewer

- **Pre-existing records have no claim.** Data pended before this change reads as an unknown claim and keeps today's behaviour: a stranded record from before the upgrade still wedges its block until a cancel or its commit. New records are covered from their first pend.
- **The vote still holds for a rival claiming a LATER slot than requested** (claim > request). That writer is stale against the cohort and will be rejected by an up-to-date member anyway; holding is the conservative choice and was not changed. If it ever shows up as a wedge it would be because every member is behind, which the same rule cannot fix.
- **`StorageRepo.get`'s `state.pendings` still lists superseded and dead records** until they are swept. The one consumer that classified on it, `CoordinatorRepo.corroborateHeldBlocks`, now reads claims through the same capability the member uses and applies the same slot rule, so a superseded record is not named as a rival in `StaleFailure.pending` nor fed to the stuck-reservation holder comparison. `state.pendings` itself is unchanged (it is the pending-overlay view `getStatus` reads for "is my own action still pending", where a dead own record reads as pending until swept — a stale answer for at most one commit on the block).
- **Metadata write per pend.** `savePendingTransaction` now always writes metadata (it previously wrote it only when seeding a fresh block). One extra small write per pended block; `deletePendingTransaction` reads metadata and writes it only when a claim was on file. Not measured; the pend hold is already local storage I/O only, and the existing NOTE in `StorageRepo.pend` about pend latency under contention is where to look if it ever shows.
- **The sweep on the commit path also deletes same-slot losers' records** before their writers' cancels arrive (the cancel then finds nothing, a tolerated no-op). Deliberate: such a record is provably unpromotable the moment the winner's `latest` lands. It does not touch a record whose slot the block has not reached.
- **The reproduction spec restarts A rather than waiting 12 s** to kill the writer's commit-retry schedule (the ticket's step 3). Same premise as `member-leaves-and-returns.spec.ts`'s long arm, and it keeps the spec at ~3 s. Its phase 2 tolerates either outcome of A's torn write (returned with `torn`, or thrown) and asserts on storage instead.
- **Not measured at more than three machines.** At larger cohorts the same rule applies; the sweep's "replica under a different action" arm is the one that matters there, and it is unit-tested but not mesh-tested.
- **`tickets/blocked/secondary-index-repro-exhausted-upstream.md` shows as modified in the working tree and is not mine** — it was already modified when this ticket started; left untouched.

# TODO for the reviewer

- [ ] Adversarial pass on `isReservationAgainst`: is there any shape in which a record claiming a revision BELOW the requested one is still a rival that must serialize? The argument for "no" rests on collection-scoped revisions plus the reader-side block floor; both are in `docs/repository.md` § "A pending record claims a slot".
- [ ] Check the tracker extraction left `coordinator-repo` byte-identical in behaviour: `stuck-reservation-named.spec.ts` passes unchanged and the tag/payload are the same fields.
- [ ] `corroborateHeldBlocks` now reads claims per block instead of one batched `get`: one storage call per block of the refused pend, on the refusal path only. Confirm that is acceptable, or batch it.
