description: One way of running a transaction reports an error even though the write succeeded, whenever a single transaction touches the same data collection twice. Nothing shipped uses that entry point today, so decide whether to harden it or remove it, then do that.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` — the pre-commit apply loop at line ~688, the partial-commit fold at line ~731, the success fold at line ~756)
  - packages/db-core/src/collection/collection.ts (`recordCommitted`, line 819 — where it throws; `getNextRev`, line 803)
  - packages/db-core/test/coordinator-latch-span.spec.ts (the duplicate-collection case at line ~206, which deliberately asserts nothing about the outcome)
difficulty: medium
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

The error message is misleading: nothing refreshed mid-commit. The commit-time latch is held
correctly throughout (it de-duplicates before latching, so it takes exactly one latch — verified).

## Why

After the commit lands, `execute` folds the result back into local state by looping over the
engine's returned action batches rather than over the **distinct** collections in them. With two
batches naming one collection, the loop body runs twice against that one collection:

- iteration 1 calls `recordCommitted`, which advances the collection's revision, then resets its
  staged changes;
- iteration 2 calls `recordCommitted` again with the same revision, which is now one behind what
  the collection expects, and it throws.

The same shape exists in the partial-commit branch just above it (the `!coordResult.success` fold).

## Why it matters even though it throws late

The caller is told the transaction failed when it actually succeeded. The realistic follow-up to
that error is a rollback, and a rollback restores the collection's staged changes from the
pre-transaction snapshot — re-staging work that is already durable, so the next commit appends it a
second time. That rollback consequence is inferred from reading `rollback`, not observed; the
throw itself and the durable-but-reported-as-error outcome were both run and confirmed.

Two smaller consequences: the returned action results are lost, and the coordinator's
per-transaction rollback snapshot for that stamp is never cleaned up (the `stampData.delete` line
sits after the throwing loop).

## Why it is filed as latent, not as a live bug

No shipped code path calls `TransactionCoordinator.execute`. `TransactionSession` applies actions
and then commits through the other code path; the query-engine plugin stages rows through the
virtual table and returns no actions; the validator re-executes through the engine, not through
this method. Only tests drive `execute` today. So this is wrong the moment the path is used, but it
is not reaching users now.

## The decision this ticket has to settle first

Two honest outcomes, and the plan should pick one rather than assume:

**A — harden it.** Make the fold loops run once per distinct collection, matching the
de-duplication the latch acquisition already does a few lines above. Small and low risk. Choose
this if `execute` is still the intended entry point for an externally-driven, pure-translator
engine (the doc comment on it says it is called "with a complete transaction, e.g. from Quereus").

**B — delete it.** If `execute` is dead weight kept alive only by its own tests, removing it and
them is more honest than hardening an entry point nobody calls. Note this also removes the
`execute` cases from `coordinator-latch-span.spec.ts`, which currently document real latch-ordering
constraints — check nothing else relies on that documentation before deleting.

Recommendation: **A**. It is a few lines, it keeps the latch-span coverage, and the plugin's
translator-style engine is a plausible near-term caller.

## Additional defects on the same path, if A is chosen

Found while confirming this ticket; they live at the same site and should be settled in the same
plan rather than filed separately:

- **The pre-commit apply loop also runs per batch, not per collection.** `applyActionsToCollection`
  is called once per batch, and each call appends its own log entry stamped with
  `collection.getNextRev()`. Because the revision only advances at `recordCommitted`, both entries
  are stamped with the *same* revision. Decide whether two log entries at one revision is a state
  the log and the sync path are meant to accept, or whether the batches for one collection should
  be coalesced into a single log entry before the append.
- **Per-collection result and metadata maps are overwritten, not merged.** `actionResults`,
  `collectionTransforms` and `criticalBlocks` are all keyed by collection id, so the second batch's
  `set` discards the first batch's entry. For `collectionTransforms` and `criticalBlocks` that is
  harmless (both are read live from the tracker and reflect the accumulated state), but the first
  batch's **action results are genuinely lost** — so even with the fold fixed, `execute` would
  return an incomplete `results` map. Results for one collection need concatenating across batches.

## What "done" looks like

Whichever branch is chosen, the duplicate-collection case in `coordinator-latch-span.spec.ts`
should stop being outcome-agnostic: under A it asserts `execute` succeeds and returns results for
both actions; under B it goes away with the method. That test was added by
`debt-coordinator-execute-and-multi-collection-latch-span-untested` and drives exactly this shape
already, so it is the natural home for the assertion.

There is a `NOTE:` at the success fold in `coordinator.ts` pointing at this ticket by slug; remove
or update it as part of the work.
