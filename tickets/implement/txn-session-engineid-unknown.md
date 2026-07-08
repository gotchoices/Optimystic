description: Transactions built through a session are stamped with a placeholder engine name of "unknown", so any node that validates them rejects them as coming from an unknown engine — validation can never actually run for session-built transactions. Fix by stamping the session's real engine identifier.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts (ITransactionEngine interface, ~line 122; createTransactionStamp, ~line 85)
  - packages/db-core/src/transaction/session.ts (create hardcodes engineId 'unknown', line 53)
  - packages/db-core/src/transaction/actions-engine.ts (ActionsEngine + ACTIONS_ENGINE_ID)
  - packages/db-core/src/transaction/validator.ts (resolves engine by stamp.engineId, lines 61-67)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (QuereusEngine + QUEREUS_ENGINE_ID, line 17/41)
  - packages/db-core/test/transaction.spec.ts (validator + session test patterns; engines-map setup ~1178, session.create ~1291)
difficulty: medium
----

# Session transactions carry engineId 'unknown' — remote validation is dead on arrival

## Root cause (traced, high confidence)

`TransactionSession.create` (`session.ts:49-55`) calls:

```ts
const stamp = await createTransactionStamp(
    peerId,
    Date.now(),
    schemaHash,
    'unknown', // TODO: Get engine ID from engine
    ttlMs
);
```

So every session-built transaction gets `stamp.engineId === 'unknown'`.

`TransactionValidator.validate` (`validator.ts:61-67`) resolves the engine to
re-execute with by that stamp:

```ts
const registration = this.engines.get(stamp.engineId);
if (!registration) {
    return { valid: false, reason: `Unknown engine: ${stamp.engineId}` };
}
```

The `engines` map is keyed by the engine's **real** id — `'actions@1.0.0'`
(`ACTIONS_ENGINE_ID`) in db-core tests, `QUEREUS_ENGINE_ID` in
`createQuereusValidator` (`quereus-validator.ts:56`). `engines.get('unknown')`
is always `undefined`, so any validating node rejects the transaction before it
ever re-executes. It only appears to work today because storage-only nodes skip
validation entirely — meaning the security/validation path can *never* engage
for session-built transactions.

The gap is structural: `ITransactionEngine` (`transaction.ts:122-134`) exposes
only `execute()`. Each engine already knows its id, but only as a module-level
const (`ACTIONS_ENGINE_ID`, `QUEREUS_ENGINE_ID`) — unreachable from `session`,
which holds the engine as an `ITransactionEngine` and has no way to ask it.

## Expected behavior

A session-built transaction carries the initiating engine's real, resolvable id,
so a validating node looks up the correct engine and validates it instead of
rejecting it as "unknown".

## Fix (hypothesis)

Give the engine contract an id and read it in the session:

- **`transaction.ts`** — add `readonly id: string` to `ITransactionEngine`, with
  a doc comment: this is the value stamped into `TransactionStamp.engineId` and
  the key validators resolve the engine by; it must match the key the engine is
  registered under in the validator's `engines` map.
- **`session.ts:53`** — replace the `'unknown'` literal with `this.engine.id`
  and drop the TODO.
- **`actions-engine.ts`** — add `readonly id = ACTIONS_ENGINE_ID;` to
  `ActionsEngine`.
- **`quereus-engine.ts`** — add `readonly id = QUEREUS_ENGINE_ID;` to
  `QuereusEngine`. Source the value from the existing `QUEREUS_ENGINE_ID` const;
  **do not** redesign how that value is derived here — that is owned by
  `optimystic-engine-id-version-derivation` (the SQL section's "SQ-8", which makes
  the const track the installed package version). Adding this property is
  compatible with that ticket: it keeps a single source of truth for the id, so
  when SQ-8 makes `QUEREUS_ENGINE_ID` dynamic, `QuereusEngine.id` follows for
  free. No hard ordering between the two tickets.

`createTransactionStamp` already takes `engineId` as a required positional arg
(no default) — nothing to change there.

## Out of scope / not the bug

- The ticket's reference to `coordinator.ts:354-358` (`'local'`, `''`) is
  **stale**: no such placeholders exist in `coordinator.ts` today. The only
  remaining placeholder-ish values are `session.create`'s `peerId = 'local'` and
  `schemaHash = ''` **default parameters** — convenience defaults used by tests;
  real callers (`txn-bridge.ts:260` passes a real `peerId` and a
  `schemaHashProvider()` result). A `''` schemaHash would trip the validator's
  *schema-mismatch* check, not the engine check, and only ever in test code — a
  separate concern. Leave these defaults alone in this ticket. Record as a
  finding note, not new work.

## Verification

Reproduction is a direct static trace (above); confirm with a test that
exercises the session → validator path end to end using the existing
db-core test harness (`transaction.spec.ts` already builds `engines` maps and
`TransactionValidator` instances, e.g. around line 1178).

## TODO

- Add a failing test in `packages/db-core/test/transaction.spec.ts`: build a
  `TransactionSession` over `ActionsEngine`, run one `execute`, `commit` (or read
  `session.getStamp()`), then feed the resulting transaction to a
  `TransactionValidator` whose `engines` map is keyed by `ACTIONS_ENGINE_ID`.
  Assert the result is **not** `reason: 'Unknown engine: unknown'`. Also assert
  `session.getStamp().engineId === ACTIONS_ENGINE_ID` directly. Confirm it fails
  on the current code (`engineId === 'unknown'`).
- Add `readonly id: string` to `ITransactionEngine` in `transaction.ts` with a doc
  comment tying it to `TransactionStamp.engineId` and the validator registry key.
- Add `readonly id = ACTIONS_ENGINE_ID;` to `ActionsEngine`.
- Add `readonly id = QUEREUS_ENGINE_ID;` to `QuereusEngine` (value from the const;
  do not touch its derivation — see SQ-8 note above).
- Change `session.ts:53` from `'unknown'` to `this.engine.id`; remove the TODO.
- Confirm the new test passes; run the db-core transaction suite
  (`yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/db-core-test.log` or
  the repo's equivalent — check AGENTS.md) and the quereus-plugin build/typecheck
  so the added `id` property compiles against the interface.
- Grep for any other `ITransactionEngine` implementers that now need an `id`
  (`grep -rn "implements ITransactionEngine"`); at time of filing only
  `ActionsEngine` and `QuereusEngine` exist.

## Review-handoff notes

- The `peerId='local'` / `schemaHash=''` default params on `session.create` are
  left as-is by design (see "Out of scope"); flag in review findings so the
  reviewer knows it was a deliberate scope boundary, not an oversight.
- Cross-section: `QuereusEngine.id` sources from `QUEREUS_ENGINE_ID`, which
  `optimystic-engine-id-version-derivation` (SQ-8) will make version-accurate.
  Keep the id a single const so both fixes compose.
