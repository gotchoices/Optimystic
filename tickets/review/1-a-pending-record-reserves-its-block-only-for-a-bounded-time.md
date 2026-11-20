description: A reservation left behind by a machine that disappeared mid-change now stops blocking other writers once it has sat unfinished far longer than any real change takes — while still being kept, so the original change can land if it ever comes back. Built; needs a review pass.
architecture: docs/repository.md#a-pending-records-lifetime-is-bounded-by-its-writer
files:
  - packages/db-p2p/src/storage/pending-claim.ts (`ReservationLease`, `hasLapsed`, `PendingClaim.pendingSince`, `PendingClaimFields`, the reworded `isReservationAgainst` NOTE)
  - packages/db-p2p/src/storage/struct.ts (`BlockMetadata.pendingSince`, the widened co-keying NOTE on `pendingBases`)
  - packages/db-p2p/src/storage/block-storage.ts (`claimOf`, `recordClaim`, `hasClaim`, `setEntry`, `savePendingTransaction`)
  - packages/db-p2p/src/storage/i-block-storage.ts (contract docs only)
  - packages/db-p2p/src/storage/storage-repo.ts (`DEFAULT_PEND_LEASE_MS`, `PEND_LEASE_BUDGETS`, `resolvePendLeaseMs`, `StorageRepoOptions.pendLeaseMs`/`now`, `StorageRepo.runStartedAt`/`pendLease`, `IPendingClaimReader.pendLease`, `pendUnderLatches` passes 1 and 2)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember.reservingRivals`; `validateCommitBaseDeclarations` doc only)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`pendingClaimsOf`, `livePendingClaims`)
  - packages/db-p2p/src/repo/stuck-reservation.ts (`stuckReservationMessage`, two doc comments)
  - packages/db-p2p/src/libp2p-node-base.ts (`prepareServingStore` takes `linkDeadlines` and derives the lease)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshConfig.pendLeaseMs`, `MeshConfig.now`)
  - packages/db-p2p/test/a-lapsed-pend-stops-reserving-its-block.spec.ts (new), pending-claim.spec.ts, storage-repo.spec.ts, cluster-pend-held-vote.spec.ts, block-storage.spec.ts, block-lineage.spec.ts, cluster-commit-digest.spec.ts
  - docs/repository.md, docs/correctness.md, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/storage.md
difficulty: hard
----

# A pending record reserves its block only for a bounded time

## What landed

**The rule.** A pending record reserves its block for a bounded span measured from the moment *this node* stored it. Past that span the record has **lapsed**: it no longer reserves the block against any other writer. It is **not deleted**, and its own commit is still honoured. The rule is `hasLapsed` in `packages/db-p2p/src/storage/pending-claim.ts`, and it has exactly three branches — no lease given (nothing lapses), a stamped record (judged from its own `pendingSince`, strictly greater than the lease), an unstamped record (judged from the reading run's start, the one place the fallback is deliberately in the *lapsing* direction).

**What is stored.** `BlockMetadata.pendingSince`, a fourth sibling of `pendingRevs` / `pendingBases` / `pendingRuns`, written, dropped and swept in the same metadata write (`BlockStorage.recordClaim` — verified at 2 metadata writes for 2 records in `block-storage.spec.ts`). Read back as `PendingClaim.pendingSince`. It is the one **required** field of `PendingClaimFields`, so a save path that forgets to stamp it is a compile error rather than a record that silently lapses a lease after the run started.

**Where the lease is read.** `StorageRepo.pendUnderLatches` pass 1 (logs `pend:lapsed-claim`; a lapsed record is **not** added to the pass-2 delete list), `ClusterMember.reservingRivals` at the promise vote (logs `cluster-member:validation-pending-lapsed`), and `CoordinatorRepo.livePendingClaims` so the diagnostic enrichment behind a `held` answer never names a holder this node has stopped holding for. Both rival scans ask **abandoned → lapsed → slot**, in that order.

**Where it is deliberately not read.** `ClusterMember.validateCommitBaseDeclarations`, the read-driven promotion in `StorageRepo.get`, `StorageRepo.internalCommit`'s fork guard, `BlockStorage.savePendingTransaction`'s `PendRevisionTakenError`, and `sweepDeadClaims`. No commit is refused for having lapsed.

**The value.** `DEFAULT_PEND_LEASE_MS = 300_000`, `PEND_LEASE_BUDGETS = 10`, and `resolvePendLeaseMs(transactionTimeoutMs) = max(default, 10 × transactionTimeoutMs)`, which `libp2p-node-base.ts` calls with `linkDeadlines.transactionTimeoutMs` (a new `linkDeadlines` parameter on `prepareServingStore`). `StorageRepoOptions.pendLeaseMs` overrides; `0` disables lapsing entirely and reduces the behaviour to what shipped before. `StorageRepoOptions.now` (`() => number`, default `Date.now`) is the clock; `StorageRepo.runStartedAt` is captured as `this.now()` in the constructor so an injected clock and the anchor share a frame.

**Measured, as the ticket asked.** The new mesh spec logs `healthy pend-to-commit span: 41ms (in-process mesh, 3 machines)` — writer-side, pend-out to commit-back, which bounds how long any one member holds the record. That figure and the method are recorded in `DEFAULT_PEND_LEASE_MS`'s doc comment, alongside the magnitude that actually sizes the default: the longest span the code can hold **one** record open for is a pend budget plus a commit budget (60 s at the default `transactionTimeoutMs`), since a failed attempt discharges its own pend, so the default is five times that worst case and about an order of magnitude over a whole exhausted 21 s sync cycle.

## Use cases to test, validate and exercise

**The class this closes, end to end.** `packages/db-p2p/test/a-lapsed-pend-stops-reserving-its-block.spec.ts`, three machines: a *coordinated* pend lands on all three members (asserted: no member stamped a `localRun`, every member recorded a `pendingSince`), the writer then never commits or cancels; a write from a different member is refused with the field fingerprint `pending conflict: block(s) held by unresolved rival action(s) <id>`; the mesh clock is advanced one millisecond past the lease; the same write lands, and all three members still hold the stranded record. Drive the clock — never `setTimeout`.

**The half no other test pins.** That the record is **kept**. `storage-repo.spec.ts` → "stops reserving past its lease, and is KEPT" asserts both the raw record and its claim survive the admitted newcomer's pend. If a future change makes a lapse delete, that test and the mesh spec's final assertion are the ones that catch it.

**Members disagreeing for a moment.** Not covered by a test, by design (see *Known gaps*). The argument is in `hasLapsed`'s doc comment and in docs/repository.md: nothing is destroyed, each member anchors to its own receipt of the same record, and a member that has not yet lapsed votes `held`, which four-or-more absorbs and two-or-three resolves on the next retry.

**Backward compatibility to exercise by hand if you want it.** Metadata written by the previous release carries no `pendingSince` (and often no `rev`), and now lapses one lease after the reading run started. `block-storage.spec.ts` → "metadata written before the field existed reads as base-unknown" covers the read side; the lapse side is `pending-claim.spec.ts` → "an unstamped record … is judged from the run's start". A node that restarts more often than its lease re-anchors that grace every run and so never lapses such a record — recorded as a `NOTE:`, no mechanism.

**Configuration surfaces.** `pendLeaseMs: 0` must restore pre-lease behaviour exactly (`pendLease` becomes `undefined`, and `hasLapsed` returns false for every claim — `pending-claim.spec.ts` → "lapses nothing without a lease"). A reader that cannot supply a lease (`Partial<IPendingClaimReader>` without `pendLease`) degrades to holding, never to admitting — the `ClaimRepo` mock in `cluster-pend-held-vote.spec.ts` defaults to no lease precisely so every pre-existing case there still exercises the old behaviour.

## Tests added, and what each verifies

| Test | What it pins |
| --- | --- |
| `pending-claim.spec.ts` → `hasLapsed` suite (6 cases) | The pure rule's three branches: a stamped record inside / at / past its lease (at the boundary it still reserves — strictly greater); a stamped record against a clock behind the stamp; an unstamped record judged from `runStartedAt` on the same terms, whatever slot it claims; `undefined` lease lapses nothing. |
| `storage-repo.spec.ts` → "a record that has stood past its lease stops reserving its block" (2 cases) | The repo tier, with an injected clock and a 300 ms lease, on a record with **no** `localRun` — the shape a coordinated write and a remote writer both leave. Inside the lease the pend is refused `conflict: true` naming the rival; past it the same pend succeeds **and the rival's record and claim are both still on file**. |
| `cluster-pend-held-vote.spec.ts` → 2 cases beside the abandoned-claim ones | The promise vote: a lapsed claim produces `approve`; the same claim inside its lease produces `held` with `heldBy`. |
| `a-lapsed-pend-stops-reserving-its-block.spec.ts` (4 phases, new) | The reproduction of this ticket's own class at the only tier that can produce it, plus the measurement recorded in `DEFAULT_PEND_LEASE_MS`. |
| `block-storage.spec.ts` → extended join assertions (no new case) | The fourth metadata map: stamped for every record slot-or-not, keyed per record (distinct stamps asserted), joined on both claim readers, dropped with the record, replaced by a redelivery (which is what restarts a lease), and dropped by promotion and by the sweep. |

Deliberately **no** test for: the node's lease derivation (one `max` over a value `resolveLinkDeadlines` already tests), the reworded `stuckReservationMessage`, or the new log channels beyond their `docs/debugging.md` rows.

## Tripwires parked, not filed

Each is a `NOTE:` at its site; none is a ticket.

- **The undeleted bytes.** In `hasLapsed`'s body: a block never written again keeps a lapsed record's bytes until something else resolves the slot. The accepted cost of never destroying state on a presumption; the cure, if it ever shows up as a storage cost, is a sweep that can enumerate the blocks holding records, which raw storage cannot do.
- **The unstamped-record fallback's lapsing direction.** In `hasLapsed`'s body: the opposite direction from `localRun`'s positive mark, on purpose, because the alternative keeps the permanent wedge.
- **A node that restarts more often than its lease.** In `hasLapsed`'s body: re-anchors the unstamped grace every run, so a pre-field record never lapses there. One-time upgrade population.
- **A writer that keeps re-pending.** At the stamp site in `StorageRepo.pendUnderLatches` pass 2: a re-pend overwrites the claim and restarts the lease, so a hostile or looping writer can hold a block indefinitely. True before the lease too; belongs to the dispute subsystem.

## Known gaps and judgement calls — review these first

- **`pendingSince` is required in `PendingClaimFields`, and that cost ~60 test call sites.** The ticket asked for it and the reasoning holds (a forgotten stamp would silently lapse live records), but the churn is real: every `savePendingTransaction` call in `block-storage.spec.ts`, `storage-repo.spec.ts` and `block-lineage.spec.ts` now passes a stamp. `block-storage.spec.ts` uses a fixed `STORED_AT` constant so its claim joins can be asserted exactly; the repo-tier setups use `Date.now()` so a real-clock repo does not read them as lapsed. Worth a look at whether the assertion edits changed any test's meaning — in two places I weakened a `deep.equal` on a whole claim to an `include` / field read rather than thread a stamp through (`storage-repo.spec.ts`, the two run-crossing cases and the base-independent-pend case).
- **No test covers member disagreement during a lapse, or the ordering abandoned-before-lapsed at the vote tier.** The ordering *is* covered at the repo tier only implicitly (the abandoned-claim cases still pass, and the branch order is textual). A reviewer who thinks the ordering deserves pinning has a cheap case available: a claim carrying both an earlier `localRun` and an elapsed stamp must be **deleted**, not merely set aside.
- **The 41 ms measurement is in-process.** It is an honest number for what it is and the comment says so, but it is not a figure from a relayed deployment; the default is sized by the budget arithmetic, not by that measurement. If a reviewer wants the claim narrowed further, the sentence to edit is in `DEFAULT_PEND_LEASE_MS`.
- **`IPendingClaimReader.pendLease` is a required member.** Two test mocks grew a field (`ClaimRepo`, `ClaimOfRepo`). Nothing in `src/` forwards `runId` or `pendLease` through a decorator, so the new member cannot be silently dropped by a wrapper any more than `runId` already could — but that is an argument from absence, worth re-checking.
- **The stuck-reservation message now says FOUR things clear it** and that a recurrence past one lease means a live holder. No test asserts the prose (there never was one); `stuck-reservation-named.spec.ts` asserts the structured fields and still passes.
- **`docs/correctness.md` Theorem 1 Case 2** gained a top-level paragraph plus a five-case analysis, placed after the three `operationsConflict` narrowings rather than nested inside the commit-only bullet it qualifies. Check that the fifth case (the missed-commit member) reads as the pre-existing residual it is, and not as something the lease introduced.

## Validation run

Per `tickets/rules/testing.md` — the changed package built, changed and covering specs run by file, no full suites.

```
packages/db-p2p: yarn build                                   # clean
root:            yarn lint                                    # clean
root:            yarn lint:docs                                # 49 documents, 846 citations, 817 links — all resolve
root:            yarn lint:deps                                # 1283 files / 13 packages — every import declared
packages/db-p2p: mocha test/pending-claim.spec.ts test/storage-repo.spec.ts \
                       test/cluster-pend-held-vote.spec.ts test/block-storage.spec.ts \
                       test/a-lapsed-pend-stops-reserving-its-block.spec.ts        # 301 passing
packages/db-p2p: mocha test/block-lineage.spec.ts test/cluster-commit-digest.spec.ts \
                       test/stuck-reservation-named.spec.ts test/logger.spec.ts     # passing
packages/db-p2p: mocha test/an-interrupted-write-does-not-wedge-the-collection.spec.ts \
                       test/failed-cancel-does-not-strand-the-writers-pend.spec.ts  # 8 passing
packages/db-p2p: mocha test/rival-superseded-only-by-a-writer-that-built-on-it.spec.ts \
                       test/cluster-pend-staleness.spec.ts test/mid-ddl-crash.spec.ts \
                       test/cohort-pend-refusal-channel.spec.ts \
                       test/coordinator-repo-stale-classification.spec.ts \
                       test/reset-does-not-strand-its-own-pend.spec.ts              # 49 passing
packages/quereus-plugin-optimystic: mocha test/concurrent-insert-refusal.spec.ts \
                                          test/concurrent-row-change-refusal.spec.ts  # 29 passing
```

No pre-existing failures surfaced. `yarn typecheck` was not run from the root: neither `quereus-plugin-optimystic` nor `quereus-plugin-crypto` changed, which is the condition the project rules attach it to.

## For the reviewer: what the full suites still owe

The db-p2p and quereus-plugin-optimystic full suites have not run (project rules put them in review). The two places a regression would most plausibly hide are specs that build a `StorageRepo` with no options and then leave a pending record standing for a long wall-clock interval — a record stamped at pend time cannot lapse inside a test, but a record written straight through raw storage (no `pendingSince`) is judged from the repo's construction time, so a suite that constructs one repo and runs for over five minutes before reading such a record would see a lapse. None was found; the full run is what confirms it.
