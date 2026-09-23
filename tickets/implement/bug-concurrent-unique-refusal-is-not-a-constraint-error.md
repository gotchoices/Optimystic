description: When two writers race to change the same data, the one that loses gets an error with the right wording but not the standard error type the database uses, so application code that recognises these failures by type misses them and shows a generic failure instead.
architecture: docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/concurrent-insert-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-row-change-refusal.spec.ts, packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts, packages/quereus-plugin-optimystic/test/entry-identity.spec.ts, packages/db-core/src/collections/tree/struct.ts, docs/internals.md
repro: verified
difficulty: easy
----
# Give the two concurrency refusals typed errors

## What is wrong

`TransactionBridge.mapCommitRefusal` (`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`) is the one seam every concurrency refusal passes through. It builds the right *message* and then returns `new Error(message, { cause })` — a bare `Error` with no `code` and no class a caller can test. A client that classifies failures by type sees an unclassified error where the same failure, arrived at sequentially, is a `ConstraintError`.

Reproduced this run, at `bc4506af`: one node, two `Database` handles over one `FileRawStorage` directory, staged-then-rival-commits so the refusal can only come from the commit-time conflict replay. All three refusal shapes arrive as `ctor=Error name=Error code=undefined`:

```
PK          msg=UNIQUE constraint failed: T.id                       cause=TreeKeyTakenError
secondary   msg=UNIQUE constraint failed: T.stamp                    cause=TreeRangeTakenError
row change  msg=concurrent modification: ... in T at primary key (1)  cause=TreeEntryChangedError
```

So the `static` reading the fix-stage ticket carried for the commit-time path is now **verified**, for the uniqueness class and the lost-update class alike.

## What it should be

Two arms out of one seam, dispatched by the refusal's class exactly as `renderRefusal` already dispatches the message:

- **`TreeKeyTakenError` (its `TreeRangeTakenError` subclass included) becomes the engine's `ConstraintError`, code `StatusCode.CONSTRAINT` (19)**, message unchanged. A refused concurrent duplicate then differs from a sequential one in nothing a client can observe.
- **`TreeEntryChangedError` becomes a lost-update type, NOT a `ConstraintError`.** A rival changing the row this statement read is not a uniqueness violation, and dressing it as one would misreport it to every client. It gets a new plugin-owned class, `ConcurrentModificationError extends QuereusError`, with `StatusCode.BUSY` (5).

`BUSY` is the engine's own convention for this: Quereus's memory virtual table throws `QuereusError('Commit failed: concurrent update on table ... . Retry.', StatusCode.BUSY)` for the same optimistic-concurrency loss (`@quereus/quereus/src/vtab/memory/layer/manager.ts`). A subclass rather than a bare `QuereusError` so a caller can have it either way: `instanceof ConcurrentModificationError` for precision, `code === StatusCode.BUSY` for uniformity with the memory table.

Both mapped types must extend `QuereusError`, because the vtab's DML catch (the `catch` at the end of `OptimysticVirtualTable.update` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`) rethrows a `QuereusError` verbatim *before* it reaches the mapping. That rethrow is what stops a mapped refusal being wrapped a second time on a later pass through the same catch, and it only works if the mapped error is one.

## A prototype of this was built and run, and the whole plugin suite was green

The shape below was applied to `mapCommitRefusal`, the plugin rebuilt, and the package's full suite run: **1000 passing, 0 failing, 13 pending** — including `secondary-unique.spec.ts`, `insert-pk-uniqueness.spec.ts`, `entry-identity.spec.ts`, the four concurrent specs and the two-node mesh sweeps. The prototype was then reverted; nothing of it is in the tree. Implementing it should be close to mechanical.

```ts
const cause = error instanceof Error ? error : undefined;
return cursor instanceof TreeKeyTakenError
  ? new ConstraintError(message, StatusCode.CONSTRAINT, cause)
  : new ConcurrentModificationError(message, cause);
```

`ConstraintError`, `QuereusError` and `StatusCode` come from `@quereus/quereus`, which is a peer dependency of this package (`optimystic-module.ts` already imports all three) and is left external by `tsup.config.ts`. So the `ConstraintError` the bridge constructs is the host engine's own class and `instanceof` holds across the boundary.

## Settled while researching, so it needs no re-investigation

- **The already-mapped pass-through still works, unchanged.** `mapCommitRefusal`'s check is `error.message === message` on the OUTER error. A mapped `ConstraintError` carries exactly the rendered message, so a second pass — the legacy fallback sweep maps before rethrowing, and `commitTransaction`'s catch maps again — returns it untouched. Keep the check as it is.
- **Index trees are unaffected by the lost-update arm.** They register no entry-changed renderer, so `renderRefusal` returns `undefined` for a `TreeEntryChangedError` from an index collection and the error passes through exactly as today.
- **`or ignore` does not swallow the new `ConstraintError`.** Quereus never catches a thrown `ConstraintError` to honour IGNORE; that disposition is carried by the structured result the vtab returns instead.
- **`or fail` and `or rollback` DO change behaviour, correctly, and only for a STAGING-time refusal.** The engine's `translateConflictError` (`@quereus/quereus/src/runtime/emit/dml-executor.ts`) rewraps a `ConstraintError` escaping a row into `FailConflictError` under `or fail` and `RollbackConflictError` under `or rollback`, which is what drives the engine's keep-prior-rows / roll-back-the-transaction cleanup. So a staging-time uniqueness refusal now gets the OR-clause semantics its message has always claimed, where before it fell through as an unclassified error. A commit-time refusal never passes through that executor and is unaffected. The new lost-update type is not a `ConstraintError`, so it is never translated — which is right: a lost update must not keep the statement's prior rows.
- **Nothing inside this repository matches these messages as text**, so no internal consumer breaks.

## Non-goal

The same refusal surfacing EARLY out of a live read inside a doomed transaction still reaches the client as `Query failed: ...`, unmapped and untyped (the `NOTE:` in `OptimysticVirtualTable.runQuery`'s catch). That is a different seam and stays as it is; do not widen this ticket to it.

## TODO

- Add `ConcurrentModificationError extends QuereusError` (code `StatusCode.BUSY`, `name` set, `Object.setPrototypeOf` as the engine's own error classes do) beside `PartialCommitError` in `txn-bridge.ts`.
- Dispatch `mapCommitRefusal` by the refusal's class to `ConstraintError` / `ConcurrentModificationError`, keeping the message rendering and the already-mapped pass-through exactly as they are.
- Export `ConcurrentModificationError` from both `src/index.ts` and `src/plugin.ts`, beside `PartialCommitError`, and add its name to `errorClassNames` in `test/entry-identity.spec.ts` so the one-object-per-name guard covers it.
- Update the doc comments on `mapCommitRefusal`, `keyTakenMessages` and `entryChangedRenderers` to say which type each arm produces, and why the lost-update arm is deliberately not a constraint error.
- Give the four concurrent specs the type assertion they lack: `concurrent-insert-refusal.spec.ts`, `concurrent-secondary-unique-refusal.spec.ts` and `two-node-unique-value-race.spec.ts` assert `ConstraintError` with `code === StatusCode.CONSTRAINT`; `concurrent-row-change-refusal.spec.ts` asserts `ConcurrentModificationError`. They capture only the message today (`captureThrowMessage` in `test/query-helpers.ts`), so each needs the error object itself; `expectConstraintError` in `test/secondary-unique.spec.ts` is the existing shape to follow. Assert the structured refusal is still reachable through `cause` in ONE place, not in every test.
- Update `docs/internals.md`: the "so a refused concurrent insert carries the same message as a sequential duplicate — but as a plain `Error` with no status code" sentence under the entry-guards section, and the "a plain `Error` with `cause` ... and the same open error-type question" clause under **Which statements carry `unchanged`** (which also names this ticket as open — drop that reference).
- Update the mapping descriptions in the `TreeGuardRefusedError`, `TreeRangeTakenError` and `TreeEntryChangedError` doc comments in `packages/db-core/src/collections/tree/struct.ts` to name the two types the bridge now produces.
- Validate: `yarn build` then `yarn test` from `packages/quereus-plugin-optimystic`, plus `yarn typecheck` from the root (which must run after the build, since these specs import the package's own `dist/`).
