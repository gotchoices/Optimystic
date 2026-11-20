description: A reservation left behind by a machine that disappeared mid-change now stops blocking other writers once it has sat unfinished far longer than any real change takes — while still being kept, so the original change can land if it ever comes back. Built and reviewed.
architecture: docs/repository.md#a-pending-records-lifetime-is-bounded-by-its-writer
files:
  - packages/db-p2p/src/storage/pending-claim.ts (`ReservationLease`, `hasLapsed`, `claimAgeMs`, `PendingClaim.pendingSince`, `PendingClaimFields`)
  - packages/db-p2p/src/storage/struct.ts (`BlockMetadata.pendingSince`)
  - packages/db-p2p/src/storage/block-storage.ts (`claimOf`, `recordClaim`, `hasClaim`, `setEntry`, `savePendingTransaction`, `sweepDeadClaims` doc)
  - packages/db-p2p/src/storage/i-block-storage.ts (contract docs only)
  - packages/db-p2p/src/storage/storage-repo.ts (`DEFAULT_PEND_LEASE_MS`, `PEND_LEASE_BUDGETS`, `resolvePendLeaseMs`, `StorageRepoOptions.pendLeaseMs`/`now`, `StorageRepo.runStartedAt`/`pendLease`, `IPendingClaimReader.pendLease`, `pendUnderLatches`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember.reservingRivals`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`pendingClaimsOf`, `livePendingClaims`)
  - packages/db-p2p/src/repo/stuck-reservation.ts (`stuckReservationMessage`)
  - packages/db-p2p/src/libp2p-node-base.ts (`prepareServingStore`)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.pendLeaseMs`, `MeshOptions.now`)
  - packages/db-core/src/transactor/network-transactor.ts, owed-cancels.ts, transactor-source.ts (comments only)
  - packages/db-p2p/test/a-lapsed-pend-stops-reserving-its-block.spec.ts (new), pending-claim.spec.ts, storage-repo.spec.ts, cluster-pend-held-vote.spec.ts, block-storage.spec.ts, block-lineage.spec.ts, cluster-commit-digest.spec.ts, member-leaves-and-returns.spec.ts, transaction-node-count-sweep.spec.ts
  - docs/repository.md, docs/correctness.md, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/storage.md, .release-notes.pending.md
----

# A pending record reserves its block only for a bounded time

Landed as `ticket(implement): a-pending-record-reserves-its-block-only-for-a-bounded-time`, reviewed and amended in this pass.

## What shipped

**The rule.** A pending record reserves its block for a bounded span measured from the moment *this node* stored it. Past that span the record has **lapsed**: it no longer reserves the block against any other writer. It is not deleted, and its own commit is still honoured. The rule is `hasLapsed` in `packages/db-p2p/src/storage/pending-claim.ts`, with three branches — no lease given (nothing lapses), a stamped record (judged from its own `pendingSince`, strictly greater than the lease), an unstamped record (judged from the reading run's start, the one place the fallback deliberately points at lapsing). The age itself is `claimAgeMs` in the same file, so the verdict and the number logged beside it cannot be measured from different anchors.

**What is stored.** `BlockMetadata.pendingSince`, a fourth sibling of `pendingRevs` / `pendingBases` / `pendingRuns`, written, dropped and swept in the same metadata write (`BlockStorage.recordClaim`). Read back as `PendingClaim.pendingSince`. It is the one **required** field of `PendingClaimFields`, so a save path that forgets to stamp it is a compile error rather than a record that silently lapses one lease after the run started.

**Where the lease is read.** `StorageRepo.pendUnderLatches` pass 1 (logs `pend:lapsed-claim`; a lapsed record is **not** added to the pass-2 delete list), `ClusterMember.reservingRivals` at the promise vote (logs `cluster-member:validation-pending-lapsed`), and `CoordinatorRepo.livePendingClaims` so the diagnostic enrichment behind a `held` answer never names a holder this node has stopped holding for. Both rival scans ask **abandoned → lapsed → slot**, in that order.

**Where it is deliberately not read.** `ClusterMember.validateCommitBaseDeclarations`, the read-driven promotion in `StorageRepo.get`, `StorageRepo.internalCommit`'s fork guard, `BlockStorage.savePendingTransaction`'s `PendRevisionTakenError`, and `sweepDeadClaims`. No commit is refused for having lapsed.

**The value.** `DEFAULT_PEND_LEASE_MS = 300_000`, `PEND_LEASE_BUDGETS = 10`, and `resolvePendLeaseMs(transactionTimeoutMs) = max(default, 10 × transactionTimeoutMs)`, which `libp2p-node-base.ts` calls with `linkDeadlines.transactionTimeoutMs`. `StorageRepoOptions.pendLeaseMs` overrides; `0` disables lapsing entirely and reduces the behaviour to what shipped before. `StorageRepoOptions.now` is the clock (default `Date.now`); `StorageRepo.runStartedAt` is captured as `this.now()` in the constructor so an injected clock and the anchor share a frame.

**What sizes it.** Not the measurement. The longest span the code can hold **one** record open for is a pend budget plus a commit budget (60 s at the default `transactionTimeoutMs`), since a failed attempt discharges its own pend; the default is five times that worst case and about an order of magnitude over a whole exhausted 21 s sync cycle. The mesh spec additionally logs a healthy writer-side pend-to-commit span for magnitude only — tens of milliseconds in-process (30-41 ms across runs).

## Review findings

### Checked

Read the implement diff cold before the handoff, then read or ran each of:

- **The rule and its seams.** All three branches of `hasLapsed`; the scan ordering at both sites; each of the five sites that deliberately do not read the lease, by reading the code rather than taking the handoff's word.
- **Whether a stamp can cross machines**, which would turn the rule into a clock comparison between nodes. It cannot: `BlockArchive` carries `revisions`, `range` and `pending` *transforms* only — no metadata maps — `saveRestored` writes only committed revisions, and `saveMetadata` is reached only from `BlockStorage` over locally-read metadata. The "only ever read by the node that wrote it" claim in `BlockMetadata.pendingSince` holds.
- **Every `savePendingTransaction` caller.** One production caller at the `IBlockStorage` tier (`StorageRepo.pendUnderLatches`); the rest are raw-storage conformance fixtures that write no claims. Requiring the field cannot be worked around silently.
- **Every `IPendingClaimReader` implementor.** `StorageRepo` alone in `src/`; nothing decorates or forwards the interface, so the new required member cannot be dropped by a wrapper. The handoff flagged this as an argument from absence; it is now checked.
- **The third claim reader.** `CoordinatorRepo.corroborateHeldBlocks` also applies `isReservationAgainst`; it is fed through `pendingClaimsOf`, so it inherits the lapsed filter rather than needing its own.
- **Interaction with the unpromotable-record refusal.** `PendRevisionTakenError` fires only on `meta.latest.rev >= rev`, never on a rival record, so admitting a newcomer over a lapsed record at the same slot cannot turn a stale answer into a throw.
- **`sweepDeadClaims`'s `pendingRevs`-only iteration** against the widened co-keying NOTE in `struct.ts`, and the "claim-less record" reasoning in `deletePendingTransaction` now that every new record carries a stamp. Both still hold.
- **The mesh restart path**, which rebuilds the repo and does pass the new options.
- **Happy path, boundaries, error paths and the upgrade population** by running the specs, including the release-shaped record written straight through raw storage (`pendAsRelease`), which is the real unstamped shape.
- **Docs**: every file the change touched, plus the ones it should have (see below).
- **Tests as code under review**, all 15 new cases.

### Found and fixed in this pass

- **Ten prose sites still named a ticket that no longer exists, and four of them stated the opposite of what shipped.** The plan stage dissolved `debt-unpromotable-pending-records-need-a-sweep` into this ticket plus two backlog arms, so the slug is gone from the board; worse, `network-transactor.ts` (two sites), `owed-cancels.ts` and `block-storage.ts` still told the reader that a remote writer's or a larger cohort's record "stays wedged until a node-side backstop sweep exists" and is "reclaimed by nothing node-side". That is false now: the record is still not removed, but the block it holds is freed at the end of the lease. Rewritten to say exactly that, at `packages/db-p2p/src/storage/block-storage.ts` (`sweepDeadClaims`), `packages/db-core/src/transactor/network-transactor.ts`, `packages/db-core/src/transactor/owed-cancels.ts`, `packages/db-core/src/transactor/transactor-source.ts`, `docs/repository.md`, `docs/correctness.md`, `packages/db-p2p/test/member-leaves-and-returns.spec.ts` and `packages/db-p2p/test/transaction-node-count-sweep.spec.ts`. No remaining reference to the dissolved slug outside build output and the ticket board.
- **A user-visible behaviour change with no release note, beside an existing note the change falsified.** `.release-notes.pending.md`'s GitHub #54 section still read "Other shapes are unchanged… is not cleared". Rewrote that bullet and added a GitHub #18 section in the file's plain-language register, including the two limits a host should know (an upgrade's unstamped records, and a writer that keeps re-pending).
- **The claim age was computed in three places.** Once inside `hasLapsed` and once in each scan's log line, each repeating the `?? runStartedAt` fallback — so a change to the fallback would have left the logged number measuring something other than the verdict. Extracted `claimAgeMs`; both log sites call it, and the two tripwire NOTEs about that fallback's direction moved to the line they actually describe.
- **A dangling doc link.** `{@link MeshConfig.now}` in `mesh-harness.ts` — there is no `MeshConfig`; the interface is `MeshOptions`. (The implement handoff's `files:` list carried the same wrong name.)
- **Spurious precision in `DEFAULT_PEND_LEASE_MS`'s comment.** It reported the measured span as "41 ms" and the default as "about 7300x" it; the same spec logged 30 ms on this pass. Restated as tens of milliseconds (30-41 ms across runs) with the point made plainly: the measurement establishes the magnitude of a healthy span, it does not size the lease — the budget arithmetic does.
- **An unmeasured timing claim.** `docs/correctness.md` Theorem 1 Case 2's fifth case ended "a record whose action committed elsewhere is promoted here … long before a lease elapses". Nothing guarantees a read or write through that member inside one lease. Rewritten so the case rests where its safety actually rests — the local fork cannot reach the strict-majority durability bar and the member is reconciled — and says the timing is not guaranteed.

### Test added

One, at the repo tier: `storage-repo.spec.ts` → "a record that is BOTH abandoned and lapsed is deleted, not merely set aside". The abandoned-before-lapsed order is a named part of the written rule and nothing pinned it. Read the other way round, a provably-dead writer's record would be set aside on age for as long as the block exists and never reclaimed — the exact leak the run stamp was added to close, and invisible from outside.

### Tests reviewed and kept

All 15 of the implementer's cases stand. The `hasLapsed` table pins a pure rule with real branching, one case per branch plus the backwards-clock reading; the two vote cases assert `ClusterMember`'s verdict (the reader is a double supplying inputs, not the thing under test); the two repo-tier cases run a real repo over real storage; the mesh spec is the reproduction of this ticket's class at the only tier that can produce it. The mesh spec's phase-1 measurement wrapper — about 25 lines whose only output is a log line nothing asserts — was weighed for removal and kept: it rides on setup the later three phases need anyway, and it is what makes the figure quoted in `DEFAULT_PEND_LEASE_MS` reproducible rather than remembered.

### Tests cut

None. Nothing in the set restates the implementation, verifies a mock, or covers wiring a type already enforces.

### Major findings / tickets filed

None, and not for want of looking. The two shapes that would have qualified both resolve inside the rule as shipped: a record that is both abandoned and lapsed is deleted (now pinned by a test rather than by the branch order being read correctly), and a lapsed record's own commit still promotes it (pinned at three tiers). Everything else found was a prose or DRY defect fixable in this pass, listed above. Nothing went to `blocked/`: the specification settled every question this review raised.

### Tripwires

No new ones. The four the implementer parked were read and left where they are — the undeleted bytes and the two unstamped-record cases in `pending-claim.ts` (the latter two now sitting on the expression they describe, inside `claimAgeMs`), and the re-pend renewal at the stamp site in `StorageRepo.pendUnderLatches`. The re-pend one is also stated in `docs/repository.md` and in `stuckReservationMessage`, which is right for a limit an operator reading a log line needs to know about.

### Knowingly not done

- **No test for members disagreeing during a lapse.** Deliberate, and the argument is in `hasLapsed` and `docs/repository.md`: nothing is destroyed, each member anchors to its own receipt of the same record, and a member that has not yet lapsed votes `held`, which four-or-more absorbs and two-or-three resolves on the next retry. A spec would have to pin a transient that no member acts on.
- **`stuckReservationMessage` hardcodes "five minutes by default" in prose** rather than interpolating `DEFAULT_PEND_LEASE_MS`. Left alone: `stuck-reservation.ts` deliberately imports nothing but `db-core`, and the sentence self-qualifies ("and longer on a node that declares a slow link"). Importing a storage-repo constant into a pure counter costs more than the drift risk.
- **The two deep-equality assertions the implementer weakened** in `storage-repo.spec.ts` (to `include` plus `not.have.property('localRun')`, and to a `?.baseRev` read) each still cover their own test's claim; what they lost is an incidental "and nothing else is on the record". Accepted rather than threading an unknowable `Date.now()` stamp through them.

## Validation

Full suites, per `tickets/rules/testing.md`, after the fixes above.

```
packages/db-core:                    yarn build                      # clean
packages/db-p2p:                     yarn build                      # clean
root:                                yarn lint                       # clean
root:                                yarn lint:docs                  # 49 documents, 847 citations, 907 mentions, 818 links — all resolve
root:                                yarn lint:deps                  # 1283 files / 13 packages — every import declared
root:                                yarn check:rn                   # Metro bundle + legacy Hermes compile pass
packages/db-core:                    yarn test                       # 2124 passing
packages/db-p2p:                     yarn test                       # 3844 passing, 84 pending
packages/db-p2p:                     yarn test:integration           # 60 passing, 2 pending
packages/quereus-plugin-optimystic:  yarn test                       # 1429 passing, 14 pending (+ smoke ok, quereus@5.6.1)
```

No pre-existing failures surfaced, so nothing was written to `tickets/.pre-existing-error.md`. `yarn test:integration` was run even though the implement stage had not: the change alters the promise vote, which is cohort-level. The full db-p2p run also answers the question the handoff left open — whether a spec that constructs one default-lease repo and runs for over five minutes could see an unstamped record lapse mid-suite. The suite takes three minutes and nothing lapsed.
