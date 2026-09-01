description: One way of running a transaction reports an error even though the write succeeded, whenever a single transaction touches the same data collection twice. Nothing in the shipped product uses that entry point today, so it is a latent problem rather than a live one.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute`, line 600 — the post-commit fold loops at the partial-commit branch and the success branch)
  - packages/db-core/src/collection/collection.ts (`recordCommitted`, line 819 — where it throws)
repro: verified
severity: corruption
likelihood: contrived
tradeoffs: The entry point has no production caller (everything real goes through `applyActions` plus `commit`), so a maintainer may reasonably decide the honest fix is to delete or narrow the method rather than harden it.
----

# `TransactionCoordinator.execute` throws after a successful commit when one collection appears twice

## What happens

`TransactionCoordinator.execute` takes a list of per-collection action batches. Nothing stops two
batches in one transaction from naming the **same** collection — with the built-in `ActionsEngine`,
that is just a transaction with two statements against one table.

In that case the transaction commits **correctly and durably** — verified: both actions land, at
one revision, readable from a freshly opened handle over the same storage — and then `execute`
**throws** instead of returning its success result:

    Collection a: action tx:… was pended at rev 1 but the collection now expects rev 2
    — the collection was refreshed mid-commit

The error message is misleading: nothing refreshed mid-commit. The commit-time lock is held
correctly throughout (it de-duplicates before locking, so it takes exactly one lock — verified).

## Why

After the commit lands, `execute` folds the result back into local state by looping over the
engine's returned action batches rather than over the **distinct** collections in them. With two
batches naming one collection, the loop body runs twice against that one collection:

- iteration 1 records the committed revision and resets the collection's staged changes;
- iteration 2 calls the same record step again with the same revision, which is now one behind what
  the collection expects, and it throws.

The same shape exists in the partial-commit branch just above it.

## Why it matters even though it throws late

The caller is told the transaction failed when it actually succeeded. The realistic follow-up to
that error is a rollback, and a rollback restores the collection's staged changes from the
pre-transaction snapshot — re-staging work that is already durable, so the next commit appends it a
second time. That rollback consequence is inferred from reading `rollback`, not observed; the
throw itself and the durable-but-reported-as-error outcome were both run and confirmed.

Two smaller consequences: the returned action results are lost, and the coordinator's
per-transaction rollback snapshot for that stamp is never cleaned up (the cleanup line sits after
the throwing loop).

## Why it is filed as latent, not as a live bug

No shipped code path calls `TransactionCoordinator.execute`. `TransactionSession` applies actions
and then commits through the other code path; the query-engine plugin stages rows through the
virtual table and returns no actions; the validator re-executes through the engine, not through
this method. Only tests drive `execute` today. So this is wrong the moment the path is used, but it
is not reaching users now.

## What "fixed" would look like

The fold loops should run once per distinct collection, matching the de-duplication the lock
acquisition already does a few lines above. Worth checking at the same time whether applying two
batches to one collection should coalesce into a single log entry before the append, rather than
appending twice and relying on both appends landing at one revision.

A test exists nearby: `packages/db-core/test/coordinator-latch-span.spec.ts` (added by
`debt-coordinator-execute-and-multi-collection-latch-span-untested`) drives exactly this shape to
prove the lock de-duplication, and deliberately does not assert the outcome. That case is the
natural place to add the success assertion once this is fixed.

An honest alternative to fixing it: if `execute` is dead weight, delete it and its tests rather
than hardening an entry point nobody calls.
