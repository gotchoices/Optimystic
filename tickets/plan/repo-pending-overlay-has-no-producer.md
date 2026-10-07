description: The decision to start using the "read my own unfinished change" request assumed it would let a doomed transaction be abandoned early. Research found nothing in the system that reads between storing a change and finalising it, and that every early-abort signal is already available without that request. The maintainer needs to choose again with those facts.
prereq:
architecture: docs/correctness.md#theorem-3-multi-collection-atomicity-of-intent-eventual-reported-visibility
files: packages/db-core/src/collection/action.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/src/storage/storage-repo.ts, docs/correctness.md, docs/transactions.md, tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md, tickets/backlog/feat-cross-collection-atomic-commit.md
----

# Should anything set the pending-overlay field, given that it cannot short-circuit a failure?

**Decided (maintainer, 2026-10-07): the recommended default.** Keep the field with no producer, reserve it for long-lived pend, and turn the `TODO` into a `NOTE:`. No early-abort check is wanted.

The storage-side fix this work required ships regardless: a read naming a pending change now answers per block and never fails the batch (`implement/pending-overlay-read-answers-every-block`). This ticket covers only the producer question.

## What was decided, and why it needs another look

A write is stored first as a **pending** record on the block's cohort, then **committed**. A read can ask to see one pending change laid over committed content, through `ActionContext.actionId` (`packages/db-core/src/collection/action.ts`). Nothing sets that field. On 2026-10-04 the maintainer chose to "finish wiring it. That can short-circuit an inevitable transaction failure", and rejected both removing the field and deferring the work.

The plan stage checked that premise against the code. It does not hold, for three separate reasons.

1. **No code reads between the pend and the commit.** Both client write paths send the commit as soon as the pend returns:
   - `TransactorSource.transact`, used by `Collection.sync`;
   - `TransactionCoordinator.coordinateTransaction`, which runs `pendPhase` and then `commitPhase`, used by session mode and by the Quereus legacy multi-tree commit.

   `TransactionSession` stages statements locally and pends only at `commit()`. So no read exists to add the field to. A producer would mean *adding* a read: a new round trip on every write that uses it.
2. **The validator does not need it.** A validator re-executes the transaction's statements against committed state in an isolated coordinator (`TransactionValidator.validate`), and stages the transaction's own earlier statements locally as it goes. It never needs storage to show it the pending change.
3. **Every failure the overlay could reveal early is either not certain or does not need the overlay.** This is the deciding point. An overlay read asks one machine of the cohort. Go through what it can reveal:

   | what the probe sees on the machine it asked | is the commit certain to fail? | does detecting it need the overlay? |
   | --- | --- | --- |
   | the block's latest revision is at or past ours, under another action | **yes**: a revision is never un-taken (the rule behind `StaleFailure.staleAt`) | **no**: `state.latest` on a plain read says the same |
   | our pending record is not held there | **no**: a commit needs a majority, not that one machine | no: `state.pendings` on a plain read lists it |
   | the overlay materializes nothing, or different bytes from ours | **no**: that machine is behind; it refuses at apply and reconciles, and the rest of the cohort can still commit | yes, but the signal cannot justify an abort |

   The only certain signal is the first row, and a plain state read gives it.

So wiring the field anywhere would either add a round trip for a signal a plain read already provides, which leaves the field decorative, or abort on signals that are not proof. A reviewer would reject both.

## Recommended default

Keep the field and the corrected storage-side behaviour, give it **no producer now**, and record what it is for:

- **The doc comment on `ActionContext.actionId`.** Reserve the field for *tentative reads* in the long-lived-pend design, the one design on the board that has a reader of a pending change: "a read that observes a tentative (pended, not committed) revision makes the observing transaction tentative too" (`tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md`). That ticket would be the producer, and would carry the cache rule below.
- **The `TODO` in `TransactorSource.tryGet`** ("if the state reports that there is a pending action, record this so that we are sure to update before syncing"). Replace it with a `NOTE:` tripwire. What the TODO proposes is to remember rival pendings seen at read time and refresh before the pend. That saves one doomed pend round, and only when the rival committed in between. Against that:
  - the hint goes stale, because a `CacheSource` hit never re-reads;
  - stuck records would trigger refreshes for nothing (`tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md`);
  - when the rival is still pending, the refresh achieves nothing and the pend is refused (`held`) anyway.

  The note's revisit condition: if lost pend rounds after a rival commit show up in measurements.
- **The cache rule, recorded now so the future producer inherits it.** An overlay answer must never be retained by `CacheSource` as committed content. The producer must mark it `mayRetain: false` through `describeServed`, and must record no read dependency for it. The content is not a committed revision, and its `materialized` revision describes the base under the overlay, not the content. See "Staged Edits Keep Their Base" in `docs/internals.md`.

This revisits the rejection of deferral. That is deliberate: the rejection rested on the early-abort benefit, which the findings above take away.

## Alternatives

- **A. Pre-commit check in the multi-collection coordinator.** This is the maintainer's direction, made concrete. Between `pendPhase` and `commitPhase`, and only when more than one collection takes part, read each participant's log tail. If any tail's latest revision is at or past its pended revision under another action, cancel every pend and return a clean stale loss, so the retry loop re-drives instead of half-landing. This turns some `CoordinatorPartialCommitError`s (a partial commit that cannot be rolled back) into retries. That is a real benefit; see the *permanent stale loss* in [docs/correctness.md](../../docs/correctness.md#theorem-3-multi-collection-atomicity-of-intent-eventual-reported-visibility).
  - **Cost:** one parallel read round on every multi-collection commit, to narrow a window that is rare and that the check cannot close (a rival can still land after the read). The size of the benefit is unmeasured. A cheaper variant runs the check only on re-drives (attempt > 0), where contention has already been seen.
  - **Why rejected as the default:** it uses `state.latest`, not the overlay. Setting `actionId` on that read would satisfy "the field has a producer" while carrying no information. If the maintainer wants the check anyway, the plan stage will specify it, with or without the field. Say which.
- **B. Remove the field** from `ActionContext` and the overlay branches in `StorageRepo.get` and `TestTransactor.get`. This is the smallest surface and leaves no protocol field any peer can set to no purpose. It was rejected on 2026-10-04 on the early-abort premise. It is still a reasonable call, and the long-lived-pend ticket could re-add the field with its own semantics.
- **C. Wire it into the single-collection path**, as a read of the tail after the pend and before the commit in `TransactorSource.transact`. Rejected: a single-collection commit failure is already clean (nothing durable, retried by `Collection.syncAttempts`), so there is nothing to save. The check would only add a round trip to every write.

## If nothing is done

The field stays as it is after the implement fix: correct, harmless, and with no producer. The `TODO` stays misleading.

## Reversibility

Fully reversible. No wire format, stored data or signed payload changes under any option.
