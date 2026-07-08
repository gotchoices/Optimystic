description: Session-built transactions used to be stamped with a fake engine name ("unknown"), so any node that validated them rejected them outright; they now carry the initiating engine's real id and validate correctly.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts (ITransactionEngine now has readonly id)
  - packages/db-core/src/transaction/session.ts (stamps engine.id instead of 'unknown')
  - packages/db-core/src/transaction/actions-engine.ts (id = ACTIONS_ENGINE_ID)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (id = QUEREUS_ENGINE_ID)
  - packages/db-core/test/transaction.spec.ts (new regression test in the validator describe block)
difficulty: medium
----

# Review: session transactions now stamp the real engine id

## What the bug was

`TransactionSession.create` stamped every session-built transaction with the
literal `engineId: 'unknown'`. `TransactionValidator.validate` resolves which
engine to re-execute with via `this.engines.get(stamp.engineId)`; that map is
keyed by each engine's real id (`ACTIONS_ENGINE_ID = "actions@1.0.0"`,
`QUEREUS_ENGINE_ID = "quereus@0.15.1"`). `engines.get('unknown')` is always
`undefined`, so any validating node rejected the transaction with
`Unknown engine: unknown` before it ever re-executed. It only looked healthy
because storage-only nodes skip validation — the validation/security path could
never engage for session-built transactions.

## What changed

- **`transaction.ts`** — `ITransactionEngine` gained `readonly id: string`, with
  a doc comment tying it to `TransactionStamp.engineId` and the validator's
  `engines`-map key.
- **`actions-engine.ts`** — `ActionsEngine.id = ACTIONS_ENGINE_ID`.
- **`quereus-engine.ts`** — `QuereusEngine.id = QUEREUS_ENGINE_ID` (sources the
  existing const; its derivation was untouched — see cross-section note).
- **`session.ts`** — `create` now stamps `engine.id` instead of `'unknown'`;
  the TODO is gone.
- **`transaction.spec.ts`** — new regression test (below).

`createTransactionStamp` already required `engineId` positionally, so nothing
changed there. Grep confirmed `ActionsEngine` and `QuereusEngine` are the only
`implements ITransactionEngine` sites, so the interface addition compiles
everywhere.

## Validation performed

- New test `should stamp session transactions with the engine id so the
  validator resolves them`: builds a `TransactionSession` over `ActionsEngine`,
  runs one `execute`, then asserts `session.getStamp().engineId ===
  ACTIONS_ENGINE_ID` (and `!== 'unknown'`), and feeds the built transaction to a
  `TransactionValidator` whose `engines` map is keyed by `ACTIONS_ENGINE_ID`,
  asserting the rejection reason does NOT include `Unknown engine`. This test
  would fail on the old code (stamp would be `'unknown'`).
- `yarn test` in `packages/db-core` → **1181 passing, 0 failing**.
- `yarn typecheck` in `packages/quereus-plugin-optimystic` → exit 0 (confirms
  `QuereusEngine.id` satisfies the new interface member).
- `npx tsc --noEmit` in `packages/db-core` → exit 0.

## Reviewer starting points (this is a floor, not a ceiling)

- **End-to-end validity is only partially exercised.** The new test asserts the
  validator no longer rejects with `Unknown engine`; it does NOT assert the
  transaction fully validates (`valid: true`). Making it fully valid requires a
  matching operations hash, which the test deliberately does not construct. A
  stronger test would drive the full `coordinator.execute` → operations-hash →
  `validator.validate(... valid:true)` path for a session-built transaction. The
  existing `'should validate a reference transaction'` test (~line 1150) does
  this for a *manually built* transaction and is the pattern to lift.
- **No new coverage for the Quereus engine.** `QuereusEngine.id` is only
  typecheck-verified, not runtime-tested through a session. If the quereus-plugin
  has a session-path test harness, exercising it would close the gap.

## Deliberate scope boundaries (not oversights)

- **`peerId='local'` / `schemaHash=''` default params on `session.create` were
  left as-is** — per the implement ticket's "Out of scope" section. These are
  convenience defaults used by tests; real callers pass a real `peerId` and a
  `schemaHashProvider()` result (`txn-bridge.ts:260`). A `''` schemaHash would
  trip the validator's *schema-mismatch* check, not the engine check, and only in
  test code — a separate concern, intentionally out of scope here.
- The implement ticket noted the original bug report's `coordinator.ts:354-358`
  reference (`'local'`, `''`) is **stale** — no such placeholders exist in
  `coordinator.ts` today. Nothing to fix there.

## Cross-section note

`QuereusEngine.id` sources from the `QUEREUS_ENGINE_ID` const. Ticket
`optimystic-engine-id-version-derivation` (the SQL section's "SQ-8") will make
that const track the installed package version. Because `id` reads the const,
that fix composes for free — no ordering dependency between the two. Keep the id
a single const so both fixes stay coherent.
