description: When the machine that was making a change disappears before it finishes, the reservation it left behind blocks every later change to the same data for good. Give a reservation a time limit instead: once it has sat unfinished for far longer than any real change takes, it stops blocking other writers — while still being kept, so the original change can still land if it ever comes back.
architecture: docs/repository.md#a-pending-records-lifetime-is-bounded-by-its-writer
files:
  - packages/db-p2p/src/storage/pending-claim.ts (`PendingClaim`, `PendingClaimFields`, `isAbandonedClaim`, `isReservationAgainst` — the new `hasLapsed` sits beside them)
  - packages/db-p2p/src/storage/struct.ts (`BlockMetadata.pendingRevs`/`pendingBases`/`pendingRuns` — the fourth sibling joins them)
  - packages/db-p2p/src/storage/block-storage.ts (`claimOf`, `recordClaim`, `hasClaim`, `setEntry`, `savePendingTransaction`, `sweepDeadClaims`)
  - packages/db-p2p/src/storage/i-block-storage.ts (`savePendingTransaction`, `listPendingClaims`, `pendingClaimOf` contracts)
  - packages/db-p2p/src/storage/storage-repo.ts (`PROCESS_RUN_ID`, `StorageRepoOptions`, `StorageRepo.runId`, `IPendingClaimReader`, `pendUnderLatches` passes 1 and 2)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember.reservingRivals`, and `validateCommitBaseDeclarations`, which must NOT read the lease)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`pendingClaimsOf`, the stuck-reservation enrichment behind a `held` answer)
  - packages/db-p2p/src/repo/stuck-reservation.ts (`stuckReservationMessage` — "EXACTLY THREE THINGS CLEAR IT" is about to be wrong)
  - packages/db-p2p/src/testing/mesh-harness.ts (the `StorageRepo` every mesh node is built with)
  - packages/db-p2p/test/pending-claim.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/cluster-pend-held-vote.spec.ts
  - docs/repository.md, docs/correctness.md (Theorem 1 Case 2's commit-only bullet), packages/db-p2p/docs/storage.md, docs/internals.md, docs/debugging.md
difficulty: hard
----

# A pending record reserves its block only for a bounded time

## The residual this closes, stated exactly

A write happens in two steps: the node stores a **pending record** reserving the block ("I am about to commit this block at revision r"), and the write's commit later turns that record into a numbered revision. While the record stands, every other writer's pend for the block is refused. Removing it is the writer's job — its commit, or its cancel.

`an-interrupted-write-wedges-a-collection-for-good` closed the one shape where the node can *prove* the writer is gone: a record the node applied alone, for a writer in its own process, in an earlier run of that process (`isAbandonedClaim`). Everything else is still permanent. From that ticket's own handoff, and from the arms of `debt-unpromotable-pending-records-need-a-sweep`, the records left over are:

- a **coordinated** write's record — applied on every member by consensus, so it carries no in-process mark and never could;
- a **remote writer's** record pended through this node, whose process this node cannot see at all;
- a writer that exited with a cancel still owed on a cohort larger than one (`OwedCancels` lives in memory, so a restart forgets it);
- a record written by a build old enough that it carries no claim at all, which neither of today's rules can retire.

Two independent consumers have reported the consequence on ordinary sequential writes (GitHub #18 from VoteTorrent, and the `../sereus` control-write gate), and the fingerprint is always the same: `sync for collection … exhausted 10 retries: pending conflict: block(s) held by unresolved rival action(s) <id>`, forever, on a cohort that is otherwise healthy and still serving reads.

## The rule

**A pending record reserves its block for a bounded span measured from the moment this node stored it. Past that span the record has LAPSED: it no longer reserves the block against any other writer. It is not deleted, and its own commit is still honoured.**

That is the whole design, and the two halves of the sentence are both load-bearing.

**Why a time bound is legitimate here, after the arms ruled the cheap signals out.** The arms of the plan ticket eliminated every locally-decidable signal: the block-passed-the-slot test (`BlockStorage.sweepDeadClaims`) and the request-passed-the-slot test (`isReservationAgainst`) are both already in, and what is left by construction is a record whose slot the collection has *not* moved past — so no comparison of revisions can retire it. The remaining options the plan ticket named were a time bound or a cancel driven from somewhere that knows the transaction is gone. The second needs a writer-liveness protocol, a writer identity that survives the writer's own restart, and a reachable writer — which the reported deployments (phones behind circuit relays) cannot promise. So: a time bound.

**Why lapsing is safe where deleting is not.** The plan ticket's central fear is correct and unchanged: deleting a record whose write is still in flight makes that write's commit fail with a missing-pend error, which the cluster layer reads as this node having diverged and repairs by copying the whole block from a peer — more expensive than the leak. Lapsing never deletes, so a wrong guess costs the *reservation* and nothing else. The worst case of a lapse that fires too early is that another writer is admitted and one of the two writes is then refused as stale and retried — the ordinary lost-race path the client already handles. That asymmetry is what makes a merely generous bound good enough, where a deletion-based bound would have to be provably safe.

## What gets stored

A fourth sibling of the claim maps, written, dropped and swept in the same metadata write as the other three (`BlockStorage.recordClaim`), for the same reason they are siblings — the raw drivers move a pending record into the committed store byte-for-byte on promotion, so the record's value has to stay a plain transform:

```ts
// BlockMetadata, packages/db-p2p/src/storage/struct.ts
/**
 * When this node stored each pending record, by its own wall clock, keyed by the record's action
 * id … Absent only for a record written before this field existed, which is judged from the run's
 * start instead (see `hasLapsed`).
 */
pendingSince?: Record<ActionId, number>;
```

and on the claim:

```ts
// PendingClaim, packages/db-p2p/src/storage/pending-claim.ts
/** When this node stored the record (`BlockMetadata.pendingSince`); absent for a record written before the field existed. */
pendingSince?: number;
```

`pendingSince` is **required** in `PendingClaimFields`, unlike `rev`, `baseRev` and `localRun`. There is exactly one production caller of `IBlockStorage.savePendingTransaction` (`StorageRepo.pendUnderLatches`), so requiring it costs nothing and makes "a path forgot to stamp it" a compile error rather than a silent behaviour change. That matters because the fallback below is deliberately in the *lapsing* direction, which is the opposite of how `localRun`'s positive mark is read.

## The predicate

```ts
/** What a reader must know to judge whether a record has lapsed. */
export interface ReservationLease {
	/** How long a record reserves its block from the moment this node stored it. */
	leaseMs: number;
	/** When this run of the node started — the anchor for a record that carries no `pendingSince`. */
	runStartedAt: number;
	/** This node's wall-clock reading, in the same frame as `PendingClaim.pendingSince`. */
	now(): number;
}

export function hasLapsed(claim: PendingClaim, lease: ReservationLease | undefined): boolean;
```

Three branches, and no fourth:

- `lease === undefined` → nothing has lapsed. A reader that cannot say the time judges nothing, exactly as a claims reader with no `runId` judges nothing abandoned.
- `claim.pendingSince` present → lapsed iff `lease.now() - claim.pendingSince > lease.leaseMs`.
- `claim.pendingSince` absent → lapsed iff `lease.now() - lease.runStartedAt > lease.leaseMs`. A record written before the field existed gets exactly one lease of grace from the earliest moment this run could have known of it. This is the population the plan ticket's 2026-09-21 arm describes (a record with no `rev` either, which both existing rules treat as the strongest possible claim and neither can ever retire), and it is the one case where the fallback is in the lapsing direction on purpose: the alternative is the permanent wedge this ticket exists to remove.

Separate from `isAbandonedClaim` and `isReservationAgainst` on purpose, and asked in that order at both rival scans: abandonment is a fact about the **writer**, lapsing a fact about the **age**, the slot rule a fact about the **slot**. Each scan asks abandoned → lapsed → slot, and logs which one answered.

## Where the lease is read, and where it must not be

Read (a lapsed record is not a reservation):

- `StorageRepo.pendUnderLatches` pass 1, beside the `isAbandonedClaim` test — log `pend:lapsed-claim` with the rival's action id, its slot and its age. Unlike an abandoned record it is **not** added to the pass-2 delete list.
- `ClusterMember.reservingRivals` — log `cluster-member:validation-pending-lapsed`. The vote stays read-only.
- `CoordinatorRepo.pendingClaimsOf` — filtered, as abandoned claims already are, so the diagnostic enrichment behind a `held` answer and the stuck-reservation tracker never name a holder this node has stopped holding the block for.

Not read, and each for its own reason:

- **`ClusterMember.validateCommitBaseDeclarations` and the read-driven promotion in `StorageRepo.get`.** These apply or check a record, they do not ask whether it reserves. A lapsed record's own commit must still promote it normally — that is the half of the rule that keeps a lapse from costing the write.
- **`BlockStorage.savePendingTransaction`'s `PendRevisionTakenError` and `sweepDeadClaims`.** Both reason from slots; neither changes.
- **`StorageRepo.internalCommit`'s fork guard and the `Pending action … not found` path.** Untouched. No commit is refused for having lapsed.

The vote and the apply run on the same node against the same stored `pendingSince` and the same clock, and time only moves forward, so the apply can only ever be *more* permissive than the vote that preceded it. That keeps the existing invariant that the apply never refuses what the vote approved.

## The lease value

Two constants, in `storage-repo.ts` beside `PROCESS_RUN_ID`:

- `DEFAULT_PEND_LEASE_MS = 300_000` — the repo's default when nothing is configured.
- `StorageRepoOptions.pendLeaseMs` — the override; `0` disables lapsing entirely (`ReservationLease` is then `undefined` and the rule reduces to today's behaviour).

The node derives its value from the deadlines it already derives from the declared link round trip (`resolveLinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`), so a slow-link deployment gets a proportionally longer lease: `max(DEFAULT_PEND_LEASE_MS, PEND_LEASE_BUDGETS × linkDeadlines.transactionTimeoutMs)` with `PEND_LEASE_BUDGETS = 10`. At the default `transactionTimeoutMs` (30 s) the two agree exactly, which is why the floor is 300_000 rather than some other round number.

What the number has to clear, and where the figures come from: one honest pend-to-commit span on one member. The writer's pend and its commit each carry their own budget of one `transactionTimeoutMs` (`NetworkTransactor` sets `expiration = Date.now() + this.timeoutMs` separately for each phase), and a sync cycle that exhausts its retry budget takes roughly 21 s in total (ten attempts of backoff, `Collection.syncAttempts`) while discharging its own pend on every failed attempt. Nothing in the repository holds a pend open across a longer span: the offline queue re-sends a recorded *attempt*, which re-pends rather than committing an old record (`resumedAttempt` in `packages/db-core/src/collection/write-attempts.ts`). Ten budgets is an order of magnitude over that and still turns "forever" into "five minutes".

**Measure it rather than leaving the figure asserted.** While building the mesh spec below, log the observed pend-to-commit span for a healthy write on the in-process mesh and record the figure in `DEFAULT_PEND_LEASE_MS`'s doc comment, in the register `STUCK_RESERVATION_DISTINCT_ACTIONS` uses — measured honest span, the multiple the default is above it, and what raising or lowering the default costs. No claim about magnitudes in the comment that the comment does not say how it was obtained.

## Why no consensus round, and why members may disagree for a moment

The plan ticket asks whether members must agree before a record stops counting. They need not, for three reasons:

- Nothing is destroyed, so no member removes state another member is relying on.
- The verdict is monotone in local time and permanent once reached, and every member anchors it to its own receipt of the same record — so members reach it within the pend's own propagation spread of each other (milliseconds), not within clock skew. Nothing compares one node's clock against another's; `pendingSince` is only ever read by the node that wrote it.
- While they do disagree, the cost is bounded and already-handled: a member that has not yet lapsed the record votes `held`, which a cohort of four or more absorbs (`cohortCanMissAPend`) and which a cohort of two or three resolves on the writer's next retry, a few hundred milliseconds later.

A node whose wall clock steps backwards delays every lapse (safe); one that steps forwards lapses early, which costs a lost race. Worth a sentence in the doc comment, not a mechanism.

## Safety: no lost update

`docs/correctness.md` Theorem 1 Case 2 currently leans on "a rival pend is refused by storage while the record reserves the slot (or as stale once it is committed)". The lease shortens *how long* the record reserves, so that clause needs the argument spelled out beside it. Take a lapsed record for action R, and a newcomer N admitted over it at the same slot r:

- R never commits → nothing is lost.
- R commits before N → the block is past r, and N's commit is refused as stale on every member that applied R; N rebases. The ordinary lost race.
- N commits before R → R's commit is refused as stale, and `sweepDeadClaims` drops R's record when `latest` passes r. R's writer learns it lost, exactly as any rival does.
- The two commits are concurrent → they are two cluster transactions over the same blocks, ordered by race resolution and by each member's stale and fork checks under the block latch; one wins.
- R committed on a majority and *this* member missed that commit, while N declares this member's (behind) latest as its base → this member applies N at r and forks locally. It is refused everywhere R landed, so N's commit cannot reach the strict-majority durability bar (`CoordinatorRepo.commit`) and this member is reconciled. This is the pre-existing missed-commit residual the revision rule already carries — the base arm narrowed it for cohorts of four and up — and the lease does not widen it: a record whose action committed elsewhere is promoted here by the read-driven promotion or by `internalCommit`'s base fallback long before a lease elapses.

So the lease costs a retry in the worst case and never a lost change. That is the paragraph to add to Theorem 1 Case 2, and the reason the base arm's own safety argument (`isReservationAgainst`'s doc comment, and its `NOTE:`) survives unchanged — that `NOTE:` names this ticket as the cure for the population it holds for, and should now name the lease as what arrived.

## What this deliberately does not do

- **It does not delete a lapsed record.** A block that is never written again keeps the record's bytes until something else resolves the slot. That is the accepted cost of never destroying state on a presumption; record it as a `NOTE:` at the lapse site rather than as a ticket.
- **It does not bound a writer that keeps re-pending.** A re-pend of the same action overwrites the claim and so restarts its lease, which is correct (the writer is demonstrably alive) but means a hostile or looping writer can hold a block indefinitely. That is true today without the lease and belongs to the dispute subsystem; say so in the lease's doc comment, file nothing.
- **It does not add a background sweep or a renewal protocol.** The judgement rides on the next pend of the block, which is the moment the harm would otherwise be done and which already reads the block's claims under the latch. Raw storage cannot enumerate the blocks that hold pending records anyway.

## Edge cases & interactions

- **A re-pend of the same action** overwrites `pendingSince` along with the rest of the claim (`recordClaim` writes all four together), so a live writer's record cannot lapse under it. Verified by inspection of the single save path; no test.
- **An abandoned record that has also lapsed.** Abandonment is asked first, so it is deleted, not merely lapsed. Covered by the ordering assertion in the repo-tier test below.
- **A claim-less record** (no `rev`, no `pendingSince`) now lapses one lease after the run started, where before it reserved for ever. This is the only behaviour change for metadata written by an older build, and it is the point of the fallback branch.
- **A node that restarts more often than its lease** re-anchors the unstamped-record grace on every run, so such a record never lapses there. A one-time upgrade population on a node that never stays up for five minutes; `NOTE:` at the fallback, no mechanism.
- **`runStartedAt` and an injected clock must share a frame.** Capture it as `this.runStartedAt = this.now()` in the `StorageRepo` constructor, not as a module-level `Date.now()` beside `PROCESS_RUN_ID`, or a test with a fake clock compares two different frames. A second repo built later in the same process anchors later, which can only lengthen the grace — the safe direction. Say both in the field's doc comment.
- **`StorageRepoOptions.now`** (`() => number`, default `Date.now`) is the one reading the lease uses, mirroring `HlcClockOptions.localClock`. Deliberately NOT `options.clock?.localTime()`: tying the lease to the HLC clock would switch `PendHlcIntake` on in every harness that wants a fake clock, changing behaviour unrelated to this ticket. In production both are `Date.now`.
- **`hasClaim`** must gain the fourth map, or `deletePendingTransaction` skips the metadata write for a record whose only entry is its receipt.
- **`sweepDeadClaims`** iterates `pendingRevs`; a record with a `pendingSince` and no `rev` therefore leaves an entry behind when swept. That is the already-recorded tripwire on `BlockMetadata.pendingBases` ("the sibling maps are not always co-keyed with `pendingRevs`") — widen its wording to the fourth map rather than adding a second note.
- **The stuck-reservation diagnostic.** `stuckReservationMessage` says "EXACTLY THREE THINGS CLEAR IT" and that "there is no sweep for a remote writer's record, or for a record of a write a larger cohort decided". Both sentences are now false. Reword: the reservation also clears when it lapses, so a wedge is bounded; the line still means something, because it fires while a lease is running and because a cohort can be wedged by a *live* holder. Keep it a diagnosis — it still refuses, expires and deletes nothing.
- **`docs/debugging.md`** has a mirror test (`packages/db-p2p/test/logger.spec.ts`) that fails on an emitted sub-namespace channel with no documented row, so the two new log channels must land with their rows.

## Tests

Six cases, no more. The lapse rule has exactly three branches and two seams that must read it, plus one end-to-end reproduction of the population this ticket owns.

In `packages/db-p2p/test/pending-claim.spec.ts`, beside the existing table-driven `isReservationAgainst` cases — the pure rule, one case per branch:

- a stamped claim inside its lease has not lapsed; at the boundary and past it, it has (the comparison is strictly greater, so a record stored exactly `leaseMs` ago still reserves);
- an unstamped claim is judged from `runStartedAt` on the same terms;
- a `ReservationLease` of `undefined` lapses nothing, whatever the claim says.

In `packages/db-p2p/test/storage-repo.spec.ts`, beside the two existing run-crossing cases — the repo tier, with an injected `now` and a `pendLeaseMs` of a few hundred ms:

- a record with **no** `localRun` (the shape a coordinated write and a remote writer both leave) reserves the block against another action's pend while its lease runs — the pend is refused `conflict: true` with the rival named — and stops reserving once the clock is moved past it, so the same pend then succeeds **and the rival's record is still on file afterwards**. That last assertion is the half of the rule that no other test pins.

In `packages/db-p2p/test/cluster-pend-held-vote.spec.ts`, beside the existing abandoned-claim vote cases:

- a lapsed claim produces no `held` vote, where the same claim inside its lease does.

New, `packages/db-p2p/test/a-lapsed-pend-stops-reserving-its-block.spec.ts` — the reproduction of this ticket's own class, at the only tier that can produce it. Model it on `packages/db-p2p/test/failed-cancel-does-not-strand-the-writers-pend.spec.ts` and `an-interrupted-write-does-not-wedge-the-collection.spec.ts`:

- a three-member cohort stores a *coordinated* pend whose writer then goes away without committing or cancelling (no in-process mark anywhere, so `isAbandonedClaim` cannot help); a later write from a healthy member is refused with the `pending conflict` fingerprint the field reports name; the harness's clock is advanced past the lease; the same write now succeeds. Drive the clock, never `setTimeout` — the harness must thread `pendLeaseMs` and `now` into the `StorageRepo` it builds (`mesh-harness.ts`), and no spec that does not ask for them may change behaviour.

Nothing else. In particular no test for the metadata plumbing (`recordClaim`'s fourth map is covered by extending the existing `block-storage.spec.ts` join assertions rather than by a new case), none for the node's lease derivation (one `max` over a value `resolveLinkDeadlines` already tests), and none for the reworded diagnostic.

## TODO

- Add `BlockMetadata.pendingSince` and `PendingClaim.pendingSince`; make `pendingSince` required in `PendingClaimFields`; extend `claimOf`, `recordClaim`, `hasClaim` and `setEntry` to the fourth map, and widen the co-keying `NOTE:` on `pendingBases`.
- Add `ReservationLease` and `hasLapsed` to `pending-claim.ts`, documented in the register of the file's neighbours: what it decides, why it never deletes, why it is separate from the other two rules, what a clock step costs, and what it does not bound.
- Add `DEFAULT_PEND_LEASE_MS`, `PEND_LEASE_BUDGETS`, `StorageRepoOptions.pendLeaseMs`, `StorageRepoOptions.now`, `StorageRepo.runStartedAt` and the `ReservationLease` the repo hands out through `IPendingClaimReader`.
- Stamp `pendingSince` in `pendUnderLatches` pass 2, and read the lease in pass 1 (log `pend:lapsed-claim`), in `ClusterMember.reservingRivals` (log `cluster-member:validation-pending-lapsed`) and in `CoordinatorRepo.pendingClaimsOf`. Leave the commit-side readers alone.
- Derive the node's lease in `libp2p-node-base.ts` from `linkDeadlines.transactionTimeoutMs`; thread `pendLeaseMs` and `now` through `mesh-harness.ts`.
- Reword `stuckReservationMessage`, and `isReservationAgainst`'s `NOTE:` naming this ticket as the missing cure.
- Write the six tests above, measure the healthy pend-to-commit span on the mesh, and record the figure in `DEFAULT_PEND_LEASE_MS`'s comment.
- Docs: rewrite `docs/repository.md` §"A pending record's lifetime is bounded by its writer" (the five-removers list is unchanged — the lease removes nothing — but the reservation's span and the residual it leaves are not what that section now says); add the no-lost-update paragraph to `docs/correctness.md` Theorem 1 Case 2; update `packages/db-p2p/docs/storage.md`, `docs/internals.md`, and the two new channels in `docs/debugging.md`.
- Record as `NOTE:`s at their sites, not as tickets: the undeleted bytes on a block never written again; the re-pending writer the lease does not bound; the restart-faster-than-the-lease case; the unstamped-record fallback's deliberate lapsing direction.
- Validate: root `yarn build`, `yarn lint`, `yarn lint:docs`, then the db-p2p suite and the quereus-plugin-optimystic suite (the plugin's `local` transactor writes through `StorageRepo`, and its two concurrent-refusal specs are what caught the last change to this area).
