description: A change statement is recorded into the replicated transaction record without waiting for it to actually be recorded, so a statement can go missing from the record other nodes replay — causing undetected data divergence between nodes.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transaction/session.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/test/transaction.spec.ts
difficulty: medium
----

## Bug (confirmed)

`OptimysticTxnBridge.addStatement` (`txn-bridge.ts:364-380`) does
`void this.session.execute(statement, [])` and returns immediately. The comment
claims "statement tracking is synchronous" — it is not.

`TransactionSession.execute` (`db-core/src/transaction/session.ts:69-110`)
`await`s `coordinator.applyActions(...)` **before** pushing the statement onto
`this.statements` (line 98 then line 101). The `void` discards that promise.

`session.statements` is the source of truth the record is compiled from
(`session.commit` → `session.ts:132-137` reads `this.statements`). So:

- If the fire-and-forget microtask has not resolved when the transaction record
  is finalized at commit, the statement is **silently absent** from the record
  that validator peers re-execute → they replay a *different* operation set.
  Best case the state hashes diverge and it's caught; worst case divergence goes
  undetected.
- A rejection inside `execute` (it returns `{success:false,error}`; it can also
  throw) is swallowed by the `void`.

Note there are two separate statement arrays — don't confuse them:
- `txnBridge.accumulatedStatements` (`txn-bridge.ts:369`) — a local mirror,
  pushed synchronously, exposed via `getStatements()`. **Not** what the record
  is built from.
- `session.statements` (db-core) — the array `session.commit()` compiles into the
  replicated `Transaction`. **This** is the one that can miss a statement.

## Extra finding — do NOT naively skip `applyActions`

The ticket's suggested "add a synchronous `recordStatement` that skips the async
`applyActions` round-trip" has a trap. That fire-and-forget `session.execute`
with empty actions is currently the **only** call that reaches
`coordinator.applyActions` on the vtab DML path (the vtab stages rows directly
via `collection.stage`/`collection.act`, never through the engine). And
`applyActions` creates the per-transaction rollback snapshot on its first call
for a `stampId` (`coordinator.ts:59-70`).

Session-mode rollback depends on that snapshot:
`bridge.rollbackTransaction` → `session.rollback()` → `coordinator.rollback(stampId)`,
which is a no-op when no snapshot exists (`coordinator.ts:222-224`, `if (!data) return`).
The rollback code explicitly documents that "the coordinator owns" tracker
restore in session mode (`txn-bridge.ts:271-290`).

So a `recordStatement` that only pushes the statement and skips `applyActions`
would **silently break session-mode rollback** (constraint-failure atomicity,
etc.). Any fix that drops the `applyActions` call must recreate the snapshot
another way.

There is a second, pre-existing latent issue this fixes for free: because the
snapshot is created inside a fire-and-forget call, its timing relative to the
subsequent `collection.stage` (`optimystic-module.ts:960+`) is currently
non-deterministic — the snapshot can capture post-stage state, corrupting
rollback. Making recording synchronous/ordered before staging removes that race.

## Recommended fix — Option A (await), preferred

Make recording awaited rather than fire-and-forget. This preserves the
`applyActions` snapshot side-effect (rollback keeps working) **and** makes its
timing deterministic, records the statement in order, and propagates failure.

- `txn-bridge.ts`: change `addStatement(statement: string): void` to
  `async addStatement(statement: string): Promise<void>`. Replace the `void`
  call with:
  ```ts
  const result = await this.session.execute(statement, []);
  if (!result.success) {
    throw new Error(`Failed to record statement in transaction: ${result.error}`);
  }
  ```
  Update the misleading comment (lines 371-378).
- `optimystic-module.ts:918`: `await this.txnBridge.addStatement(mutationStatement);`
  This line sits at 916-919, **before** the `try`/`switch` and before any
  `collection.stage` — awaiting it keeps recording strictly before staging
  (ordering the ticket requires), and a throw here fails the DML before it can
  commit a record missing a statement. `update` is already `async`.
- `addStatement` is the only caller of concern (grep confirms sole call site at
  `optimystic-module.ts:918`).

## Alternative — Option B (`session.recordStatement`), only if Option A rejected

Add `recordStatement(statement: string): void` to `TransactionSession` that
guards `committed`/`rolledBack` (throw on violation) and pushes to
`this.statements` synchronously — **and** ensure the coordinator snapshot still
gets created for the vtab path (e.g. call `coordinator.applyActions([], stampId)`
once per transaction, or add an explicit `coordinator.ensureSnapshot(stampId)`).
This is more surface area than Option A for no real gain, since Option A's only
"round-trip" cost is the empty-actions apply we still need for the snapshot.
Prefer Option A unless a concrete reason emerges.

## Edge cases to cover

- Multi-statement transaction where an early statement's async apply is slow —
  all statements must be present in the record at commit.
- A statement whose `execute` rejects/returns `{success:false}` — must surface as
  a failed DML, not vanish.
- Rollback still works after the change (session-mode constraint-failure
  rollback restores trackers) — this is the regression risk; test it.
- Ordering vs `collection.stage`: recording stays before staging.

## TODO

- [ ] `txn-bridge.ts`: make `addStatement` async; await `session.execute`, throw
      on `!result.success`; fix the stale "synchronous" comment.
- [ ] `optimystic-module.ts:918`: `await` the `addStatement` call.
- [ ] Add a test in `packages/db-core/test/transaction.spec.ts` (has
      `TransactionSession`, `TransactionCoordinator`, `TestTransactor`,
      `ActionsEngine` wiring already) asserting: after N `await session.execute`
      calls, `session.getStatements()` contains all N in order; and a failing
      `execute` surfaces an error rather than dropping the statement. If a
      bridge-level test is feasible, assert the compiled record's statement count
      equals the DML count under a slow-apply collection.
- [ ] Verify rollback still restores trackers in session mode (add/confirm a
      rollback test path).
- [ ] Build + test: from `packages/db-core` run `yarn build` then `yarn test`
      (stream: `yarn test 2>&1 | tee /tmp/dbcore-test.log`). Also build
      `packages/quereus-plugin-optimystic`.
