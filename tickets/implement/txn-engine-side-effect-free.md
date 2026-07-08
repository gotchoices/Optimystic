description: A transaction engine both applies a statement's effects AND hands them back to its caller, who applies them a second time — so any statement run without pre-supplied effects lands twice. Make the engine a pure translator that only returns effects, and apply them in exactly one place.
prereq:
files:
  - packages/db-core/src/transaction/actions-engine.ts (ActionsEngine.execute — the side-effecting apply at line 53)
  - packages/db-core/src/transaction/session.ts (execute — engine-translation path, lines 82-98)
  - packages/db-core/src/transaction/coordinator.ts (execute — engine.execute then re-apply loop, lines 388/416)
  - packages/db-core/src/transaction/validator.ts (validate — engine bound to MAIN coordinator leaks into main state, line 97)
  - packages/db-core/src/transaction/transaction.ts (ITransactionEngine JSDoc — document the no-side-effect contract, ~line 122)
  - packages/db-core/test/transaction.spec.ts (many direct engine.execute call sites rely on the side-effect — must migrate)
difficulty: medium
----

# Make transaction engines side-effect-free translators (fixes double-apply)

## What's wrong

A transaction engine is supposed to *translate* statements into a per-collection
list of actions (inserts/replaces/deletes). It should hand those actions back and
let the coordinator/session apply them. `ActionsEngine.execute` does both: it parses
each statement into a `CollectionActions` **and** applies it via
`coordinator.applyActions` as a side-effect (`actions-engine.ts:53`), then also
returns the actions.

Every caller that receives those returned actions applies them **again**:

- **`TransactionSession.execute`** (`session.ts:82-98`) — on the branch where the
  caller does *not* pass pre-computed actions, it calls `engine.execute(tempTransaction)`
  and then `coordinator.applyActions(result.actions, …)`. The engine already applied
  them → applied twice.
- **`TransactionCoordinator.execute`** (`coordinator.ts:388` then the loop at `:416`) —
  calls `engine.execute(transaction)`, then re-applies every returned `CollectionActions`
  through `applyActionsToCollection`. Also twice. (This is the fully-formed-transaction
  path, e.g. Quereus.)
- **`TransactionValidator.validate`** (`validator.ts:97`) — calls
  `registration.engine.execute(transaction)`. Because the registered `ActionsEngine`
  was constructed with the **main** coordinator, re-executing a transaction during
  validation **mutates the validator node's live collection state** — a leak, separate
  from but rooted in the same side-effect. The validator then correctly applies
  `result.actions` to its *isolated* `validationCoordinator` (`:106-108`).

The net effect: a statement's actions get pushed into the collection's `pending`
queue twice, so the committed log and the operations hash reflect double the work —
"corrupting the transaction's contents," as the source ticket put it.

## Why no test caught it

- The session's double-apply branch (no pre-supplied actions) is **exercised by no
  test** — every session test passes explicit `actions`, which takes the other branch
  and applies exactly once.
- The coordinator's double-apply *is* hit by many tests, but they all use `replace`
  actions (idempotent at the value level: replacing key 1 with the same row twice
  yields the same row) and assert only on final materialized values or on "hash is a
  string," never on apply-count or on the pending/log contents. So the duplication is
  invisible to them.
- The validator leak is likewise unasserted.

## The fix (direction — confirmed correct for this codebase)

Make engines **pure translators**: `engine.execute` parses statements and **returns**
`CollectionActions[]`; it never touches a coordinator. Application belongs solely to
the session (`session.ts:98`) and the coordinator (`coordinator.ts:416` loop). This
makes all three paths apply exactly once and removes the validator's main-state leak
for free (the validator already applies to its isolated coordinator).

Because `ActionsEngine` is the *only* engine in this repo and is **test-only** (grep
confirms it's constructed nowhere in `src/`), this is safe to change wholesale.

### Consequence to plan for: error semantics move

Today `ActionsEngine.execute` surfaces `"Collection not found"` because it applies
through the coordinator during translation. A pure translator only parses JSON — it
cannot know whether a collection exists. That check already lives in the coordinator
(`coordinator.ts:78/513/751/845`) and will now surface when the actions are *applied*
(via `session.execute` or `coordinator.execute`), not from `engine.execute`. Tests
that assert `engine.execute(...)` returns a `"Collection not found"` error
(`transaction.spec.ts:174, 209, 982, 1590`) must be re-pointed at the apply path.

### Test migration (the bulk of the work)

Many tests call `actionsEngine.execute(tx)` directly as a shortcut to *apply* actions,
then read collection values (e.g. `:297-308`, `:381-392`, `:692-701`) or assert
failures (`:174, 209, 982, 1590`). There are ~18 direct `engine.execute` call sites
(`:170, 205, 227, 297, 381, 692, 980, 1637, 1680, 1717, 1765, 1814, 1881, 1939, 2004,
2682, 2741, 2810`) plus ~50 `new ActionsEngine(coordinator)` constructions. After the
fix, a bare `engine.execute` no longer applies anything.

Recommended approach: add a tiny test helper (in the spec file or a shared test util)
that expresses the real intent — "translate then apply":

```ts
async function applyViaEngine(
  coordinator: TransactionCoordinator,
  engine: ITransactionEngine,
  tx: Transaction
): Promise<ExecutionResult> {
  const result = await engine.execute(tx);
  if (result.success && result.actions?.length) {
    await coordinator.applyActions(result.actions, tx.stamp.id);
  }
  return result;
}
```

Then mechanically replace direct `await actionsEngine.execute(tx)` (where the test
depends on application) with `await applyViaEngine(coordinator, actionsEngine, tx)`.
Pure-parse assertions (invalid-JSON at `:227`) stay on `engine.execute`. The
"Collection not found" assertions move onto the apply path (the helper's
`applyActions` throws / the coordinator returns the error). Keep each test's *intent*;
don't silently weaken assertions to make them pass.

`ActionsEngine`'s constructor `coordinator` param becomes unused. Prefer removing it
and updating the `new ActionsEngine(...)` sites (including the `new ActionsEngine({} as any)`
placeholders at `:2457, 2507, 2557, 2583, 3309`, which become `new ActionsEngine()`).
If the churn is judged too risky in one pass, keeping an ignored optional param is an
acceptable fallback — document the choice in the review handoff.

## Reproducing test (write this first — it fails before the fix)

The session no-actions branch is the untested hole. Spy on `applyActions` and assert
it runs exactly once per `session.execute` that lets the engine translate:

```ts
it('applies a statement exactly once on the engine-translation path', async () => {
  const transactor = new TestTransactor();
  const usersTree = await Tree.createOrOpen<number, { key: number; name: string }>(
    transactor, 'users', e => e.key);
  const collections = new Map();
  collections.set('users', (usersTree as any).collection);
  const coordinator = new TransactionCoordinator(transactor, collections);
  const engine = new ActionsEngine(coordinator);
  const session = await TransactionSession.create(coordinator, engine);

  let applyCalls = 0;
  const realApply = coordinator.applyActions.bind(coordinator);
  coordinator.applyActions = async (a, id) => { applyCalls++; return realApply(a, id); };

  // NOTE: no `actions` arg → engine translates. This is the untested branch.
  const stmt = JSON.stringify({
    collectionId: 'users',
    actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }],
  });
  const res = await session.execute(stmt);

  expect(res.success).to.be.true;
  expect(applyCalls, 'engine-translation path double-applied').to.equal(1); // pre-fix: 2
});
```

(`replace` is fine here — the assertion is on *apply count*, not on a value that
idempotency would mask.) Optionally also add a validator test asserting that
`validator.validate(...)` does **not** mutate the main coordinator's collections
(pre-fix it does, via the engine side-effect).

## TODO

- Write the reproducing test above (session engine-translation path, apply-count spy); confirm it fails (applyCalls === 2).
- Remove the `coordinator.applyActions` side-effect from `ActionsEngine.execute` (`actions-engine.ts:52-53`); return parsed `allActions` only. Drop the now-unused `coordinator` field/param (or keep it ignored — document if so).
- Update the `ITransactionEngine.execute` JSDoc in `transaction.ts` to state the contract explicitly: engines MUST NOT apply/mutate coordinator state — they only translate statements into `CollectionActions[]`.
- Update the double-apply note in `validator.ts` (near `:92-108`) to reflect that engines are now side-effect-free, so re-execution during validation cannot leak into main state.
- Add the `applyViaEngine` test helper; migrate the ~18 direct `engine.execute`-as-apply call sites and re-point the "Collection not found" assertions onto the apply path.
- Update the ~50 `new ActionsEngine(...)` constructions to the new signature (incl. the `{} as any` placeholders).
- Verify: from `packages/db-core`, run `yarn build 2>&1 | tee /tmp/build.log` then `yarn test 2>&1 | tee /tmp/test.log`. All green, including the new repro. If any failure is plainly pre-existing/unrelated, follow the pre-existing-error protocol.
- Hand off to review noting: (a) the repro now passes, (b) whether the `ActionsEngine` coordinator param was removed or kept-ignored, (c) that the coordinator.execute path (Quereus/fully-formed) was also double-applying and is now fixed by the same change.
