description: When two writers race to change the same data, the one that loses now gets the database's standard error type (a constraint error for a duplicate, a new "concurrent modification" error for a changed row) instead of a bare error with only the right wording.
architecture: docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/concurrent-insert-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-row-change-refusal.spec.ts, packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts, packages/quereus-plugin-optimystic/test/entry-identity.spec.ts, packages/quereus-plugin-optimystic/README.md, packages/db-core/src/collections/tree/struct.ts, docs/internals.md
repro: verified
difficulty: easy
----
# Review: typed errors for the two concurrency refusals

## What changed

`TransactionBridge.mapCommitRefusal` (`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`) used to return a bare `new Error(message, { cause })` for every guard refusal. It now dispatches on the refusal's class, exactly as `renderRefusal` already does for the message:

- `TreeKeyTakenError` (its `TreeRangeTakenError` subclass included) becomes the engine's `ConstraintError`, `StatusCode.CONSTRAINT` (19), message unchanged. A refused concurrent duplicate (primary key or secondary unique value) is now indistinguishable from a sequential one by type and code.
- `TreeEntryChangedError` becomes a new plugin-owned `ConcurrentModificationError extends QuereusError` (defined beside `PartialCommitError`), `StatusCode.BUSY` (5). It is deliberately not a `ConstraintError`: a changed row is not a uniqueness violation, and the engine would rewrap a `ConstraintError` under `or fail` / `or rollback` into keeping the statement's prior rows.

The mapping is the one dispatch in `mapCommitRefusal`:

```ts
const cause = error instanceof Error ? error : undefined;
return cursor instanceof TreeKeyTakenError
  ? new ConstraintError(message, StatusCode.CONSTRAINT, cause)
  : new ConcurrentModificationError(message, cause);
```

The already-mapped pass-through (`error.message === message` on the outer error) is untouched and still works, because a mapped error carries exactly the rendered message. Both mapped types extend `QuereusError`, so the vtab's DML catch in `optimystic-module.ts` rethrows them verbatim instead of wrapping them a second time.

`ConcurrentModificationError` is exported from both `src/index.ts` and `src/plugin.ts` beside `PartialCommitError`. `ConstraintError`, `QuereusError` and `StatusCode` come from `@quereus/quereus`, a peer dependency the tsup config leaves external, so `instanceof` holds across the boundary.

Docs and comments updated: `docs/internals.md` (the entry-guards paragraph and the "Which statements carry `unchanged`" paragraph, which also drops its reference to this ticket), the doc comments on `mapCommitRefusal`, `keyTakenMessages`, `entryChangedRenderers`, `concurrentModificationMessage` (`optimystic-module.ts`), the three `Tree*Error` classes in `packages/db-core/src/collections/tree/struct.ts` (comment-only), and a short paragraph in the plugin README next to the other exported error classes (the class is new public API).

## Tests, each beside what it verifies

No new `it` blocks. The concurrent specs already reproduced each refusal but captured only its message, so the type assertion goes into the tests that already reach the refusal.

- `test/query-helpers.ts`: adds `captureThrown` (returns the thrown error; `captureThrowMessage` is now built on it), `expectConstraintRefusal` (`instanceOf ConstraintError`, code 19) and `expectConcurrentModificationRefusal` (`instanceOf ConcurrentModificationError`, code 5, and not a `ConstraintError`).
- `test/concurrent-insert-refusal.spec.ts`, "DETERMINISTIC replay path (legacy)": the loser's commit is a `ConstraintError` with code 19, and `TreeKeyTakenError` is reachable through the `cause` chain. This is the only place `cause` is asserted, per the ticket.
- `test/concurrent-insert-refusal.spec.ts`, "SESSION mode, two-table transaction": same `ConstraintError` assertion through the coordinator path, which reaches `mapCommitRefusal` from a different catch than legacy mode.
- `test/concurrent-secondary-unique-refusal.spec.ts`, "DETERMINISTIC replay (legacy)" and "SESSION mode": `ConstraintError` for the range refusal out of a unique index tree.
- `test/concurrent-row-change-refusal.spec.ts`, "UPDATE vs a rival UPDATE of the same row" and "SESSION mode": `ConcurrentModificationError`, code 5, not a constraint error. `stageThenRival` is split into `stageThenRivalError` (returns the error) and `stageThenRival` (returns its message, so the other eight call sites are untouched).
- `test/two-node-unique-value-race.spec.ts`: `expectCleanRefusal` now also asserts `ConstraintError` on the loser, which covers all three mesh-race shapes at once.
- `test/entry-identity.spec.ts`: `ConcurrentModificationError` added to `errorClassNames`, so the existing checks cover it (both entries export it, and as the identical object).

## Validation

Run from `C:\projects\optimystic`: `yarn build`, then `yarn test` in `packages/quereus-plugin-optimystic` (997 passing, 0 failing, 13 pending; the smoke script after it printed `smoke ok`), `yarn typecheck` (clean), `yarn lint:docs` (all citations resolve), `yarn lint` (no output). I did not run `yarn test:integration` or the other workspaces' test suites; the db-core edit is comment-only.

## Known gaps and things to check

- The suite reported 997 passing where the fix-stage ticket's prototype run reported 1000. I added and removed no tests and there are no failures, so I did not chase it; it may be a case count that varies with the environment. A reviewer who sees a real gap should compare against a clean run of `bc4506af`.
- I did not revert the fix to watch the new assertions fail. The fix-stage reproduction already showed all three refusals as `ctor=Error code=undefined`, and `instanceOf ConstraintError` on a plain `Error` is false by construction.
- The type is asserted on commit-time refusals only. A staging-time refusal (the vtab DML catch calling `mapCommitRefusal`, seen only on a two-node mesh when the tracker fetches a rival's commit the pre-stage probe had not) is not asserted for type, and nothing tests the behaviour change the ticket predicts there for `or fail` / `or rollback` (the engine's `translateConflictError` now rewraps the `ConstraintError`). I found no deterministic way to trigger a staging-time refusal, so I left it unpinned rather than add a flaky test.
- The type assertion is on the first row-change test and the session-mode one, not on all nine `stageThenRival` cases. They all go through the same dispatch, so the rest would repeat one behaviour.
- Non-goal untouched: the same refusal surfacing early out of a live read inside a doomed transaction still reaches the client as `Query failed: ...`, unmapped (the `NOTE:` in `OptimysticVirtualTable.runQuery`).
- `git stash list` shows a stash (`WIP on main: 3dfd91f ticket(fix): optimystic-db-p2p-libp2p-dep-skew`) that is not from this run; I left it alone.
