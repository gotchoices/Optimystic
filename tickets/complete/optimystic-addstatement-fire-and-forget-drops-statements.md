description: A change statement was recorded into the replicated transaction record without waiting for the recording to finish, so a statement could go missing from the record other nodes replay — causing undetected data divergence. Fixed by awaiting the recording; reviewed and confirmed correct.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transaction/session.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/test/transaction.spec.ts, packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
----

## What shipped

`OptimysticTxnBridge.addStatement` fired `void this.session.execute(statement, [])`
and returned immediately, so the statement push onto `session.statements` (the
array `session.commit()` compiles into the replicated `Transaction` record) could
still be a pending microtask when the record was finalised at commit — silently
dropping the statement from what validator peers re-execute.

The fix (implement stage, commit `d0e2395`):
- `txn-bridge.ts` — `addStatement` became `async`, now `await`s
  `session.execute(...)` and `throw`s on `!result.success`. Stale "synchronous"
  comment replaced with the real ordering/rollback-snapshot rationale.
- `optimystic-module.ts` — `update()` now `await`s `addStatement`, above the
  `try`/`switch` and every `collection.stage`, so recording strictly precedes
  staging and a recording failure aborts the DML.
- New db-core tests pin the session-side contract (order preserved, order
  preserved under a slow first apply, failure surfaces `{success:false}` without
  recording).
- Six existing bridge test call sites `await`ed (all legacy-mode).

Review stage confirmed the fix, added one greppable tripwire comment, and filed
one backlog test-debt ticket. No functional defects found.

## Review findings

**What was checked**
- Read the full implement diff (`d0e2395`) with fresh eyes before the handoff.
- Traced the data path: `addStatement` → `session.execute` → `coordinator.applyActions`
  (`session.ts:69-110`, `coordinator.ts:55-74`) and confirmed statements push
  onto `session.statements` only after the awaited apply, and that the replicated
  record is compiled from `session.statements` via `session.commit()`
  (`txn-bridge.ts:224`) — **not** from the bridge's `accumulatedStatements` mirror.
- Verified the rollback-snapshot side-effect the fix depends on: the first
  `applyActions` per stamp creates the pre-snapshot (`coordinator.ts:59-70`)
  consumed by `rollback` (`coordinator.ts:222-224`). Awaiting `addStatement`
  before `collection.stage` makes that snapshot capture pre-stage state — the fix
  additionally closes a latent rollback-snapshot race the old fire-and-forget had.
- Enumerated every `addStatement` caller (`find_references`): the only production
  caller is `optimystic-module.ts:921` (now awaited); all test callers awaited.
- Ran lint + full test suites (see below).

**What was found**
- *Correctness:* fix is correct and complete. No defect found.
- *Minor (observed, no code change):* in `addStatement`, `accumulatedStatements.push`
  runs before the awaited `session.execute`, so on a failed execute the reporting
  mirror holds a statement `session.statements` lacks. Harmless — the replicated
  record compiles from `session.statements`, the mirror is reporting-only and
  cleared on rollback, and the failure branch is only reachable on an
  already-committed/rolled-back session (empty actions never raise "collection not
  found"). Not a record-divergence bug; left as-is.

**What was done**
- *Tripwire (inline):* added a greppable `NOTE:` at `optimystic-module.ts` ~921
  making explicit that the `await addStatement` must stay above every
  `collection.stage` — reordering reopens the non-deterministic-snapshot race.
  This is the ordering invariant the handoff flagged as enforced only by the
  `await`; it is now documented for a future refactorer. No test guards it (see
  backlog ticket).
- *Backlog ticket filed (major → test debt):*
  `debt-session-mode-bridge-statement-recording-test` — the regression is pinned
  at the db-core **session** layer, but the original defect lived in the
  **bridge**, whose existing tests all run in legacy mode (no session). The ticket
  asks for a session-mode bridge integration test asserting compiled-record
  statement-count == DML-count under adversarial apply timing, plus rollback
  reverts staged rows. This is the "is a session-mode bridge integration test
  warranted?" decision the handoff explicitly deferred to review — decided: yes,
  as non-blocking test debt.

**Empty categories**
- *No new fix/plan tickets:* no defect or design gap found — the fix is correct.
- *No blocked tickets:* no human decision or external dependency involved.

## Validation run at review

- `packages/db-core`: `yarn build` (clean) + `yarn test` → **1139 passing, 0 failing**.
- `packages/quereus-plugin-optimystic`: `yarn build` + `yarn typecheck` (clean) +
  `yarn test` → **256 passing, 11 pending, 0 failing** (incl. the 3-node mesh DML suite).
- `eslint` on the changed source files and root `yarn lint` → clean.
- The review's only code change is a comment (the `NOTE:` tripwire); no rebuild required.
