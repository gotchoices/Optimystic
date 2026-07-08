description: Regression test ensuring a thrown transactor.pend failure still triggers cleanup of already-pended sibling collections.
files:
  - packages/db-core/test/coordinator.spec.ts (~lines 149-220)
----

## What was done

Added one regression test and one small extension to `InstrumentedTransactor` in `packages/db-core/test/coordinator.spec.ts`.

**`InstrumentedTransactor` change** — added optional third constructor param `throwCollections: Set<string>`. In `pend()`, if the requested collection id is in `throwCollections`, the method throws (`throw new Error(...)`) instead of returning `{ success: false }`. The existing `failCollections` (returned-failure) path is untouched; both shapes now exist side by side.

**New test** — `'cancels every successfully-pended collection when transactor.pend throws for one collection'` (in the `pendPhase` describe block):
- Configures 4 collections (`c0–c3`), `c2` in `throwCollections`.
- Calls `pendPhase` via the private-method cast already used by the sibling tests.
- Asserts `result.success === false`, `result.error` contains `'c2'`, and `transactor.cancelledBlockIds` (sorted) equals the three sibling `-tail` ids.

This mirrors the line-149 returned-failure test exactly, but exercises the throw path — the exact regression vector the ticket flagged as uncovered.

## Test run

`yarn workspace @optimystic/db-core test` — **1167 passing**, 0 failing.

## Known gaps / tripwires

None. The implementation (`coordinator.ts`) was already correct; this ticket only adds test coverage.

## Review findings

- No speculative concerns; the new test is a direct mirror of the existing returned-failure test.
- `cancelledBlockIds` comment in the new test says "pended before the throw" — technically all three pended concurrently and the allSettled picks them all up regardless of ordering. Wording is slightly imprecise but not misleading.
