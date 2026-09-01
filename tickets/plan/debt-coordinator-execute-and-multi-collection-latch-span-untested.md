description: When a transaction commits, it locks each data collection it is writing to so nothing else can refresh that collection mid-commit. Only one of the two places that take this lock has a test proving it works, and neither is tested with more than one collection or with a commit that fails.
files:
  - packages/db-core/src/transaction/coordinator.ts (untested lock span in `execute`, ~669-751; tested one in `commitOnce`, ~282-300)
  - packages/db-core/test/coordinator-latch-interleaving.spec.ts (the existing test — template to extend)
  - packages/db-core/src/collection/collection.ts (`acquireLatch`, `update`, `act`, `recordCommitted`)
  - packages/db-core/src/testing/test-transactor.ts (`DelegatingTransactor`, `TestTransactor` — base for the gated wrappers)
difficulty: medium
----

# Prove the commit-time collection lock on the second code path, and with more than one collection

## Background, in plain terms

A *collection* here is one logical set of data — a table or an index — held as a local object
(`Collection` in `packages/db-core/src/collection/collection.ts`) over shared storage.

When a transaction commits, it writes to one or more collections. While that commit is in flight,
nothing else in the same process may refresh those collections from storage. A refresh landing
mid-commit used to leave the collection's local revision counter permanently one step ahead of
what storage actually recorded; after that, every later read silently served stale data and
logged an error (`collection:context-not-lowered`) that nobody acted on.

The fix: the commit takes a lock (`Collection.acquireLatch()`) on each collection it writes to
and holds it for the whole commit span — log append, the pend/commit round trips with the
network, and the local fold afterward. `packages/db-core/test/coordinator-latch-interleaving.spec.ts`
proves that works for one of the two code paths: it freezes a commit halfway through, fires a
refresh into the frozen instant, and asserts the refresh is still pending (i.e. queued behind the
lock) rather than having run to completion.

## The gap

The existing spec covers **one** of the two lock sites, with **one** collection, on the
**success** path. Three things are consequently unproven.

### Arm 1 — the second code path (`execute`) is untested

`TransactionCoordinator.execute` (`coordinator.ts:600`) takes the same locks over the same span
as the tested `commitOnce`, but with an extra ordering constraint that `commitOnce` does not have:

- The lock is **non-reentrant**. Taking it twice from the same call chain deadlocks.
- `execute` applies the transaction's actions first (`applyActions`), and applying an action
  takes that very same lock internally. So `execute` can only acquire its span locks *after* the
  apply step. Acquiring earlier deadlocks against itself.
- `execute` must also de-duplicate its collection list before locking — the action list can name
  the same collection twice, and taking one instance's lock twice deadlocks for the same reason.
- `execute` has several early-return failure paths inside the locked span, all of which must
  release.

None of that ordering is exercised. A future edit that hoists the acquisition above
`applyActions`, or drops the de-duplication, would deadlock at runtime and no test would say so.

### Arm 2 — no test uses more than one collection

Both paths sort collections by id before locking, so that two commits over overlapping collection
sets can never take the locks in opposite orders and deadlock against each other. With a single
collection there is no order to get wrong, so today the sort is decoration as far as the tests are
concerned. The case that would break if someone removed the sort is two concurrent commits over
overlapping collection sets.

### Arm 3 — the release path is only proven on success

Both paths release in a `finally`, but no test drives a *failing* commit through the locked span
and then shows the collection is still usable. A leaked lock is silent: the next operation on
that collection simply never returns.

## What "done" looks like

Extend the existing spec, or add a sibling next to it, so that:

- A commit driven through `execute` is frozen mid-flight the same way the existing cases freeze
  `commitOnce`, a refresh is released into the frozen instant, and that refresh is shown to still
  be pending — *and* the commit is shown to complete rather than deadlock against its own
  action-apply lock.
- Two commits whose collection sets overlap are started concurrently and both complete. **This
  test only earns its place if it fails when the sort is removed** — verify that by temporarily
  reverting the sort locally before calling the arm done. If it cannot be made to fail, say so in
  the handoff rather than shipping a test that proves nothing.
- A commit that fails inside the locked span leaves every participating collection immediately
  usable afterward: a following refresh completes rather than hanging.

## Notes for whoever designs this

- The existing spec's gated-transactor wrappers (`GatedCommitTransactor`, `GatedPendTransactor`,
  both extending `DelegatingTransactor`) are the right freeze mechanism — they park a `pend` or
  `commit` call and expose a gate to release it. If a second spec file needs them, promote them
  into `packages/db-core/src/testing/` rather than copying.
- `releaseRefresh` + `drainMacrotasks` in that spec are what give "the refresh was blocked" its
  teeth: the refresh must be checked still-pending after N macrotask turns, where an *unlatched*
  refresh would have completed. Read the `drainMacrotasks` doc comment before reusing it — the
  turn count is load-bearing, not arbitrary.
- `execute` takes an `ITransactionEngine`. The tests will need a stub engine that returns
  `CollectionActions` without applying them (the pure-translator contract `execute` documents at
  `coordinator.ts:627`), since `execute` itself owns application.
- Test command: `yarn test` from `packages/db-core`, or `yarn test -- --grep "<pattern>"` to
  narrow.

## Why this is one ticket and not three

All three arms are the same claim about the same two blocks of code — that the commit-time
collection lock is taken over the whole span, in a safe order, and always released. They share a
test file and a set of helpers; splitting them would mean building the same freeze-a-commit
harness three times.
