description: Removed real-time sleeps from three db-core test files, replacing them with condition polling and zero-latency async yields so the tests no longer depend on wall-clock timing.
prereq: test-wait-helpers
files: packages/db-core/test/coordinator.spec.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/transaction.spec.ts, packages/db-core/src/testing/async-wait.ts, packages/db-core/src/testing/test-transactor.ts
----

## What was done

Three test files carried real-time `setTimeout`-based sleeps that made them
timing-nondeterministic. All were removed:

- **coordinator.spec.ts** — dropped the module-level `delay` helper and the
  `stepMs` constructor parameter from `InstrumentedTransactor`. `pend()`/`commit()`
  now `await Promise.resolve()` (a microtask yield) instead of `await delay(stepMs)`.
  The yield still lets all N concurrent calls register before any completes, so the
  `pendMaxInFlight`/`commitMaxInFlight` fan-out assertions hold — but with no
  wall-clock cost. The two callsites that passed `stepMs = 5` were updated to the
  new 3-arg signature `(failCollections, throwCollections, throwCommitCollections)`.
- **collection.spec.ts** — the abort-mid-retry test replaced a fixed 25ms sleep with
  `waitFor(() => flaky.commitAttempts >= 1, …)`, polling the real backoff-entry
  signal before aborting.
- **transaction.spec.ts** — three sites: the slow-apply test swapped a 15ms delay for
  `await Promise.resolve()`; the expiry test now polls `isTransactionExpired(...)`
  instead of hoping 5ms outlasts a 1ms TTL; the abort-mid-backoff test uses the same
  `commitAttempts >= 1` poll as collection.spec.ts.

## Validation

- `yarn workspace @optimystic/db-core test` — **1266 passing, 0 failing**.
- `yarn workspace @optimystic/db-core build` (`tsc`, `include: ["src", "test"]`) —
  exit 0, so the test edits are type-checked, not just type-stripped at runtime.
- No lint script exists for this package; `tsc` is the type gate.

## Review findings

Adversarial pass over commit `c5b92e5`. Scope was tightly bounded (three test files,
no production code). Checked:

- **Scope completeness** — `grep` for `setTimeout|delay(` across all three files
  returns nothing; every real-time sleep the ticket claimed to remove is gone. ✔
- **Constructor-signature fallout** — searched the whole `packages/` tree for
  `stepMs` (no hits) and audited all nine `new InstrumentedTransactor(...)` callsites.
  The two that passed `stepMs` were updated; the seven others passed ≤1 positional
  arg (only `failCollections`, which stayed at position 0), so removing the old
  position-1 `stepMs` param does not silently shift their arguments. ✔
- **Concurrency-yield correctness** — `pendMaxInFlight`/`commitMaxInFlight === N`
  assertions still pass because the in-flight counter increments *before* the
  `await`, so `Promise.resolve()` (microtask) registers all N before any decrement —
  same max as the old macrotask delay. Verified by the passing suite. ✔
- **Abort-poll soundness** — `commitAttempts` increments at the top of
  `FlakyCommitTransactor.commit()`; both abort tests configure a 60s backoff with a
  1000-attempt budget, so once the poll observes `>= 1` the code is sitting in the
  long backoff sleep when `abort()` fires. Strictly more deterministic than the fixed
  sleeps it replaced. ✔
- **Expiry-poll soundness** — polling `isTransactionExpired(session.getStamp())`
  observes the actual predicate under test rather than betting a 5ms sleep outlasts a
  1ms TTL. ✔

**Fixed inline (minor):** added a `NOTE:` at transaction.spec.ts:1698 marking the
`await Promise.resolve()` as a load-bearing async-suspension point. The loop awaits
each `execute()`, so the line *looks* like a removable no-op await, but it is the
regression-detection mechanism: it gives `applyActions` a yield during which a
reverted fire-and-forget bridge would finalise the record early and drop the first
statement. The comment warns a future "simplify" pass off deleting it.

**Tripwire (recorded, not filed):** the micro- vs macrotask distinction for the
slow-apply guard. A microtask yield catches a fire-and-forget reversion that loses
statements within the same event-loop turn; a reversion that only loses them across a
*full* turn would need `delay(0)`. This is conditional ("only if a future revert has
that specific shape"), so it lives in the NOTE at the site — no ticket.

**Major findings:** none. **New tickets filed:** none.
