----
description: The Quereus-plugin and reference-peer end-to-end tests wait fixed amounts of time for distributed queries and reactive watches to settle; replace those with bounded "wait until the result is there" polls.
prereq: test-wait-helpers
files: packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts, packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/reference-peer/test/distributed-diary.spec.ts
difficulty: medium
----

The top-of-stack end-to-end tests: SQL-over-distributed-store (`quereus-plugin-optimystic`) and the reference peer's diary app. `distributed-transaction-validation.spec.ts` (~33 sleep matches) and `distributed-quereus.spec.ts` (~18) are the heaviest sleepers in these packages; `distributed-diary.spec.ts` has ~10. These run against a real/mock mesh where a fixed sleep is waiting for a write to propagate, a query to reflect it, or a reactive watch to fire.

## Mechanism

Condition-poll via `waitFor` / `waitForValue` from `@optimystic/db-core/test`.

- Write-then-read sleeps → `waitFor(() => <query returns the expected row(s)>)` or `waitForValue(() => <the row>, ...)`.
- Reactive-watch sleeps → `waitFor(() => watchCallback fired with expected payload)`. `reactive-watch.spec.ts` already has a private `waitUntil` (line 67) that ticket `test-wait-helpers` will have folded into the canonical `waitFor`; this ticket converts its *remaining* fixed sleeps too.
- `distributed-transaction-validation.spec.ts`'s 33 sites are likely a repeated "submit tx, sleep, assert validation outcome" shape — factor the wait into a single `waitFor` on the validation result so all 33 share one bounded helper call pattern.

Check whether the underlying mesh here is the mock mesh-harness (fake clock possible) or a real network. If mock and the propagation runs on an injectable interval, fake clock is stronger; otherwise condition-poll. Verify per file — `distributed-quereus` / `distributed-diary` likely use a real-ish mesh → condition-poll.

## Edge cases & interactions

- **Query eventual-consistency.** A read may transiently return stale/empty before the write propagates; the predicate must check for the *expected* value, and the test must not assert on the first poll result — that's the bug the sleep was hiding.
- **Reactive-watch fire-once vs fire-many.** Poll for the callback having fired with the expected payload; guard against asserting before the watch delivers, and against counting duplicate deliveries.
- **Bounded timeout.** 33 unbounded sleeps replaced by 33 polls must each be bounded, or one broken query hangs the run to idle-timeout.
- **Transaction validation timing.** `distributed-transaction-validation` asserts validation *outcomes*; ensure the poll waits for a terminal outcome (accepted/rejected), not an intermediate state, else it races.
- **Preserve assertions.** Each sleep→poll keeps the original assertion on the settled result.
- **Determinism.** Re-run these packages' suites repeatedly (stream output with `tee` — some are slow).

## TODO

- For each listed spec, classify sleeps and convert write-then-read / watch sleeps to canonical `waitFor` / `waitForValue`.
- In `distributed-transaction-validation.spec.ts`, unify the repeated submit-sleep-assert shape onto one bounded poll pattern across its ~33 sites.
- Confirm whether the mesh is mock (fake-clock candidate) or real (poll) per file; prefer fake clock only where an injectable interval exists.
- Remove unused private `delay`/`waitUntil` once replaced.
- Run `quereus-plugin-optimystic` and `reference-peer` suites repeatedly; confirm assertions preserved and determinism.
