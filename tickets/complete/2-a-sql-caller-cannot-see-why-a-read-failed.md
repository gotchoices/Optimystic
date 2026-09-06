description: When a read fails, the storage layer says exactly which of four things went wrong — but the SQL adapter used to throw that away and hand the application a plain error with the reason flattened into English prose. The original typed error is now reachable via `Error.cause`, so a caller can test the reason instead of parsing a sentence.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`rewrapAsQueryError` helper + its six call sites)
  - packages/quereus-plugin-optimystic/test/read-error-cause-passthrough.spec.ts (regression spec, three cases)
  - packages/quereus-plugin-optimystic/README.md (new "Error Handling" section)
  - packages/db-core/src/network/struct.ts (`BlockUnavailableError.reason`, `BlockPossiblyStaleError.claimedRev` — the fields this makes reachable)
----

# SQL adapter preserves the typed cause of a read failure

## What shipped

All six catch arms in `OptimysticVirtualTable`/`OptimysticModule` that surface a caught
error to the SQL layer funnel through one helper:

```ts
function rewrapAsQueryError(prefix: string, error: unknown): Error {
  const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
  return new Error(message, { cause: error });
}
```

Call sites: table initialization, query execution, the `${operation} failed` DML arm, and
begin/commit/rollback transaction. `.message` text is byte-identical to the hand-rolled
wraps it replaced; the only behavioural change is that `Error.cause` now carries the
original error object, class and fields intact. Quereus's own wrap (`QuereusError`) threads
`cause` through as well, so a caller walking `err.cause` sees:

```
QuereusError (Quereus) -> Error (this plugin) -> BlockUnavailableError (db-core, reason intact)
```

The prose interpolation was kept alongside the structured cause deliberately: logs and
message-only consumers keep working unchanged, and one text is derived from the other so
they cannot drift.

## Review findings

### Checked

- **The implement diff read cold** (`e81094c5`) before the handoff summary. Six call sites,
  one helper, one spec — no behavioural change beyond the added `cause`.
- **Sweep for other cause-losing rewraps** across the whole package, independently of the
  implementer's claim: `grep` for `instanceof Error ?` and every `throw new Error(` in
  `src/`. Confirmed the implementer's count. Every other site is one of: a log-and-swallow
  (`ensureChangeSubscription`, `handleCollectionChange`, `teardownChangeSubscription`), a
  message-*filter* that rethrows the original (`hydrateCatalog` cold-start test, the table-scan
  mutation-retry loop), an original throw with no caught error behind it, or a rewrap of a
  `string` field off a plain-data result object.
- **`ExecutionResult` boundary** (`src/transaction/quereus-engine.ts:138`,
  `packages/db-core/src/transaction/transaction.ts:332`) — checked and *not* filed. This does
  flatten a caught `Error` into an `error?: string` field, but `ExecutionResult` is the
  plain-data result of the distributed transaction protocol, re-executed by validators on
  other nodes, where an `Error` instance cannot travel regardless. The downstream rewraps in
  `txn-bridge.ts` (`:519`, `:922`) therefore have nothing typed to lose. The commit path that
  *does* carry a real read failure (`session.commit()` -> `coordinator.commit`) throws
  through rather than returning a result, so a typed error survives it via the fix above.
- **Node/target compatibility**: `new Error(msg, { cause })` needs Node 16.9+; tsup target is
  `node16` and both `tsc --noEmit` and the DTS build are clean.
- **Docs**: `docs/transactions.md` § "Unavailable reads" already claims the reason "travels
  out verbatim, so a caller ... can catch `'cohort-unreachable'` specifically" — a claim that
  was false through the SQL adapter until this fix and is true now. No doc edit needed there.

### Found and fixed in this pass (minor)

- **Stale ticket paths embedded in source and test comments** — the helper's doc comment and
  the spec's header both cited `tickets/fix/2-a-sql-caller-cannot-see-why-a-read-failed`, a
  path that ceases to exist once the ticket completes and is pruned. Removed both; the
  comments now state the invariant on their own terms. Also trimmed the helper's doc comment
  and dropped a stray double blank line the diff introduced.
- **Coverage gaps closed** — the handoff flagged `BlockPossiblyStaleError.claimedRev` as
  untested for parity. Rather than duplicate the spec, the gated transactor now takes the
  error to raise as a parameter and the shared setup/assertion is factored into
  `catchGatedRead` / `originalCauseOf`. Three cases now: `BlockUnavailableError.reason`,
  `BlockPossiblyStaleError.claimedRev`, and a **non-`Error` throw** — the helper's
  `String(error)` branch, which had no coverage at all and is the one arm where the
  "`cause` is the raw value, not a wrapper" contract could silently regress.
- **No documented error contract for consumers** — the package README had no error-handling
  section, so the whole point of the fix (walk `cause`, don't match message text) was
  discoverable only by reading the module source. Added an "Error Handling" section with the
  wrap chain and a `rootCause` walker example.

### Filed as new tickets

None. Every finding was minor and fixed inline; nothing rose to a structural defect or an
unsettled design question.

### Tripwires recorded

None. No finding was of the "fine now, only matters if X later" shape — the two coverage
gaps were real gaps, closed rather than deferred, and the `ExecutionResult` boundary is a
deliberate protocol design rather than a condition waiting to trip.

### Not re-verified

The originating ticket's "confirm the spec fails at HEAD before the fix" step could not be
re-run: the fix landed in `e81094c5` before this ticket reached implement, and reverting
locally to check was judged not worth the churn. The assertions are unambiguous about what
they would catch — a missing cause chain and a wrong `reason`/`claimedRev` both fail loudly,
and the non-`Error` case asserts referential identity (`.to.equal(raw)`), which no wrapper
could satisfy.

## Verification

- `npm run build` in `packages/quereus-plugin-optimystic` — clean (ESM + DTS).
- `npx tsc --noEmit` — clean.
- `npx eslint` on both touched source files — clean.
- `npm test` — **708 passing, 13 pending (pre-existing skips), 0 failing**, plus the package
  smoke test. Baseline before this review pass was 706 passing / 13 pending / 0 failing; the
  delta is exactly the two cases added here.
