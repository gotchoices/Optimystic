description: When two writers race to change the same data, the one that loses now fails with the database's standard error type — a constraint error for a duplicate, a new "concurrent modification" error for a changed row — instead of a bare error whose only clue was its wording.
architecture: docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/concurrent-insert-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-row-change-refusal.spec.ts, packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts, packages/quereus-plugin-optimystic/test/entry-identity.spec.ts, packages/quereus-plugin-optimystic/README.md, packages/db-core/src/collections/tree/struct.ts, docs/internals.md
repro: verified
----
# Complete: typed errors for the two concurrency refusals

## What landed

`TransactionBridge.mapCommitRefusal` returned a bare `new Error(message, { cause })` for every guard refusal. It now raises a typed engine error, chosen by the refusal's class:

- `TreeKeyTakenError` (its `TreeRangeTakenError` subclass included) — a refused concurrent duplicate primary key or unique value — becomes the engine's own `ConstraintError`, `StatusCode.CONSTRAINT` (19), message unchanged. A concurrent duplicate is now indistinguishable from a sequential one in type, code and wording.
- `TreeEntryChangedError` — a rival changed or removed the row the losing statement read — becomes a new plugin-owned `ConcurrentModificationError extends QuereusError`, `StatusCode.BUSY` (5), defined beside `PartialCommitError` and exported from both entries. Deliberately not a `ConstraintError`: no integrity rule was violated, and the engine rewraps a `ConstraintError` under `or fail` / `or rollback` into keeping the statement's prior rows, which is wrong for a lost update. `BUSY` is the code the engine's own memory table raises for the same optimistic-concurrency loss.

Both extend `QuereusError`, so the vtab's DML catch rethrows a mapped refusal verbatim. Both keep the storage-level refusal in `cause`. `@quereus/quereus` is a peer dependency left external by the build, so `instanceof` holds across the package boundary, and the classes sit in the one chunk both entries import.

Docs and comments were carried along: the two affected paragraphs of `docs/internals.md`, the doc comments on `mapCommitRefusal` and the two message registries, `concurrentModificationMessage` in `optimystic-module.ts`, the three `Tree*Error` classes in `packages/db-core/src/collections/tree/struct.ts` (comment-only), and a paragraph in the plugin README next to the other exported error classes.

## Tests

No new `it` blocks. The concurrent specs already reproduced each refusal but captured only its message, so the type assertion went into the tests that already reach it, via three shared helpers in `test/query-helpers.ts` (`captureThrown`, `expectConstraintRefusal`, `expectConcurrentModificationRefusal`). Six assertion sites: the legacy and session arms of the primary-key race, of the secondary-unique race and of the row-change race, plus `expectCleanRefusal` in the two-node mesh sweep, and `ConcurrentModificationError` added to the entry-identity name list. The primary-key legacy arm is the one place `cause` is asserted.

## Review findings

**Verified by reading and running** (nothing found): the class dispatch against the message dispatch, so a refusal can never get the message of one class and the type of another; the already-mapped pass-through (`error.message === message`), which now preserves the mapped *type* through the legacy sweep's double map; the engine's own handling of the two new types — a grep over `@quereus/quereus` confirms nothing in the commit or transaction path branches on `ConstraintError` or on `StatusCode.BUSY`, and `translateConflictError` (the one consumer) sits inside the DML row loop, so a commit-time refusal never reaches it and an `or ignore` / `or replace` disposition never swallows a refused concurrent duplicate — which is what keeps the documented "IGNORE and REPLACE refuse under concurrency" invariant true; the peer-dependency externality and one-chunk placement that `instanceof` depends on; and that no reference to the superseded "plain `Error`, match the message" claim survives anywhere in source or docs.

**Tests are not vacuous.** The handoff had not watched the new assertions fail. I reverted the mapping to `new Error(message, { cause })`, rebuilt, and ran the three concurrency specs: all six new assertions failed with the expected `Error (code=undefined)` detail, then I restored and re-ran clean. The handoff's unexplained 997-vs-1000 count gap is benign: the fix-stage commit contains no test files, so its 1000 came from uncommitted probe specs, and the implement diff removes no `it` block.

**Fixed inline (minor):**

- The class dispatch was split across two methods — `renderRefusal` chose the message by class, `mapCommitRefusal` chose the type by a second `instanceof` with the lost-update type in the `else`. Correct today only because the message dispatch returns `undefined` for any other subclass; a future `TreeGuardRefusedError` subclass that registered a message would silently inherit `ConcurrentModificationError`. Folded into one `mapRefusal` returning `{ message, raise }`, so registering a message and naming the error type are one decision at one site.
- Added a `NOTE:` at `mapCommitRefusal` recording that a **staging-time** `ConstraintError` is the one mapped error the engine replaces rather than propagates: `translateConflictError` rebuilds it as `FailConflictError` / `RollbackConflictError` under `or fail` / `or rollback`, copying message and code but not `cause`. Same treatment a sequential duplicate gets — which is the point — but the `cause` promise is narrower there than at a commit-time refusal, and nothing said so.
- Sharpened the live-read `NOTE:` in `OptimysticVirtualTable.runQuery` (the accepted non-goal): the refusal a live read inside a doomed transaction surfaces early is now missing a *type and code*, not just a message, which is what a reader of that tripwire needs to know.

**Tripwires parked, no ticket:** the two `NOTE:`s above. Both are conditional — one only bites a future subclass, the other only a client reading `cause` on two dispositions of a mesh-only staging refusal.

**No tickets filed.** Nothing reached the filing bar: no defect survived verification, and both residuals are conditional rather than latent.

**Left unpinned, deliberately:** the type of a *staging-time* refusal (the vtab DML catch's own call into `mapCommitRefusal`), which needs a two-node mesh where the tracker fetches a rival's commit the pre-stage probe had not. It goes through the same single dispatch as every commit-time refusal, and no deterministic trigger exists, so a test there would be flaky rather than informative.

## Validation

From the repository root: `yarn build`, `yarn typecheck` (clean), `yarn lint` (no output), `yarn lint:docs` (47 documents, all citations resolve), `yarn lint:deps` (majors and undeclared-import guards clean), `yarn workspace @optimystic/db-core test` (1838 passing, 0 failing), and `yarn test` in `packages/quereus-plugin-optimystic` (997 passing, 0 failing, 13 pending; `smoke ok quereus@4.19.4`). Not run: `yarn test:integration`, `yarn check:rn`, and the other workspaces' suites — the db-core edit is comment-only and nothing else outside the plugin changed.

A pre-existing `git stash` entry (`WIP on main: 3dfd91f ticket(fix): optimystic-db-p2p-libp2p-dep-skew`) is not from this work and was left alone.
