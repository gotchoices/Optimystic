----
description: The database adapter's distributed-consensus mode has two pieces of behaviour that no test ever runs, because no test stands the adapter up in that mode at all. Build the missing test setup once and cover both.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (the CoordinatorPartialCommitError catch branch ~346-362; addStatement session forwarding)
  - packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts (the enableSessionMode helper — the seed of the harness)
  - packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts (template: injects a commit-failing transactor)
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts (all currently legacy-mode)
  - packages/db-core/src/testing/test-transactor.ts (SelectiveCommitFailTransactor pattern currently lives in transaction.spec.ts; could be promoted here)
  - packages/db-core/src/transaction/session.ts, packages/db-core/src/transaction/coordinator.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (~921 NOTE: on snapshot timing)
difficulty: medium
tradeoffs: Both branches are believed correct today and session mode has no shipping host, so this buys confidence rather than fixing anything — a maintainer could defer it until a host actually depends on session mode.
----

# Build a session-mode bridge harness, and cover the two branches it unlocks

## The weakness

`TransactionBridge` (the Quereus adapter) has two modes: legacy/single-node, and **session mode**,
where a host wires a real transaction coordinator and engine so commits go through distributed
consensus. Every existing plugin test runs in legacy mode — `adapter-integration.spec.ts` never wires a
session at all — so the bridge's session-mode branches are covered only by the fact that they
type-check and that a layer *below* them (db-core) is well tested.

That is the root cause of both findings below: there is no plugin-level harness that stands the bridge
up in session mode with a real coordinator. Build that harness once (the `enableSessionMode` helper in
`session-mode-commit.spec.ts` is the seed), and both gaps close against it. Neither is a known defect.

## Arm A — the partial-commit catch branch

When a session-mode transaction touches several collections (a main table plus its index collections)
and one collection's commit fails *permanently* while another already committed durably,
`TransactionCoordinator.commit()` throws `CoordinatorPartialCommitError`. The bridge's
`commitTransaction` catches this and, unlike a clean failure, tears down transaction state **without**
calling `rollbackTransaction()` — a clean restore would re-stage the already-durable collection's
actions as pending and cement a memory/storage divergence.

That branch (`txn-bridge.ts` ~346-362) has no direct test. It is covered only by the plugin build and
by being a near-exact mirror of the legacy `PartialCommitError` branch just above it, which *is* tested
by `legacy-commit-atomicity.spec.ts`. The db-core layer beneath it (the coordinator's partial-commit
split) is thoroughly tested in `db-core/test/transaction.spec.ts`. So the risk is low today — but if the
bridge branch's teardown drifts from what a real partial commit needs, nothing catches it.

What to assert, driving a **real** session-mode partial commit through the vtab with an indexed table
so the commit spans the main collection plus at least one index collection, and a transactor wrapper
that makes exactly one collection's `commit()` return a permanent `{ success: false }` (a stale loss)
while the others commit durably — identify the poison collection at PEND time via the inserted block
header's `collectionId`, mirroring `SelectiveCommitFailTransactor`:

- the commit rejects with `CoordinatorPartialCommitError` (naming committed vs failed),
- `rollbackTransaction()` is **not** invoked (spy, or assert the durably-committed collection's rows
  are still readable — a rollback would have re-staged them),
- the bridge tears down transaction state (`isActive === false`, `session === null`,
  savepoints/dirtyTrees cleared) so the connection is not left with a stuck transaction.

**Note (added by the review of `debt-competing-writer-test-transactor`):** the transactor wrapper
this arm needs no longer has to be hand-rolled. `packages/db-core/src/testing/test-transactor.ts`
now exports `DelegatingTransactor`, an abstract base that forwards the whole transactor surface —
including the optional `queryClusterNominees`, which every hand-rolled wrapper in the repo was
silently dropping — so a wrapper only overrides the one call it intercepts. Extend it rather than
writing the delegation by hand, and if `SelectiveCommitFailTransactor` is promoted out of
`transaction.spec.ts` as this ticket's `files:` list suggests, promote it as a subclass of it.

## Arm B — statement recording and rollback ordering through the session

A recently-fixed bug: the bridge's `addStatement` used to fire `session.execute(statement, [])` without
awaiting it, so a statement could be missing from the replicated transaction record other nodes replay.
The fix (await the call, throw on failure) is covered — but only at the **db-core session layer**
(`transaction.spec.ts`, describe *"Statement recording (addStatement fire-and-forget regression)"*).
Those tests pin the session contract the fix relies on; they do not exercise the actual defect, which
lived one layer up in the bridge.

What to assert, on the same harness (a real `TransactionCoordinator` built from the bridge's own
`getCollectionRegistry()` map, a real engine, and `configureTransactionMode(...)`):

- driving real DML through `update()` so `addStatement` forwards to the session, the record compiled by
  `session.commit()` contains **all** issued statements in order — assert the session's own
  `getStatements()` / the committed record, not just the bridge's `accumulatedStatements` mirror. This
  is the exact property the bug violated: statement count == number of DML statements issued.
- the original race is reproduced: make the coordinator's **first** `applyActions` slow (as the db-core
  test does) and confirm no statement is dropped — proving the guard holds at the bridge, not just at
  the session.
- rollback ordering: issue DML, then roll back, and assert the staged rows are actually reverted. This
  exercises the snapshot-timing invariant (the first `addStatement` per transaction is what makes
  `coordinator.applyActions` snapshot **pre-stage** tracker state — see the `NOTE:` at
  `optimystic-module.ts` ~921). A future refactor that stages before recording would silently break
  this; currently only the `await` at that call site enforces it, untested.

## Notes / non-goals

- Both shipped fixes are correct and green; the gap is that each regression is pinned one layer below
  where it occurred.
- The 3-node mesh DML suite already passes, which is suggestive coverage, but it does not assert
  statement-count == DML-count under adversarial apply timing, nor isolate the bridge forwarding path.
- Also unaudited (fold in if cheap, else leave): whether a `throw` from `addStatement` mid-DML reliably
  propagates to `rollbackTransaction`. In practice the throw only fires on an already
  committed/rolled-back session (empty actions never raise "collection not found"), so it is close to
  unreachable in normal operation — low priority.
- Related but distinct: `debt-optimystic-session-mode-statement-savepoint-gap` is a real latent defect
  in the same mode, not test debt. This harness is what its regressions would be written against.

Merged from `debt-bridge-partial-commit-branch-test` (Arm A) and
`debt-session-mode-bridge-statement-recording-test` (Arm B) during backlog gardening.
