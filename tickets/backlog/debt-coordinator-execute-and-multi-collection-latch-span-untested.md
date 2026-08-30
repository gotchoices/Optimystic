description: There are two places in the code where a transaction locks the data collections it is writing to for the duration of a commit. Only one of them has a test that proves the lock actually works; the other has none, and neither is tested with more than one collection at a time.
files:
  - packages/db-core/src/transaction/coordinator.ts (the untested lock span in `execute`, ~639-733; the tested one in `commitOnce`, ~262-279)
  - packages/db-core/test/coordinator-latch-interleaving.spec.ts (the existing test — the template to extend)
  - packages/db-core/src/collection/collection.ts (`acquireLatch`, `update`, `act`, `recordCommitted`)
  - packages/db-core/src/testing/test-transactor.ts (`DelegatingTransactor` — base for the gated wrappers the existing test builds on)
difficulty: medium
tradeoffs: The uncovered path is believed correct and was written alongside the covered one by the same change, so this buys proof rather than fixing a known defect — a maintainer could reasonably decide the covered path is representative enough and spend the effort elsewhere.
----

# Prove the commit-time collection lock on the second code path, and with more than one collection

## Background, in plain terms

When a transaction commits, it writes to one or more *collections* (a collection is one logical
set of data — a table, an index). While that commit is in flight, nothing else in the same
process is allowed to refresh those collections from storage: a refresh landing mid-commit used
to leave the collection's local revision counter permanently out of step with what storage
actually recorded, after which every later read silently served stale data and reported an error
nobody acted on.

The fix was to have the commit take a lock on each collection it is writing to, and hold it for
the whole commit. `packages/db-core/test/coordinator-latch-interleaving.spec.ts` proves that
works — it deliberately freezes a commit halfway through, fires a refresh into the frozen
instant, and checks the refresh is made to wait.

## The gap

That proof covers **one** of the two places that take these locks, and covers it with **one**
collection. Three things are consequently unproven:

**Arm 1 — the second code path is untested.** `TransactionCoordinator.execute` takes the same
locks over the same span as the tested path, but with an extra wrinkle that the tested path does
not have: it can only take them *after* it has applied the transaction's actions, because
applying an action itself takes the very same lock and the lock is non-reentrant (taking it twice
from the same call chain deadlocks). It also has to remove duplicate collections from its list
before locking, for the same reason, and it has several early-return failure paths that must all
release. None of that ordering is exercised by a test. A future edit that moves the lock
acquisition earlier, or drops the de-duplication, would deadlock at runtime and no test would say
so.

**Arm 2 — no test uses more than one collection.** Both paths sort the collections by id before
locking them, so that two commits touching an overlapping set of collections can never take the
locks in opposite orders and deadlock against each other. With a single collection there is no
order to get wrong, so the sort is currently decoration as far as the tests are concerned. Two
concurrent commits over overlapping collections is the case that would break if someone removed
the sort.

**Arm 3 — the release path is only proven on success.** Both paths release their locks in a
`finally`, but no test drives a *failing* commit through the locked span and then shows the
collection is still usable afterwards. A leaked lock is silent: the next operation on that
collection simply never returns.

## What "done" looks like

Extend the existing spec (or add a sibling next to it) so that:

- A commit driven through `execute` is frozen mid-flight the same way the existing cases freeze
  the other path, a refresh is released into the frozen instant, and the refresh is shown to
  wait — plus the commit is shown to complete rather than deadlock against its own action-apply
  lock.
- Two commits whose collection sets overlap are started concurrently and both complete. This
  should fail if the sorting is removed, so the test is worth writing only if it does — check
  that before calling it done.
- A commit that fails inside the locked span leaves every collection immediately usable
  afterward (a following refresh completes rather than hanging).

The existing spec's gated-transactor wrappers, which sit on `DelegatingTransactor`, are the right
starting point; if a second spec file needs them, promote them into
`packages/db-core/src/testing/` rather than copying them.

## Why this is one ticket and not three

All three arms are the same claim about the same two blocks of code — that the commit-time
collection lock is taken over the whole span, in a safe order, and always released. They share a
test file and a set of helpers, and splitting them would mean building the same freeze-a-commit
harness three times.
