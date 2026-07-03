description: A change statement was recorded into the replicated transaction record without waiting for the recording to finish, so a statement could go missing from the record other nodes replay — causing undetected data divergence. Now fixed by awaiting the recording.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transaction/session.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/test/transaction.spec.ts, packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
difficulty: medium
----

## What the bug was

`OptimysticTxnBridge.addStatement` fired `void this.session.execute(statement, [])`
and returned immediately, on a false "statement tracking is synchronous" comment.

`TransactionSession.execute` pushes the statement onto `this.statements` **only
after** awaiting `coordinator.applyActions(...)`. `this.statements` is the array
`session.commit()` compiles into the replicated `Transaction` record that
validator peers re-execute. So the un-awaited microtask could still be pending
when the record was finalised at commit → the statement was silently absent from
the record → peers replay a different operation set (divergent state hash at
best, undetected divergence at worst). A `{success:false}` / throw inside
`execute` was also swallowed by the `void`.

Two distinct arrays — don't confuse them (both verified in the fix):
- `txnBridge.accumulatedStatements` — synchronous local mirror, `getStatements()`. Never at risk.
- `session.statements` (db-core) — what `commit()` compiles into the record. This was the one that could miss a statement.

## The fix (Option A from the ticket — await, not skip)

Chose **await** over a synchronous `recordStatement` that skips `applyActions`,
because that empty-actions apply is the **only** call reaching
`coordinator.applyActions` on the vtab DML path, and its first call per stamp
creates the per-transaction rollback snapshot session-mode rollback depends on
(`coordinator.ts:59-70`, consumed by `rollback` at `coordinator.ts:222-224`).
Skipping it would silently break constraint-failure rollback. Awaiting keeps that
snapshot **and** makes its timing deterministic (captured before the subsequent
`collection.stage`).

Changes:
- `txn-bridge.ts` — `addStatement(statement): void` → `async addStatement(statement): Promise<void>`;
  `await this.session.execute(...)`; `throw` on `!result.success`; replaced the
  stale "synchronous" comment with the real ordering/snapshot rationale.
- `optimystic-module.ts:~917` — `await this.txnBridge.addStatement(mutationStatement)`.
  This sits before the `try`/`switch` and before any `collection.stage`, so
  recording stays strictly before staging and a throw aborts the DML before it
  can commit a record missing a statement. `update` is already `async`.
- `adapter-integration.spec.ts` — the six existing `bridge.addStatement(...)`
  call sites are now `await`ed (one `it` promoted to `async`). These run in
  **legacy mode** (no session), so they never exercised the session-forwarding
  path; they still pass because `accumulatedStatements.push` is synchronous.

## How to validate / what was run

- `packages/db-core`: `yarn build` (clean) + `yarn test` → **1139 passing, 0 failing**.
- `packages/quereus-plugin-optimystic`: `yarn build` (regenerates the `dist`
  `.d.ts` the adapter test imports), `yarn typecheck` (clean), `yarn test` →
  **256 passing, 11 pending, 0 failing** (incl. the full 3-node mesh DML suite).

New db-core tests (`transaction.spec.ts`, describe *"Statement recording
(addStatement fire-and-forget regression)"*) pin the session-side contract the
bridge fix relies on:
1. after N awaited `session.execute(stmt, [])`, `getStatements()` == all N, in order;
2. same holds when the **first** apply is artificially slow (the exact timing that
   dropped a statement under the old fire-and-forget path);
3. a failing `execute` (actions → unregistered collection) returns
   `{success:false}` and does **not** record the statement.

Existing rollback coverage still green: *"Transaction Rollback (TEST-2.1.1)"*
(session-mode tracker restore across single + multi collection) — the regression
risk the ticket flagged. Passing confirms the `applyActions` snapshot side-effect
survived the change.

## Honest gaps for the reviewer (your tests are a floor)

- **No end-to-end bridge-level reproduction.** The deterministic regression tests
  live at the db-core session layer. The original defect was the *bridge*
  fire-and-forgetting `session.execute`; the session itself was always correct
  (it awaits `applyActions` before pushing). Reproducing the drop end-to-end would
  need a session-mode-wired bridge (`configureTransactionMode` + a coordinator
  built from `getCollectionRegistry()`) driving `addStatement` against a
  slow-apply coordinator, then asserting the compiled record's statement count ==
  DML count. That harness does not exist here — the existing adapter tests run in
  legacy mode. **Worth a reviewer eye:** decide whether a session-mode bridge
  integration test is warranted, or whether the session-layer guarantee + the
  awaited call site is sufficient coverage.
- **No new test asserts the pre-stage snapshot ordering at the bridge.** The
  "recording before `collection.stage`" invariant is now enforced only by the
  `await` at the module call site and documented in the inline comment there. A
  future refactor that reorders staging above `addStatement` would reopen the
  non-deterministic-snapshot race the ticket mentions. No test guards that
  ordering directly (see findings index below).
- **`commitTransaction` error path unchanged.** If `addStatement` now throws
  mid-DML, the throw propagates out of `update()`; I did not audit every Quereus
  xUpdate caller to confirm a thrown DML consistently triggers
  `rollbackTransaction`. Existing constraint-rejection tests pass, which is
  suggestive but not exhaustive.

## Review findings (index — analysis lives at the sites above)

- Ordering invariant "record before stage" is enforced by the `await` at
  `optimystic-module.ts:~917` and explained in the inline comment there; not
  covered by a dedicated test. Flagged above under *Honest gaps*.
- End-to-end bridge session-mode forwarding of `addStatement` → session record
  has no test; only the session-layer contract is pinned. Flagged above.
