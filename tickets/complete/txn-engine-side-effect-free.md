description: A transaction engine used to both apply a statement's effects and hand them back to its caller, who applied them again — so some statements landed twice. Engines are now translators that only return effects; the code that applies them was fixed to apply exactly once. Reviewed, verified, and closed.
prereq:
files:
  - packages/db-core/src/transaction/actions-engine.ts (ActionsEngine — pure translator; constructor param removed)
  - packages/db-core/src/transaction/coordinator.ts (execute — stages returned actions itself, once)
  - packages/db-core/src/transaction/session.ts (unchanged — already the single apply)
  - packages/db-core/src/transaction/validator.ts (comment reworded to be model-aware — review fix)
  - packages/db-core/src/transaction/transaction.ts (ITransactionEngine contract — two engine models documented)
  - packages/db-core/test/transaction.spec.ts (migrations + repro/leak tests + new coordinator.execute apply-count guard)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (the "other model" engine — read, not changed)
  - docs/optimystic.md (example updated to new ActionsEngine() signature)
difficulty: medium
----

# Complete: engines are side-effect-free translators (double-apply fix)

## Summary of the landed work

A transaction engine translates statements into per-collection actions
(inserts/replaces/deletes). Previously `ActionsEngine.execute` **also** applied each
parsed action through `coordinator.applyActions` as a side effect, then returned the
same actions — and callers that received those actions applied them a **second** time.
The fix makes `ActionsEngine` a pure translator (returns actions, applies nothing; the
constructor `coordinator` param was removed), and moves the single application to the
caller:

- `TransactionSession.execute` already applied once on its no-pre-supplied-actions
  branch — with the engine side-effect gone, that is now the sole apply.
- `TransactionCoordinator.execute` previously relied on the engine's side-effect to
  stage actions into the trackers (its own loop only *reads* tracker transforms to
  materialise the log entry). With the side-effect gone it would have applied **zero**
  times, so it now stages the returned actions itself via
  `this.applyActions(result.actions, transaction.stamp.id)` (try/catch → the prior
  "Collection not found" error result on a missing collection).

Net apply-count on every path is now **exactly one**.

The `ITransactionEngine` contract (`transaction.ts`) was reworded to document the two
legitimate engine models, because a real in-repo engine contradicts a naive "never apply
as a side effect" rule:
- **(a) pure translator** — return actions, don't apply (`ActionsEngine`).
- **(b) side-effect apply** — apply internally and return an EMPTY actions array
  (`QuereusEngine`, whose `db.exec` drives the Optimystic vtab into
  `coordinator.applyActions` and pushes nothing to its returned array).
An engine that does BOTH double-applies.

## Review findings

Reviewed the implement-stage diff (commit `21e1e08`) with fresh eyes against the actual
source before trusting the handoff, then verified the handoff's own claims.

**Verified correct (no change needed):**
- **Core double-apply fix.** Traced `ActionsEngine.execute` (pure now), `session.execute`
  (line 90 translate → line 98 single `applyActions`), and `coordinator.execute`
  (`applyActions` once at 1b, then `applyActionsToCollection` which only *reads*
  `tracker.transforms` and materialises the log — it does not re-apply). Apply-count is
  exactly one on every path. The handoff's correction to the source ticket (that
  `coordinator.execute` was single-apply-via-side-effect, not double-apply) is accurate.
- **QuereusEngine non-regression.** Confirmed `QuereusEngine.execute` returns an empty
  actions array (model b) and is never routed through `coordinator.execute` in
  production; it does not construct `ActionsEngine`; no exported signature changed. Ran
  its suite to be sure (see below).
- **No production caller of `TransactionCoordinator.execute`.** It is exercised only by
  tests today (db-p2p uses the unrelated `executeClusterTransaction`). The fix is still
  correct; noting that its blast radius is currently test-only.
- **Test migration** (~56 constructor sites + ~13 `engine.execute`-as-apply → the new
  `applyViaEngine` helper + re-pointed "Collection not found" assertions) is mechanical
  and coherent.

**Minor — fixed in this pass:**
- **Coverage hole on `coordinator.execute` apply-count.** The implementer's repro pins
  the count on the *session* path only. Every action in the existing multi-collection
  `coordinator.execute` tests is a `replace`, which is **idempotent** — so a future
  double-apply regression on that path would slip past all final-value assertions (only
  the zero-apply case was caught, via an `undefined` read). Added
  `applies a multi-collection transaction exactly once on coordinator.execute()`: spies
  `applyActions` and asserts exactly one call across a two-collection transaction, plus
  both rows landed. (db-core: 1183 → **1184 passing**.)
- **Over-general comment in `validator.ts` (step 5).** It stated as absolute fact that
  "engines are pure translators … CANNOT mutate any coordinator's state," which
  **contradicts the `ITransactionEngine` contract it cites** — this generic validator
  also serves `QuereusEngine` (model b), whose `execute()` *does* apply as a side effect.
  Reworded the comment to be model-aware: for model (a) isolation is inherent (the sole
  apply is step 6 on the isolated validation coordinator); for model (b) isolation is the
  `createValidationCoordinator` wiring's job (see `quereus-validator`, which resets the
  coordinator and no-ops its `applyActions`), and step 6 is skipped by the empty-actions
  guard. Comment-only; no runtime effect.

**Major (new tickets): none.** No defect large enough to warrant a fix/plan/backlog
ticket surfaced.

**Docs.** `docs/optimystic.md` was updated by the implementer to the no-arg
`new ActionsEngine()` signature; verified the surrounding example is still accurate (it
passes explicit actions to `session.execute`, so it uses the pre-supplied-actions branch
and never invokes engine translation). No stray `new ActionsEngine(coordinator)` remains
anywhere in `**/*.{ts,md}`.

**Accepted as-is (agree with implementer):**
- **Partial-apply on error in `coordinator.execute`** (action set spans [A, B], B's
  collection missing → A staged before the caught throw, no rollback). Matches the
  pre-existing documented `execute()` asymmetry (big NOTE at `coordinator.ts:420`) and
  the old engine behaviour. Not introduced by this change; no rollback added.
- **Two harmless unused-local hints** in the "Transaction Validation" describe (dead
  `const coordinator = …` now that the engine takes no arg). `noUnusedLocals` is OFF, so
  `tsc` stays green (build verified exit 0). Left in place to avoid a delete-cascade of
  collection setup; a future editor may prune.

## Tripwire recorded (not a ticket)

The `ITransactionEngine` contract now permits two engine models. A future engine that
**both** applies as a side effect **and** returns those same actions would silently
double-apply again. This is documented at the two sites a future engine author will
actually read — the `ITransactionEngine` JSDoc (`transaction.ts`) and the
`coordinator.ts` step-1b comment — and now also reinforced by the model-aware
`validator.ts` comment. Conditional on a new engine being written; no ticket.

## Verification performed

- `yarn workspace @optimystic/db-core run build` → exit 0.
- `yarn workspace @optimystic/db-core run test` → **1184 passing, 0 failing** (includes
  the 2 implementer tests, the previously-failing three-collections test, and the new
  apply-count guard).
- `yarn workspace @optimystic/quereus-plugin-optimystic run build` → success.
- `yarn workspace @optimystic/quereus-plugin-optimystic run test` → **305 passing,
  11 pending, 0 failing** — closes the handoff's flagged "not built/tested here" gap;
  the contract reword and `coordinator.execute` change do not regress the SQL path.

No lint step exists in either package (`build` is `tsc` / `tsup`; no separate linter
configured); type safety is enforced by the builds above, both clean.
