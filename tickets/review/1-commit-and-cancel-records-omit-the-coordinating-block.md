description: Machines that store data check for themselves whether the group of peers claiming to handle a write is really the right group. That check used to be skipped on two of the three steps of a write, which could leave a write half-finished; it now runs on all three, and a dishonest coordinator can no longer point the check at a group of its own choosing.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/mesh-partition-admission.spec.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/test/dispute.spec.ts
difficulty: medium
----

# Review handoff — the coordinating block now reaches every cluster path, and is bound to the record's own operations

All three arms of `implement/1-commit-and-cancel-records-omit-the-coordinating-block` landed. Nothing
was deferred. Build, typecheck and both test suites pass (numbers at the bottom).

## What changed, in plain terms

A cluster member votes on a write only after checking that the peer group the coordinator declared is
plausibly the right group for that block. To run that check the member has to look up the block's real
cohort itself, which needs a block id — the "coordinating block". Records carried that id on the first
step of a write (`pend`) but not on the two that follow (`commit`, `cancel`), so on those steps the
check silently degraded to a cruder rule that could refuse a group it had just approved.

Three fixes:

1. **The id is now derived at one choke point.** `ClusterCoordinator.executeClusterTransaction` is
   already handed the cohort key; it now stamps that key onto a **copy** of the message when the
   message carries none. Message builders can no longer forget it.
2. **There is one copy of the id, inside the hash.** `ClusterRecord.coordinatingBlockIds` (a duplicate
   at the top level of the record, outside every hash and rewritable by any relaying peer) is deleted.
   Every reader now uses `record.message.coordinatingBlockIds`, which `messageHash` covers.
3. **The id must be one the record's own operations name.** Without that, a dishonest coordinator could
   shrink the peer group and then point the member's own lookup at a *different* block whose real
   cohort happens to match — every member would then agree with itself and admit. The gate now checks
   the binding and, on a mismatch, falls back to the conservative branch that already existed (and
   logs). It does not throw.

## Where each arm lives

| Arm | Site |
| --- | --- |
| 1 — derive at the choke point | `cluster-coordinator.ts:249` (`executeClusterTransaction`, the `coordinated` copy); the copy is what `createMessageHash` and `makeRecord` now receive |
| 2 — one hash-covered copy | `db-core/src/cluster/structs.ts` (field removed, `message` doc'd); `cluster-repo.ts` `deriveExpectedClusterView`; `dispute-service.ts:168, ~528, ~540` |
| 3 — operations binding | `cluster-repo.ts` `ClusterMember.operationBlockIds` + the check in `deriveExpectedClusterView` |

**Arm 2 shape chosen: the preferred one** — the `ClusterRecord` field was removed outright rather than
left in place with only the gate switched over. It was 3 production readers and 6 test-literal lines;
removing it means a future reader cannot pick the unhashed copy by accident.

New log tags, both on the `cluster-member` namespace:

- `cluster-member:derive-expected-cluster` — `{ messageHash, blockId }`, emitted when a member actually
  derives a view. This is the only externally visible sign that the confident predicates ran rather
  than the fallback floor, and the new commit/cancel tests assert on it.
- `cluster-member:coordinating-block-unbound` — `{ messageHash, coordinatingBlockId }`, the arm-3
  mismatch.

## Use cases to test / validate

**The stranding case (the headline).** Five-node mesh declaring `assumedClusterSize: 5`, views split
3|2, minority confidence collapsed. The 3-peer majority pends (admitted) and then commits — the commit
must also be admitted. Before this change the commit was refused with
`membership-not-admitted:low-confidence-downsize` and the write sat pended forever.
→ `mesh-partition-admission.spec.ts` › *admits the same majority on the commit path — the write is not
stranded*. It asserts the commit succeeds, that no member refused, that a view was derived from the
block, **and** that the block reaches rev 1 in local storage.

**Multi-block cancel.** `CoordinatorRepo.cancel` builds ONE message and runs one cluster transaction
per block. Two things to poke at: (a) the coordinating id must be per-transaction, so verify no id
leaks between blocks — a mutating implementation would pass a weaker version of this test; (b) two
blocks with identical cohorts used to produce an identical `messageHash`, colliding in the
coordinator's `transactions` map and in `wasTransactionExecuted`. → *derives on the cancel path too,
and gives each block of a multi-block cancel its own transaction*, which reads the coordinator-side
`cluster-tx:start` log for two distinct hashes and two distinct block ids.

**Arm 3, both directions.** The same shrunken-cohort record, once with the coordinating block bound to
the operations (admitted — a legitimate small cohort looks identical, which is why the size predicates
alone cannot separate them) and once unbound (falls to the fallback floor and rejects, mismatch
logged). → `cluster-membership-admission.spec.ts` › *the coordinating block must be bound to the
record's own operations*. The pair is deliberately minimal-diff so the binding is provably the thing
that separates them.

**Regression surface worth re-poking:**

- Every `RepoMessage` reaching `executeClusterTransaction` without `coordinatingBlockIds` now hashes
  differently than before (the field is inside the preimage). No spec cross-computes a coordinator
  hash independently, so nothing broke — but a reviewer should confirm no *persisted* state outlives a
  version boundary keyed on that hash. Coordinator state is per-transaction and short-lived; I did not
  find a durable consumer.
- `dispute-service.ts:168` selects the arbitrator draw key as `coordinatingBlockIds[0] ?? messageHash`.
  For commit/cancel-originated disputes that used to fall through to `messageHash` and now resolves to
  the block id. I believe this is the intended draw (arbitrators drawn by the same key that selected
  the cohort) but it *is* a behavior change, and it is the one place in this diff where the new value
  differs from the old rather than merely arriving by a different branch. Worth a second opinion.
- `dispute-service.ts:~528` (`extractInvalidationTarget`, commit arm) takes a different branch now, but
  lands on the same id: the coordinator derives the field from `commit.blockIds[0]`, which is exactly
  what the final fallback produced. Confirmed by reading, not by a dedicated test.

## Known gaps — read these before trusting the diff

- **A *confident* minority side is still admitted on the commit path.** I wrote a test asserting a
  post-partition minority commit is refused; it failed, and the premise was wrong, not the code. A
  member whose size estimate did not collapse genuinely measures a 2-peer cohort and cannot tell a
  partition from a small deployment — Theorem 2's protection rests on a partition collapsing that
  confidence, which is what `meshConfidence` models. Nothing diverges (both sides pended the same
  action; only one commits it), so I pinned the true behavior with the reasoning spelled out rather
  than deleting the case: *measures a minority commit against the minority members own derived view*.
  A reviewer who thinks that posture is itself wrong is looking at a design question, not this diff.
- **No new coverage for the `peerCount <= 1` short-circuits.** The ticket asked for it; it already
  exists in `coordinator-repo-cancel-solo-cohort.spec.ts`, `coordinator-repo-integration.spec.ts`
  (*should cancel on a solo cohort without opening the small-cluster hatch*) and `mid-ddl-crash.spec.ts`.
  I confirmed by reading those, not by re-running them in isolation. Same for
  `allowUnvalidatedSmallCluster`, covered in both admission specs.
- **Arm 3's binding is asserted for production callers by reading, not by exhaustive test.** I traced
  `pend` (`network-transactor.ts:494-510` builds the payload *from* the consolidated block list, and a
  `processBatches` retry re-batches without the option so `coordinator-repo.ts:1218` falls back to the
  transforms' own ids), `commit` and `cancel`. There is no production builder for an `invalidate`
  `RepoMessage` today — `operationBlockIds` handles the case anyway. If a future caller violates the
  binding it fails *closed* (conservative floor), not loudly, so a violation would show up as
  unexplained `low-confidence-downsize` rejections plus a `coordinating-block-unbound` log line.
- **Cost, as the ticket instructed: not addressed, deliberately.** The derived view is one `findCluster`
  per inbound record, and this adds it to the commit and cancel promise paths. The existing `NOTE:` at
  `deriveExpectedClusterView` already records the remedy (cache per `(blockId, short TTL)`) and the
  condition for reaching for it. No cache added.
- **No docs change.** I grepped `docs/` for `coordinatingBlockIds`; the only hit is `docs/review.html`,
  a historical review artifact that describes a different concern and should not be rewritten. The
  admission gate's inputs are documented in the `admitMembership` / `ClusterRecord` doc comments, both
  of which were updated in place.
- **Only the mesh tier's floors reflect a real deployment.** `cluster-membership-admission.spec.ts`
  builds members from bare constructor defaults, which exercise floors no node ever runs on. That is
  fine for unit-level gate coverage (and is where arm 3 is tested) but claims about commit-path
  behavior should be read off the mesh spec.

## Verification run

- `yarn build` (root) — clean; `yarn typecheck` (root) — clean. Note `db-core`/`db-p2p` have no
  `typecheck` script; their `build` is `tsc` over `["src", "test"]`, so the test files *are*
  typechecked by the build.
- `yarn workspace @optimystic/db-p2p test` — **1956 passing, 44 pending, 0 failing**.
  (Ticket baseline under its throwaway probe patch was 1950 / 44 / 1; the +6 is this ticket's new
  cases, and the 1 failing was the KNOWN-GAP case, now flipped.)
- `yarn workspace @optimystic/db-core test` — **1393 passing**.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
