description: Session-built transactions used to be stamped with a fake engine name ("unknown"), so any node that validated them rejected them outright; they now carry the initiating engine's real id and validate correctly.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts (ITransactionEngine now has readonly id)
  - packages/db-core/src/transaction/session.ts (stamps engine.id instead of 'unknown')
  - packages/db-core/src/transaction/actions-engine.ts (id = ACTIONS_ENGINE_ID)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (id = QUEREUS_ENGINE_ID)
  - packages/db-core/test/transaction.spec.ts (regression test in the validator describe block)
  - packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts (runtime engine.id assertion — added this review)
  - docs/transactions.md (ITransactionEngine interface block now documents id — added this review)
difficulty: medium
----

# Complete: session transactions now stamp the real engine id

## Summary

`TransactionSession.create` stamped every session-built transaction with the
literal `engineId: 'unknown'`. `TransactionValidator.validate` resolves the
re-execution engine via `this.engines.get(stamp.engineId)`, a map keyed by each
engine's real id (`ACTIONS_ENGINE_ID = "actions@1.0.0"`,
`QUEREUS_ENGINE_ID = "quereus@0.15.1"`). `engines.get('unknown')` is always
`undefined`, so any validating node rejected the transaction with
`Unknown engine: unknown` before re-executing. It only looked healthy because
storage-only nodes skip validation — the validation/security path could never
engage for session-built transactions.

Fix: `ITransactionEngine` gained `readonly id: string`; each engine exposes its
real id (`ActionsEngine.id = ACTIONS_ENGINE_ID`, `QuereusEngine.id =
QUEREUS_ENGINE_ID`); `session.create` stamps `engine.id` instead of `'unknown'`.

## Review findings

Reviewed the implement-stage diff (commit `2e76b0b`) with fresh eyes, then the
handoff summary. Checked SPP/DRY/modularity, type safety, error handling, docs
currency, and test coverage (happy/edge/error/regression).

### Verified correct (no change needed)
- **Core fix.** `session.ts:53` stamps `engine.id`; `ITransactionEngine.id` is
  the single contract; validator (`validator.ts:61`) resolves by that key. The
  new db-core regression test genuinely fails on the old code (`engineId ===
  'unknown'` → `Unknown engine: unknown`) and passes now.
- **Completeness of the interface change.** Grep confirmed `ActionsEngine` and
  `QuereusEngine` are the only `implements ITransactionEngine` sites; both now
  set `id`. Grep for `'unknown'` / `"unknown"` across `packages/*/src/transaction/`
  returned nothing — no other stamp site left behind.
- **No source of truth duplicated.** Each `id` reads the existing module const;
  the version-derivation follow-up (`optimystic-engine-id-version-derivation`,
  in `plan/`) composes for free.

### Minor — fixed inline this pass
- **Doc drift caused by this change.** `docs/transactions.md`'s
  `ITransactionEngine` interface block (~line 520) documented the interface
  without the new required `id` member — a reader implementing an engine from it
  would omit `id`. Added the `id` member + doc comment to that block. (The rest
  of that design doc is pre-implementation illustrative prose already stale
  independent of this change — wrong file path `engine.ts`, wrong version string
  `quereus@0.5.3`; fixing all of it is out of scope and would be scope creep.)
- **No runtime coverage for `QuereusEngine.id`** (reviewer starting point #2):
  it was only typecheck-verified. Added an assertion in the existing "QuereusEngine
  construction" block of `quereus-engine.spec.ts` that `engine.id ===
  QUEREUS_ENGINE_ID` and `!== 'unknown'`. Passes.

### Recorded as a note (not a ticket — speculative coverage, already guarded)
- **End-to-end `valid: true` for the session→validator path is not asserted**
  (reviewer starting point #1). The db-core regression test asserts only that the
  validator no longer rejects with `Unknown engine`; it does not drive a full
  matching-operations-hash `valid: true`. This is a coverage *enhancement*, not a
  defect: the bug it would catch (engine-id resolution) is already regression-
  guarded, and the full-validity path itself is covered by the existing
  `'should validate a reference transaction'` test for a manually-built
  transaction. Only worth adding if the session-built full-validity path later
  regresses — left as a note here, no ticket filed.

### Major findings
- None.

### Deliberate scope boundaries confirmed (not oversights)
- `peerId='local'` / `schemaHash=''` default params on `session.create` left
  as-is — convenience defaults for tests; real callers pass real values
  (`txn-bridge.ts:260`). A `''` schemaHash trips the *schema-mismatch* check, not
  the engine check, and only in test code. Separate concern, intentionally out of
  scope.
- The original bug report's `coordinator.ts:354-358` (`'local'`, `''`) reference
  is stale — no such placeholders exist in `coordinator.ts` today. Nothing to fix.

## Validation performed (this review)
- `yarn test` in `packages/db-core` → **1181 passing, 0 failing**.
- `yarn build` + `yarn test` in `packages/quereus-plugin-optimystic` → **305
  passing, 11 pending, 0 failing** (includes the new `engine.id` runtime test).
- `npx tsc --noEmit` in `packages/db-core` → exit 0.
- `npx tsc --noEmit` in `packages/quereus-plugin-optimystic` → exit 0.
- No lint script exists in either package (mocha+chai direct, per AGENTS.md);
  `tsc --noEmit` is the type gate.

## Cross-section note (carried forward)
`QuereusEngine.id` sources from `QUEREUS_ENGINE_ID`. Ticket
`optimystic-engine-id-version-derivation` (SQL "SQ-8") will make that const track
the installed package version; because `id` reads the const, that fix composes
with no ordering dependency. Keep the id a single const so both stay coherent.
