description: A write spanning several blocks could report success while leaving a permanent "write in progress" marker on blocks its second commit stage never reached, wedging those blocks against every future write; the committer now cancels the blocks it abandoned before reporting success. Review the fix, its tests, and the recorded residuals.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts, docs/repository.md
----

# Review: torn commit now cancels the blocks it abandoned

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
Verified deterministic repro was in the source ticket; the new spec reproduces both arms.

## The fix (one site)

In `NetworkTransactor.commit`'s tolerated non-tail-sweep arm
(`packages/db-core/src/transactor/network-transactor.ts`, the transport-shaped branch after
`staleFromBatches` returns nothing): collect the block ids whose sweep batches confirmed success,
cancel the rest via the existing `NetworkTransactor.cancel` (consensus-routed, so every member drops
the record), then return `{ success: true }` as before. The invariant established:

> When `NetworkTransactor.commit` returns, every block in `request.blockIds` is either committed or
> has had its pending record cancelled.

Cancel is safe in all three timing races (commit actually landed → cancel is a no-op on the promoted
record; commit reached nobody → cancel is the repair; consensus lands after the cancel → the member
sees a missing pend, which `applyConsensusOperation` already treats as behind-divergence and cures by
reconciling). Nothing was lost by cancelling: a sweep pending whose commit reached nobody could never
be promoted by anything anyway — the client never re-drives a commit it was told succeeded.

Deliberately unchanged:
- confirmed-conflict path (returned `success:false` from a coordinator) still returns the stale
  failure and leaves cancellation to `TransactorSource.transact`;
- the tail's own failure path (`commitBlock`) still throws/returns without self-cancelling — the
  caller owns that cancel;
- the acknowledged tail is still never reported as a failure.

Also landed:
- replaced the false "consensus exists" comment with the actual failure-shape analysis, naming the
  residual (a failed cancel) and the backlog slug that owns the node-side backstop
  (`debt-unpromotable-pending-records-need-a-sweep`);
- `docs/repository.md`: new section "A pending record's lifetime is bounded by its writer", beside
  Invariant P, stating the removers, the writer's obligation, and the residual.

## Tests (`packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts`, 3-node mesh)

- **Mechanism arm** (no injection): pend two blocks through consensus, commit only the tail. Asserts
  every member keeps the sibling's pending record, later writes are refused with a pending-conflict
  reason, and an explicit cancel repairs it (record dropped everywhere, next write lands). This arm
  is independent of how a tear is produced.
- **Production arm** (the one that gates the fix): only injection is a throwing sweep RPC
  (recognized as a commit request not carrying the tail). Commit still returns success; the
  invariant assertion (`assertPendingLifetimeInvariant` — no member holds the action's pending on a
  block unless it committed there) passes; later writes to the abandoned block succeed.
  **Red-check done**: with the cancel neutered, this arm fails exactly at the stranded-record
  assertion (`expected [ 'a2' ] to not include 'a2'`), so the test measures the fix.
- **Guard arm**: a confirmed sweep conflict (rival already committed the block's revision) still
  surfaces as `success:false` — the tolerance did not swallow the conflict path.

## Validation run

`yarn build`, `yarn typecheck`, `yarn test` at repo root — all green (258 db-p2p specs among them;
full log in `tickets/.logs/1-torn-commit-must-cancel-the-blocks-it-abandoned.test.log`).
`yarn lint:docs` and eslint on the touched files clean. db-core was rebuilt before db-p2p specs ran.

## Known gaps and residuals (honest list for the reviewer)

- **The cancel is best-effort.** If the cancel itself fails over the network, the wedge persists.
  Swallowed with a WARN at the site; the node-side backstop is the backlog ticket
  `debt-unpromotable-pending-records-need-a-sweep` (the source ticket already appended this instance
  as an arm there). Not re-filed.
- **Two of the three timing races are argued, not tested.** The spec pins "sweep reached nobody"
  deterministically. "Commit landed but the response was lost" (cancel meets a promoted record) and
  "consensus lands after the cancel" (member reconciles a missing pend as behind-divergence) rest on
  the documented behavior of `BlockStorage`/`applyConsensusOperation`, not on new assertions. If the
  reviewer wants either pinned, it needs finer-grained injection than the repo-wrapper used here.
- **Representation not widened.** `CommitResult` still cannot express "the tail landed, these blocks
  did not", so no caller can be forced to handle a torn commit. Weighed per the source ticket:
  widening the result touches the `ITransactor` contract and every implementation/caller, and no
  current caller would do anything with the information beyond what commit now does itself (cancel).
  The cancel alone establishes the invariant. If a caller ever needs to act differently on a torn
  acknowledge, that is the moment to widen.
- **A second producer of durable pendings remains.** `StorageRepo.commit`'s genuine-fault arm
  deliberately keeps a failed batch's pendings for a retry that may never come. Correct as designed,
  out of this ticket's scope, and named in the new code comment so the next reader does not conclude
  the cancel covers every producer. The same backlog sweep ticket owns it.
- **The acknowledged action's non-tail content stays torn.** After the fix, an acknowledged commit
  whose sweep reached nobody leaves the abandoned block at its old revision (the pending transform is
  cancelled, not applied). That is not a regression — pre-fix the transform was equally unapplied and
  additionally wedged the block — but the collection-level story ("log entry durable in the tail,
  structural block behind") is inherited from the pre-existing torn-action tolerance, not improved
  here.
