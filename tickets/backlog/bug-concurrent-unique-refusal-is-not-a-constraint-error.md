description: When two writers race to claim the same unique value, the loser gets an error with the right "UNIQUE constraint failed" text but not the database's standard constraint-error type, so application code that catches constraint errors by type misses it.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/concurrent-insert-refusal.spec.ts, packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts, docs/internals.md
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The message already matches a sequential duplicate exactly, so clients that match on message text work today; changing the error type alters what escapes both commit modes' failure exits and the vtab's DML catch.
----
# Concurrent UNIQUE refusals surface as a plain `Error`, not `ConstraintError`

## Behaviour

A sequential duplicate (a second `insert` of a taken primary key or secondary UNIQUE value, with the rival visible to the writer) is rejected by the Quereus engine as a `ConstraintError` with `code === StatusCode.CONSTRAINT` (19).

A *concurrent* duplicate is caught later, by the optimystic tree's concurrency guard (`TreeKeyTakenError`, including the range form `TreeRangeTakenError`). The guard runs at commit-time conflict replay, and also at initial staging when a mesh tracker has fetched a rival's commit the pre-stage probe missed. Both are rendered by `TransactionBridge.mapCommitRefusal` (`src/optimystic-adapter/txn-bridge.ts`), which returns `new Error(message, { cause })`. The message is identical (`UNIQUE constraint failed: T.Stamp`), but the error is a bare `Error` with `code === undefined`.

Observed during the implement stage of the insert-or-replace-on-pk ticket: with its pre-stage probe disabled, the staging-time guard refusal came through as `Error: UNIQUE constraint failed: T.Stamp` (code undefined), caused by `TreeRangeTakenError`. That is the same function the commit-time path uses, so the commit-time refusal is inferred (`static`) to have the same shape. Confirm by asserting `instanceOf(ConstraintError)` in `concurrent-insert-refusal.spec.ts` / `concurrent-secondary-unique-refusal.spec.ts`, which exercise two `Database` handles racing to commit.

## Expected

A refused concurrent duplicate should be indistinguishable from a sequential one to clients in error type as well as message: a `ConstraintError` (code 19), with the structured guard error still reachable via `cause`. `mapCommitRefusal` is the single seam every refusal passes through, so producing the engine's error type there covers every write path and both commit modes.

Things to check while fixing:
- the legacy sweep's "already mapped" check (`error.message === message`) must still prevent double wrapping;
- the vtab's DML catch rethrows `QuereusError`s verbatim before it maps, so a mapped `ConstraintError` must not be re-wrapped on a later pass;
- the concurrent specs currently match on message only; they should also assert type and code (the `expectConstraintError` helper in `test/secondary-unique.spec.ts` does this);
- `docs/internals.md` ("the Quereus bridge maps it to the ordinary … message") currently documents the plain-`Error` gap and should be updated with the fix.

## A second refusal class through the same seam (added by `refuse-concurrent-row-change-loser`, 2026-09-15)

`mapCommitRefusal` now also renders `TreeEntryChangedError` — the `unchanged` guard's refusal when a rival changed or removed the row an UPDATE, DELETE or REPLACE read — as `concurrent modification: another writer changed or removed the row in <table> at primary key (…)`, through `registerEntryChangedRenderer`. It has the same plain-`Error`-with-`cause` shape as the UNIQUE mapping. Whatever error type this ticket chooses must cover both classes at once: a lost update is not a uniqueness violation, so it should not become a `ConstraintError` carrying the UNIQUE wording, but it needs a typed error a client can catch by class rather than by message just the same. `test/concurrent-row-change-refusal.spec.ts` matches on message only, like the two specs above, and should gain a type assertion with them.
