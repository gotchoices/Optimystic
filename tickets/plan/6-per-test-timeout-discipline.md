description: Enforce a per-test timeout across every spec in db-core, db-p2p, and quereus-plugin-optimystic. A true hang today becomes a CI-wide stall rather than a specific test failure, which delayed the discovery of ticket 4 (solo-node deadlock). Cheap to fix, high signal-to-noise.
dependencies: none
files:
  - packages/db-core/test/*.spec.ts
  - packages/db-p2p/test/*.spec.ts
  - packages/quereus-plugin-optimystic/test/*.spec.ts
  - packages/db-core/.mocharc.* / package.json test script (root test config)
  - packages/db-p2p/.mocharc.* / package.json test script
  - packages/quereus-plugin-optimystic/.mocharc.* / package.json test script
----

## Motivation

Ticket 4's original symptom was a hang: the solo node's first DDL never resolved because `RestorationCoordinator` was dialing itself over a libp2p with no listen addrs. The harness-level test that would have caught it did not exist, but even if it had, a test with no timeout would have stalled the whole CI run rather than failing quickly and pointing at the problem.

Most specs in this repo currently rely on Mocha's default 2s timeout or don't set one at all. Network / mesh / coordinator tests frequently override with `this.timeout(30_000)` or longer, which is reasonable for slow setup but masks real hangs when the work is *supposed* to finish fast.

## Specification

Two coordinated changes per package:

### Global default

Set a Mocha-level default timeout appropriate to the package:

- `db-core`: 5s. Pure unit tests; nothing legitimate should take longer. Slow property tests can override locally.
- `db-p2p`: 10s. Mesh setup is the expensive part; individual operations should finish in seconds. Integration-gated specs (per ticket 4-real-libp2p-integration-tests) can override to 15s.
- `quereus-plugin-optimystic`: 10s. Quereus engine boot + plugin register is the slow part; SQL operations are fast.

Configured in each package's `.mocharc.*` or the root one, not by sprinkling `this.timeout(...)` in every spec.

### Explicit overrides audited

Grep for existing `this.timeout(` and `--timeout` occurrences. For each:
- If the test is legitimately long-running (mesh boot, churn, byzantine scenarios with retries), keep the explicit override and add a comment explaining why.
- If the test was just defensively bumped, remove the override and let the global default apply. A test that flakes at 5s is either actually slow (belongs in a slow suite) or has a real bug.

### CI signal

Optional: fail the test runner's summary step if any test exceeds 90% of its timeout budget three runs in a row, flagging creeping slowness before it becomes a flake. Low priority, implement only if easy.

## Expected outcomes

- A hang fails one test in <10 seconds with a clear "Timeout of Xms exceeded" error pointing at the hung spec, instead of stalling CI for minutes.
- Slow-creep regressions (a spec that was 500ms drifting to 4000ms) are visible in test output.
- Test timings become a first-class signal, not noise.

## Out of scope

- Rewriting slow tests to be fast. This ticket is just about making timeouts present and enforced. Optimizing any specific test is a follow-up per-test ticket.
- Per-assertion timeouts (e.g. `waitFor(..., { timeout: 500 })`). Those are useful but orthogonal to Mocha's per-test budget.
- Adding timeouts to helper scripts (mesh-harness construction). Helpers inherit the test's timeout; no per-helper budget needed.
