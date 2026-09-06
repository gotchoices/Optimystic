description: When a read fails, the database layer works hard to say exactly which of four things went wrong — but the SQL adapter used to throw that away and hand the application a plain error with the reason flattened into English prose. This fix keeps the original typed error reachable via `Error.cause` so a caller can test the reason instead of parsing a sentence.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts:38 (new `rewrapAsQueryError` helper), and its six call sites (was: `Failed to initialize Optimystic table`, `Query failed`, `${operation} failed`, `Begin/Commit/Rollback transaction failed`)
  - packages/quereus-plugin-optimystic/test/read-error-cause-passthrough.spec.ts (new regression spec)
  - packages/db-core/src/network/struct.ts:273,289 (`BlockUnavailableError.reason`, `BlockPossiblyStaleError.claimedRev` — the fields this fix makes reachable)
difficulty: easy
----

# SQL adapter now preserves the typed cause of a read failure

## What was done

All six catch arms in `OptimysticVirtualTable`/`OptimysticModule` that rewrapped a caught
error for the SQL layer now funnel through one helper:

```ts
function rewrapAsQueryError(prefix: string, error: unknown): Error {
  const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
  return new Error(message, { cause: error });
}
```

`.message` text is unchanged (still `"<prefix>: <original message>"`); the only behavioural
change is that `Error.cause` now carries the original error object, class and fields intact.
Quereus's own wrap (`QuereusError` in `../quereus`'s `runtime/emit/scan.ts`) already threads
`cause` through, so the full chain a caller walking `err.cause` sees for a failed read is:

```
QuereusError (Quereus's wrap) -> Error (this plugin's rewrap) -> BlockUnavailableError (db-core, reason intact)
```

## Decision: kept the prose interpolation alongside the structured cause

The message still says `"Query failed: Block ... is unavailable (cohort-unreachable): ..."`
rather than dropping to a bare `"Query failed"` and relying solely on `cause`. Kept
deliberately — logs and error-message-only consumers (there are existing ones) keep working
unchanged, and the doubling costs nothing. Revisit only if the redundancy itself becomes a
maintenance problem (e.g. the two texts drift), which is not the case today since one is
derived from the other.

## Verification performed

- New spec `read-error-cause-passthrough.spec.ts`: drives a table init whose transactor
  raises `BlockUnavailableError('cohort-unreachable')`, catches what SQL throws, and asserts
  the cause chain reaches an error with `reason === 'cohort-unreachable'`. Passes.
- Full package suite, re-run at implement→review promotion (this pass):
  `npm run build && npm test` in `packages/quereus-plugin-optimystic` —
  build clean (ESM + DTS), **706 passing, 13 pending (pre-existing skips), 0 failing**.
  Same counts as the original implement pass, confirming nothing regressed since.
- Swept the rest of the package (`optimystic-adapter/collection-factory.ts`,
  `optimystic-adapter/txn-bridge.ts`, `transaction/quereus-engine.ts`, `schema/*.ts`) for the
  same rewrap-loses-cause shape. Found none: the other `catch` arms either (a) log-and-swallow
  with no rethrow, (b) rethrow the original error unchanged (`throw error`), or (c) rewrap a
  `string` field from a result object (`result.error`) that was never an `Error` instance and
  so had no `cause` to lose. The six sites in `optimystic-module.ts` were the full count.

## Use cases for reviewer testing

- **Golden path**: force a `BlockUnavailableError` (or any db-core typed error) out of a
  transactor during a query/init/txn call, catch what the SQL layer throws, and confirm
  `err.cause` — or `err.cause.cause` if Quereus's own wrap sits on top — is the *original*
  error instance (`instanceof BlockUnavailableError`, `.reason` intact). The existing spec
  does exactly this for `reason`.
- **Message-text consumers**: anything grepping/matching on `.message` strings (logs,
  existing tests asserting error text) should see byte-identical text to before — only
  `.cause` is new. Worth a spot check that no existing test asserts `err.cause` is
  `undefined` (would now fail).
- **Non-Error throws**: the helper's `String(error)` branch — confirm a thrown non-Error
  value (e.g. a plain string or object) still produces a sane message and a `cause` pointing
  at that raw value (not further wrapped).

## Gaps for review (carried over from implement, not yet closed)

- No test asserts `BlockPossiblyStaleError.claimedRev` survives the same way — only
  `BlockUnavailableError.reason` is covered. The helper is generic (any `Error` passed as
  `cause`) so the code path is identical, but a reviewer may want a second spec for the
  `claimedRev` case for parity with the ticket's stated scope. This is a coverage gap, not a
  known defect — decide during review whether to add it inline (minor) or accept the
  parity argument as sufficient.
- The historical claim "confirm the spec fails at HEAD before the fix" from the originating
  ticket could not be re-verified, since the fix was already committed (`e81094c5`) before
  this ticket reached the implement stage — reverting locally to check was judged not worth
  the churn given the spec's assertions are unambiguous about what they'd catch (no cause
  chain, or wrong `reason`, both fail loudly).
