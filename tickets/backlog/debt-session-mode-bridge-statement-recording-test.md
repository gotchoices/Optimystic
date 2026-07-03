description: Add an end-to-end test that drives the Optimystic transaction bridge in its real distributed-consensus mode and confirms every SQL statement in a transaction actually lands in the committed record and that a mid-transaction failure rolls back cleanly.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transaction/session.ts, packages/db-core/src/transaction/coordinator.ts, packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
difficulty: medium
----

## Why this exists

A recently-fixed bug: the bridge's `addStatement` used to fire
`session.execute(statement, [])` without awaiting it, so a statement could be
missing from the replicated transaction record other nodes replay. The fix
(await the call, throw on failure) is covered by new tests — but only at the
**db-core session layer** (`transaction.spec.ts`, describe *"Statement recording
(addStatement fire-and-forget regression)"*). Those tests pin the session
contract the fix relies on; they do **not** exercise the actual defect, which
lived one layer up in the *bridge*.

The bridge's existing tests (`adapter-integration.spec.ts`) all run in **legacy
mode** (no session wired), so they never touch the session-forwarding path at
all. There is currently **no test** that:

1. wires the bridge into session mode (`configureTransactionMode` + a coordinator
   built from `getCollectionRegistry()`),
2. drives real DML through `update()` so `addStatement` forwards to the session,
3. asserts the compiled record's statement count == the number of DML statements
   issued — the exact property the bug violated.

## What to build

A session-mode bridge integration test (in
`packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts`, or a new
sibling spec) that:

- Stands up a session-mode bridge: a real `TransactionCoordinator` constructed
  from the bridge's own `getCollectionRegistry()` map, a real engine, and
  `configureTransactionMode(...)`.
- Runs a multi-statement transaction end-to-end and asserts the record compiled
  by `session.commit()` contains **all** issued statements in order (not just the
  bridge's `accumulatedStatements` mirror — assert the session's own
  `getStatements()` / the committed record).
- Reproduces the original race: make the coordinator's **first**
  `applyActions` slow (as the db-core test does) and confirm no statement is
  dropped — proving the guard holds at the bridge, not just the session.
- Covers rollback ordering: issue DML, then roll back, and assert the staged rows
  are actually reverted. This exercises the snapshot-timing invariant (the first
  `addStatement` per transaction is what makes `coordinator.applyActions` snapshot
  **pre-stage** tracker state — see the `NOTE:` at `optimystic-module.ts` ~921).
  A future refactor that stages before recording would silently break this;
  currently only the `await` at that call site enforces it, untested.

## Notes / non-goals

- This is **test debt, not a defect** — the shipped fix is correct and green. The
  gap is that the regression is pinned one layer below where it occurred.
- The 3-node mesh DML suite already passes, which is suggestive coverage, but it
  does not directly assert statement-count == DML-count under adversarial apply
  timing, nor isolate the bridge forwarding path.
- Also unaudited (fold into this test if cheap, else leave as-is): whether a
  `throw` from `addStatement` mid-DML reliably propagates to
  `rollbackTransaction`. In practice the throw only fires on an already
  committed/rolled-back session (empty actions never raise "collection not
  found"), so it is close to unreachable in normal operation — low priority.
