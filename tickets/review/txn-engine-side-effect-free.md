description: A transaction engine used to both apply a statement's effects and hand them back to its caller, who applied them again — so statements run without pre-supplied effects landed twice. Engines are now translators that only return effects; the code that applies them was fixed to apply exactly once.
prereq:
files:
  - packages/db-core/src/transaction/actions-engine.ts (ActionsEngine.execute — side-effect removed; constructor param removed)
  - packages/db-core/src/transaction/coordinator.ts (execute — now applies the returned actions itself; ~line 399-418)
  - packages/db-core/src/transaction/session.ts (unchanged — already applied once; now the sole apply on the translate branch)
  - packages/db-core/src/transaction/validator.ts (comment update — engines can't leak into main state now)
  - packages/db-core/src/transaction/transaction.ts (ITransactionEngine contract JSDoc — reworded to the accurate no-double-apply invariant)
  - packages/db-core/test/transaction.spec.ts (applyViaEngine helper + repro/leak tests + ~18 call-site migrations)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (NOT changed — but read this; it is the "other model" engine)
  - docs/optimystic.md (example updated to new ActionsEngine() signature)
difficulty: medium
----

# Review: engines are side-effect-free translators (double-apply fix)

## What was done

A transaction engine translates statements into per-collection actions
(inserts/replaces/deletes). `ActionsEngine.execute` used to *also* apply each
parsed action through `coordinator.applyActions` as a side effect, then return the
same actions. Callers that received the returned actions applied them a **second**
time.

Changes made:

- **`ActionsEngine` is now a pure translator.** `execute()` parses + validates the
  JSON statements and returns `CollectionActions[]` only. It no longer calls
  `coordinator.applyActions`. **The constructor `coordinator` param was REMOVED**
  (not kept-ignored) — `new ActionsEngine()` now takes no args.
- **`TransactionSession.execute` needed no code change** — on the no-pre-supplied-
  actions branch it already applied via `coordinator.applyActions`. With the engine
  side-effect gone, that is now the *single* apply.
- **`TransactionCoordinator.execute` was CHANGED** — see the correction below.
- **`transaction.ts` `ITransactionEngine` JSDoc** reworded to the true invariant.
- **`validator.ts`** comment updated (re-execution can no longer leak into main state).

## IMPORTANT correction to the source ticket — read this first

The source ticket claimed `TransactionCoordinator.execute` was **also double-applying**
("re-applies every returned CollectionActions through `applyActionsToCollection`").
**That claim is wrong**, and reviewing against it will mislead you.

`applyActionsToCollection` (`coordinator.ts:498`) does **not** apply anything — it
*reads* `collection.tracker.transforms` (line 522) and materialises a log entry from
whatever is already staged. `coordinator.execute` therefore had **no apply step of its
own**; it relied entirely on the engine's side-effect to stage the actions into the
trackers, then read them. So that path was **single-apply, via the engine side-effect**
— not double-apply.

Consequence: naïvely removing the engine side-effect made `coordinator.execute` apply
**zero** times → empty trackers → nothing committed. This was caught by the existing
test **"should handle transaction with three or more collections"** (it read
`usersTree.get(1)` and got `undefined`). The fix: `coordinator.execute` now stages the
returned actions itself via `this.applyActions(result.actions, transaction.stamp.id)`
before the log-materialisation loop (`coordinator.ts:399-418`), wrapped in try/catch so
a missing collection still returns `{ success:false, error:'Collection not found: …' }`
(its prior contract) instead of throwing.

Net apply-count after the fix, on every path: **exactly one.**

## Second discovery — there are TWO engine models (contract reworded)

`QuereusEngine` (`packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts`)
is the *only other* engine, and it works the **opposite** way from ActionsEngine:
`execute()` runs `db.exec(sql)`, which drives the Optimystic vtab to call
`coordinator.applyActions` **as a side effect**, and then **returns an EMPTY actions
array** (`allActions` is never pushed to; see lines 99, 106-108). Because it returns
empty, no caller re-applies, so it never double-applied.

So the original ticket's blanket rule "engines MUST NOT apply as a side effect" is
**contradicted by a real in-repo engine.** I reworded the `ITransactionEngine` contract
(`transaction.ts`) to the accurate invariant: an engine must satisfy exactly ONE of
(a) pure translator — return actions, don't apply (ActionsEngine), or (b) side-effect
apply — apply internally and return EMPTY (QuereusEngine/vtab). Never both.

**Why QuereusEngine is not regressed by any of my changes** (please double-check this
reasoning — it is the main risk area):
- Quereus drives `session.execute(sql, [])` with an **empty** actions array
  (`txn-bridge.ts:578`), which takes the `if (actions)` branch — the engine-translation
  branch is **skipped**, so `QuereusEngine.execute` is not even called there. Rows are
  staged by the vtab; `session.execute(_, [])` only records the statement.
- `coordinator.execute` guards `if (result.actions.length === 0) return` **before** my
  new `applyActions` call, so a QuereusEngine's empty return short-circuits — my code is
  never reached for it. (Quereus does not use `coordinator.execute` anyway.)
- No exported type/signature changed; QuereusEngine doesn't construct `ActionsEngine`.
  `grep ActionsEngine packages/quereus-plugin-optimystic` → nothing.

## Reproducing tests added (new describe block in transaction.spec.ts)

`describe('Engine side-effect-free translation (txn-engine-side-effect-free)')`:

1. **`applies a statement exactly once on the engine-translation path`** — the ticket's
   repro. Spies `coordinator.applyActions`, calls `session.execute(stmt)` with **no**
   actions arg (the previously-untested engine-translation branch), asserts
   `applyCalls === 1` (pre-fix: 2) and the row landed once. **This is the floor, not the
   ceiling** — it only covers the single-statement session path.
2. **`validate() re-execution does not leak into the main coordinator state`** —
   registers the main-coordinator-bound engine in a `TransactionValidator`, snapshots
   the main collection's tracker transforms, runs `validate()`, asserts transforms are
   byte-identical after. Pre-fix this failed (engine side-effect mutated main state).

## Test migration summary

- Added `applyViaEngine(coordinator, engine, tx)` helper (top of spec): translate then
  apply — the honest replacement for tests that used bare `engine.execute` to *apply*.
- `new ActionsEngine(coordinator)` / `({} as any)` / `(coordinator1|2)` → `new ActionsEngine()`
  (all 56 sites).
- ~13 `engine.execute`-as-apply sites → `applyViaEngine(...)` (value-reading + commit-path
  staging tests).
- "Collection not found" assertions (2 ActionsEngine parse tests + the "collection does
  not exist" test) re-pointed onto `coordinator.execute`, which returns the error result.
  The two parse tests now *also* assert the pure-translate success (returns actions).
- Pure-parse test (invalid JSON) stays on `engine.execute`.
- The session `bad-stmt` test (`session.execute(_, [explicit actions])`) was already on
  the apply path — unchanged.

## Verification done

- `yarn workspace @optimystic/db-core run build` → exit 0.
- `yarn workspace @optimystic/db-core run test` → **1183 passing, 0 failing** (includes
  the 2 new tests and the previously-failing three-collections test now green).

## Known gaps / things to check (treat my work as a starting point)

- **quereus-plugin-optimystic was NOT built or tested here.** I argued above it is
  unaffected (no signature change, empty-actions/`[]` paths dodge my edits), but I did
  not run its suite. A reviewer with the Quereus toolchain should run
  `yarn workspace @optimystic/quereus-plugin-optimystic run test` to confirm — the
  contract reword and coordinator.execute change are the theoretically-relevant edits.
- **Two harmless unused-local hints** remain in the "Transaction Validation" describe
  (the schema-mismatch test and one sibling): their `const coordinator = …` is now dead
  because the engine no longer takes it. `noUnusedLocals` is OFF (verified — no such flag
  in `packages/db-core/tsconfig.json`, no root/base tsconfig), so `tsc` stays green. Left
  in place to avoid a cascade of deleting the whole collection-setup that only fed the
  coordinator; a reviewer may prune if desired.
- **Coverage floor:** the repro only exercises a single-statement session path and a
  single-collection validator. Multi-statement session translation, and a multi-
  collection `coordinator.execute` apply-count assertion, are not directly asserted
  (existing multi-collection tests assert final values, which the single-apply fix
  satisfies, but not apply-*count*). Consider a coordinator.execute apply-count spy test.
- **Partial-apply on error in `coordinator.execute`:** if action set spans [A, B] and B's
  collection is missing, A is staged before the throw is caught and converted to an error
  result (no rollback). This matches the pre-existing documented asymmetry (execute() is
  not retryable; the big NOTE at `coordinator.ts:420`) and the old engine behaviour (it
  also left A applied), so I did not add rollback — flag if you disagree.

## Tripwire recorded (not a ticket)

The ITransactionEngine contract now permits two engine models. A future engine that
**both** applies as a side effect **and** returns those same actions would silently
double-apply again. This is documented at the two code sites a future engine author will
actually read: the `ITransactionEngine` JSDoc (`transaction.ts`) and the `coordinator.ts`
step-1b comment. No separate ticket — it is conditional on a new engine being written.
