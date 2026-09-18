description: A machine that promised a write and then missed its commit kept a leftover "write in progress" marker and vetoed every later write to that data until it happened to read the data itself. Fixed by recording which revision each marker claims, so a marker for a revision the group has already moved past no longer counts as a live rival; a three-machine spec that failed on the old code after about 17 seconds now passes in about a second.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/storage/pending-claim.ts (new: `PendingClaim`, `isReservationAgainst` — the one rule; now carries the review's NOTE on the one uncovered shape)
  - packages/db-p2p/src/storage/struct.ts (`BlockMetadata.pendingRevs`)
  - packages/db-p2p/src/storage/block-storage.ts (`savePendingTransaction` records the claim; `deletePendingTransaction` drops it; `listPendingClaims`; `sweepDeadClaims` from `setLatest`, `recover`, `saveForwardRevision`)
  - packages/db-p2p/src/storage/i-block-storage.ts (`listPendingClaims` contract)
  - packages/db-p2p/src/storage/storage-repo.ts (`pend`'s apply-time rival scan; `IPendingClaimReader` capability)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations`' rival branch; `reservingRivals`; `nameStuckReservation`)
  - packages/db-p2p/src/repo/stuck-reservation.ts (new: `StuckReservationTracker`, extracted from the coordinator so members can count too)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`noteStuckReservation` and `clearStuckReservations` delegate to the tracker; `corroborateHeldBlocks` reads claims)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (export the new module from both entries)
  - packages/db-p2p/test/member-missed-commit-heals-at-commit.spec.ts (the six-step reproduction; renamed in review from `…-heals-at-vote`)
  - packages/db-p2p/test/pending-claim.spec.ts (new in review: the rule as a table)
  - packages/db-p2p/test/cluster-pend-held-vote.spec.ts, block-storage.spec.ts, storage-repo.spec.ts (new sections)
  - docs/correctness.md, docs/internals.md, docs/repository.md (Theorem 9's `held` paragraph; the held bullet; the Invariant P sub-section on claims and the dead-claim sweep)
  - tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md (arm: what this change settles)
  - tickets/backlog/bug-a-pended-transform-does-not-carry-its-base.md (arm from review: the pend-time rival check is a fourth site that needs the base)
difficulty: hard
----

# What was wrong, in one paragraph

A pending record is the durable marker a member stores when it promises a write and removes when the write commits or is cancelled. Both places that check for rival writers — the member's promise vote (`validatePendOperations`) and storage's own apply-time scan (`StorageRepo.pend`) — treated any rival record as a live reservation. A member that promised a write and missed its commit therefore held a record nobody would ever remove (the writer believed the write succeeded, and it had, by majority), and voted `held` against every later pend of the block. At three machines the promise bar is all three, so one such vote refused every write to the block from every machine, until the stuck member happened to read the block itself, which nothing schedules.

# What changed

**A pending record now claims a slot.** Storage keeps the revision each record was pended at, in the block's metadata beside `latest` (`BlockMetadata.pendingRevs`), written in the same metadata write that seeds a fresh block and dropped with the record. It is in the metadata rather than in the record because the raw drivers promote a record by moving its bytes into the committed store unchanged, so the record's value has to stay a plain transform. `IBlockStorage.listPendingClaims` joins the two back together.

**One rule at both rival checks.** `isReservationAgainst(claim, requestedRev)`: a record claiming the requested revision or a later one reserves the block; a record claiming an earlier revision has been superseded by the collection moving on and does not. A record with no recorded revision (pre-existing data, or a rev-less pend) reserves, so old data can only refuse more than it should, never less.

**The member comes current through the pend's own commit, not through a reconcile in the vote.** No network I/O was added to the promise vote. When the admitted pend commits, `internalCommit`'s fork guard refuses the base mismatch on the behind member, which triggers the existing behind-reconcile; the block lands at the new revision, and the superseded record is then provably dead.

**Dead records are swept where they become provable.** A record claiming a revision the block has reached can never be promoted. `BlockStorage.sweepDeadClaims` deletes such records and their claims from `setLatest`, `recover` and `saveForwardRevision`, under the block's write latch. A record with no recorded revision is never swept.

**A wedge that remains is named by the member that holds it.** The coordinator's stuck-reservation counting was extracted into `StuckReservationTracker`; each member now keeps its own, fed by its own `held` votes, logging `cluster-member:stuck-reservation` once per episode.

# The decision, and what was rejected

The ticket proposed healing at the vote by reconciling from the cohort, or a new "behind" vote kind. Neither was built: the fault produces two wedges (the missed tail commit on the returning member, and the torn write's non-tail block whose record stands on every member that did not clear it by a read), a cohort reconcile cannot cure the second, and the slot rule cures both while keeping the vote local. Recorded at the site in `validatePendOperations`' doc comment and branch comment.

# How to validate

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/pending-claim.spec.ts" "test/member-missed-commit-heals-at-commit.spec.ts" "test/cluster-pend-held-vote.spec.ts" "test/stuck-reservation-named.spec.ts" "test/torn-commit-cancels-abandoned-blocks.spec.ts" "test/block-storage.spec.ts" "test/storage-repo.spec.ts" --reporter spec
```

Review-time results: that set 220 passing; full db-p2p `yarn test` 3017 passing, 63 pending, 0 failing; eslint clean on every changed file; `tsc --noEmit` clean; `yarn lint:docs` clean (46 documents, all citations resolve).

## Review findings

**Read first:** the implement commit's full diff (storage, cluster, coordinator, tracker, tests, docs), then the handoff. Then the code the fix's safety argument rests on and which the diff did not touch: the promise vote's stale-revision branch, `StorageRepo.pend`'s stale check, `StorageRepo.get`'s read-driven promotion from `context.committed`, `Log.getFrom`'s construction of that context, `Collection.probeHeader`/`bootstrapContext` (fresh handles), `BlockFloors` and `NetworkTransactor.get`'s below-floor re-ask, `internalCommit`'s fork guard, and the coordinator's `get` (it forwards the read context, so promotion runs on the answering member).

**Ticket's first TODO — is a record claiming a revision below the requested one ever still a rival that must serialize?** Yes, in one shape, and it is the one finding of consequence. The handoff and docs justified admitting the pend by the block-floor mechanism. That is not the load-bearing mechanism: floors are advisory, one extra round, and absent on a freshly opened handle (opening walks no entries). What actually makes "the incoming writer built on that commit" true is that every handle's read context lists every action the log has committed since the last checkpoint (none is written today), and `StorageRepo.get` promotes a held record for any listed action before serving, on every member that holds the record. That covers every member holding the superseded record, at any cohort size. It does not cover a member that never received the rival's pend: from four members up the promise bar is a super-majority (0.75, so 3 of 4), so one member can miss the pend, hold no record to promote, and serve the block one change short while the rival's non-tail commit is still in flight. A floor-less handle accepts that answer, pends past the rival's slot, the record-holding members now approve where they used to hold, their commit's fork guard passes (their content matches the declared base), the transform applies over the stale base and the sweep deletes the rival's record. The rival's change to that block is lost while the log names it. Three-member cohorts are not exposed. Inferred from code, not reproduced. Disposition: this is the class backlog `bug-a-pended-transform-does-not-carry-its-base` already owns (the pend does not carry the per-block base; with it, "superseded" becomes "the incoming base is at or past the claim", which closes the hole where the facts are). Appended as a fourth arm there, with what would confirm it; not a new ticket. Recorded at the site as a `NOTE:` on `isReservationAgainst` naming the exact condition (four or more members per cohort), and the doc prose in `docs/repository.md`, `docs/correctness.md` and the vote branch comment in `cluster-repo.ts` now cite the promotion as the reason and name the uncovered shape, instead of citing floors.

**Ticket's second TODO — tracker extraction behaviour-preserving?** Yes. `stuck-reservation-named.spec.ts` passes unchanged; the coordinator's log tag and payload fields (`blockId`, `holdingActionIds`, `distinctRefusedActions`, `message`) are the same, now produced by `StuckReservationTracker.note` and spread into the log call. The moved code is line-for-line the old loop.

**Ticket's third TODO — one storage call per block in `corroborateHeldBlocks`.** Accepted as is: it runs only on the refusal path of a held pend, over the blocks of one pend, and each call is a metadata read plus a pending-namespace listing on local storage. Not worth a batching interface for that.

**Sweep soundness.** `savePendingTransaction` only accepts a record with `rev > latest.rev` under the latch, and `latest` only advances, so a claim at or below `latest` is unpromotable by the storage invariant itself; the sweep deletes only those. The commit path's own record is promoted before `setLatest`, so the sweep's delete of its claim entry is a delete of an absent record, which the raw drivers already tolerate (the same-action delete at `saveForwardRevision` relied on that before this change). Crash ordering in `savePendingTransaction` (claim before record) leaves an inert entry, which `listPendingClaims` hides by joining against the namespace and the sweep clears when `latest` passes it. No finding.

**Rule table not pinned directly.** Minor: the rule was covered only through its callers. Added `test/pending-claim.spec.ts` with the six-case table and a monotonicity check, so a change to the rule is a visible decision.

**Spec narrated the rejected design.** Minor: the reproduction spec's header (step 4), its describe title, its phase-4 title, its summary line and its filename all said the member heals "at its vote" by reconciling from the cohort, which is the design the ticket rejected; the implementation heals at the pend's commit through the fork guard. Rewrote the prose and renamed the file to `member-missed-commit-heals-at-commit.spec.ts` (tree id updated to match).

**Source hygiene.** New comments say why, not what; `sweepDeadClaims` and `recordClaim` are named subroutines rather than narrated runs. `cluster-repo.ts` and `coordinator-repo.ts` remain very large files, which predates this ticket and is not filed here. The capability duck-typing (`typeof reader.listPendingClaims === 'function'`) appears in both the member and the coordinator; it mirrors the existing `IRevisionActionReader` convention, so left alone.

**Docs.** Every touched doc read in full at the changed sections. `docs/repository.md`'s "only four things ever remove a pending record" now lists the sweep and is accurate. Two older comments still say "there is no sweep for abandoned pending records" (`stuckReservationMessage`, `NetworkTransactor.cancelAbandonedSweepBlocks`); both remain true for the population they describe (a record whose slot the block has not reached), so left as is. The header comment of `torn-commit-cancels-abandoned-blocks.spec.ts` lists three removers; a test narration, harmless, left.

**Pre-existing test failures:** none. The full db-p2p suite was green in one run after the build.

**Tripwires parked:** one, the `NOTE:` at `isReservationAgainst` described above. Its condition is "a deployment runs four or more members per cohort", and it names the backlog ticket that closes it.

**Not done:** no four-member mesh reproduction of the uncovered shape was written; the arm on the backlog ticket says exactly what such a spec would do.
