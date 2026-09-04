description: A write spanning several blocks could report success while leaving a permanent "write in progress" marker on blocks its second commit stage never reached, wedging those blocks against every future write. The committer now cancels the blocks it abandoned before reporting success.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts, packages/db-p2p/test/empty-state-contract.spec.ts, docs/repository.md, docs/internals.md
----

# Torn commit now cancels the blocks it abandoned

## What was wrong

`NetworkTransactor.commit` commits in two stages: the tail block first, then a "sweep" of every
other block. When the sweep failed in a transport-shaped way (a throw, not a returned refusal), the
code tolerated it and returned `{ success: true }`, on the stated premise that "the commit consensus
for these blocks exists". That premise is false for a sweep that reached nobody: no consensus record
exists, no reconciliation ever runs, and every cohort member keeps the pending record its pend wrote
for those blocks. A pending record's only removers are a client cancel (never sent — the client was
told it succeeded), a divergence-shaped commit refusal (never happened), and a forward write of the
same action id (never comes). The record is permanent, and while it stands
`ClusterMember.validatePendOperations` rejects every later write to the block from every writer.

## The fix

In `NetworkTransactor.commit`'s tolerated non-tail-sweep arm: collect the block ids whose sweep
batches confirmed success, cancel the rest via the existing consensus-routed
`NetworkTransactor.cancel`, then return `{ success: true }` as before. The invariant established:

> When `NetworkTransactor.commit` returns, every block in `request.blockIds` is either committed or
> has had its pending record cancelled.

Cancel is safe in all three timing races (commit actually landed → cancel is a no-op on the promoted
record; commit reached nobody → cancel is the repair; consensus lands after the cancel → the member
sees a missing pend, which `applyConsensusOperation` already treats as behind-divergence and cures by
reconciling).

Deliberately unchanged: the confirmed-conflict path still returns the stale failure and leaves
cancellation to `TransactorSource.transact`; the tail's own failure path still leaves the cancel to
its caller; the acknowledged tail is never reported as a failure.

## Where the code and docs ended up

- `NetworkTransactor.cancelAbandonedSweepBlocks` (db-core) — the cancel, with the required/safe/
  residual analysis as its doc comment.
- `docs/repository.md` §"A pending record's lifetime is bounded by its writer" — the removers, the
  writer's obligation, and the residual, beside Invariant P.
- `docs/internals.md` torn-action section — a bullet naming the *tolerated* arm alongside the refused
  one, so a reader no longer concludes every torn action is reported as a failure.
- `packages/db-p2p/src/testing/mesh-harness.ts` — `BuildTransactorOptions.wrapRepo`, a shared seam for
  injecting a transport-shaped failure into one RPC.
- `packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts` — three arms (mechanism,
  production path, confirmed-conflict guard).

## Review findings

### Checked

- Read the implement diff cold before the handoff summary. Traced the tolerated arm's whole failure
  population: `commitBlocks`' two error shapes, `processBatches`' settle semantics (every batch is
  settled before `commitBlocks` returns, so the confirmed/abandoned split sees a complete picture),
  and the `allBatches`/`everyBatch` retry-tree walks.
- Verified each of the three safety claims against the code rather than the comment.
  `StorageRepo.cancel` → `BlockStorage.deletePendingTransaction` touches only the pending record, so a
  cancel cannot un-promote a committed revision. `CoordinatorRepo.cancel` routes through consensus
  per block (with the solo-cohort short-circuit), so every member drops the record. A cancel record
  carries neither pend nor commit operations, so `evaluatePromise` has nothing to reject and cancel
  consensus is not itself refusable. `ClusterMember.applyConsensusOperation` does treat a
  missing-pending commit as behind-divergence and reconcile. All three hold.
- Verified the paths the fix deliberately leaves alone are actually covered elsewhere:
  `TransactorSource.transact` cancels **all** `pendResult.blockIds` on a returned failure or a throw,
  and `TransactionCoordinator.cancelPhase` does the same per collection. So the early
  `staleFromBatches` return — a mixed sweep with one confirmed conflict and one throw — strands
  nothing.
- Direction of error in the confirmed/abandoned split: cancelling a block that did commit is a no-op,
  so an over-broad cancel costs a consensus round and never correctness. Only under-cancelling is
  dangerous, and that needs a batch to report `success: true` without durability.
- Latency of the new cancel: bounded by `abortOrCancelTimeoutMs` (5s in the Quereus adapter, 10s in
  reference-peer), on a path that has already failed. Acceptable; no change made.
- Docs read for stale claims about the commit tolerance: `docs/repository.md`, `docs/internals.md`,
  `docs/transactions.md`, `docs/architecture.md`.
- Site-claim grep across `backlog/ fix/ plan/ implement/ review/` for `network-transactor` — three
  open backlog tickets touch it; none needed a new sibling for these findings.

### Found and fixed in this pass (minor)

- **`commit` had grown to ~104 lines**, about 30 of them one comment block wrapping 12 lines of new
  code. Extracted `cancelAbandonedSweepBlocks`; the rationale is now that method's doc comment and
  `commit` reads as tail → sweep → split by failure shape → cancel what was abandoned.
- **The spec asserted the abandoned block's resulting state but never that the cancel was scoped.**
  Added two assertions to the production arm: the abandoned block must appear in the cancels the
  transactor issued, and the durably committed tail must never. Red-checked — with the cancel
  neutered, the arm now fails at `expected [] to include 'S'`.
- **The spec hand-rolled its own "build a NetworkTransactor over this mesh"**, duplicating the mesh
  harness's own exported `buildNetworkTransactor` (same 5s/5s defaults). Added a `wrapRepo` option to
  `BuildTransactorOptions` and moved the spec onto it; also moved `empty-state-contract.spec.ts`'s
  identical local copy (which differed only by its 3s budget) onto the shared builder, removing the
  second duplicate rather than leaving a third pattern in the tree.
- **`docs/internals.md`'s torn-action section documented only the *refused* arm**, so a reader would
  conclude every torn action is surfaced as a failure and retried. Added a bullet naming the
  tolerated arm, the cancel that discharges it, and the consequence: an acknowledged torn action
  leaves its non-tail blocks at their prior revision — the transform is dropped, not deferred.

### Found and recorded as a tripwire, not a ticket

- **The `confirmed` filter is structurally unreachable on every in-process test mesh.**
  `NetworkTransactor.consolidateCoordinators` runs a greedy set cover at pend time, so whenever one
  peer is responsible for every block of the action (true on every current test mesh, where all nodes
  are responsible for all blocks) the pend collapses to a single batch, and commit reuses that
  resolution — the sweep is therefore always one batch, and the confirmed set is always empty.
  Discovered by writing a partial-sweep test that failed for exactly this reason: it picked two block
  ids with different `findCoordinator` results, and they still shared a commit batch. The test was
  removed rather than contrived into passing. A `NOTE:` at the `confirmed` computation records what a
  real partial-sweep test would need — a mesh whose responsibility sets are disjoint enough to force
  two pend batches — and that a new failure injection alone cannot reach it. Conditional, not a latent
  defect: over-cancelling is a no-op, so the untested filter can only cost a wasted consensus round.

### Found and appended to an existing ticket

- `backlog/debt-torn-commit-mesh-coverage-drops-no-blocks` asks for the tear helper to move into the
  shared mesh harness. The new `wrapRepo` seam is a partial answer at a *different* layer (per-repo
  RPC vs whole-transactor request rewriting). Appended an arm so whoever picks that ticket up chooses
  one layer instead of adding a third helper.

### Checked and found nothing — with the reason

- **Correctness of the fix itself: no defect.** Every claim in the implementer's rationale survived
  being checked against the code it cites.
- **Resource cleanup / error handling: nothing.** The cancel's catch is total and logs; no new
  unawaited promise, no new retained state, no new timer.
- **Type safety: nothing.** No new casts; the batch-response idiom matches the four pre-existing uses
  in the same file.
- **No major findings, so no new `fix/`, `plan/`, or `backlog/` ticket was filed.** The two residuals
  the implementation names — a cancel that itself fails over the network, and `StorageRepo.commit`'s
  genuine-fault arm keeping pendings for a retry that may never come — are already owned by
  `backlog/debt-unpromotable-pending-records-need-a-sweep`, which carries this instance as an arm.
  Re-filing either would be the Nth instance of a class that already has a ticket.

### Considered and declined

- **Widening `CommitResult` to express "the tail landed, these blocks did not."** The implementer
  weighed this and declined; I agree. It touches the `ITransactor` contract and every implementation,
  and no current caller would do anything with the information beyond what commit now does itself.
- **Pinning the two argued-but-untested timing races** (commit landed but the response was lost;
  consensus lands after the cancel). Both need injection *below* the repo boundary, inside
  `ClusterMember`, which the mesh harness does not expose. The behavior they rest on is directly
  readable in `applyConsensusOperation` and already has its own divergence coverage; building a new
  injection layer for them is disproportionate.

## Validation

`yarn build`, `yarn typecheck`, `yarn lint` (eslint, clean), `yarn lint:docs` (45 documents, 71
anchored citations, 576 file mentions, 310 links — all resolve), and `yarn test` at repo root — all
green, 0 failing, across every workspace (258 db-p2p specs among them; the torn-commit spec's 3 arms
pass). Red-check re-run after the review edits: neutering the cancel fails the production arm at the
new scoped-cancel assertion, so the suite still measures the fix. No pre-existing failures surfaced.
