----
description: The real-network integration tests genuinely run over live libp2p, so they can't use a fake clock; replace their fixed "wait N seconds for the network to converge" sleeps with bounded polls that finish as soon as the network actually converges.
prereq: test-wait-helpers
files: packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/db-p2p/test/circuit-relay-long-lived.spec.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts
difficulty: medium
----

These specs run over **real libp2p** — real transports, real dials, real gossip propagation. A fake clock is impossible here: the code under test uses the real system clock and real network timers that no injection point controls. The correct mechanism is exclusively **bounded condition-polling**: wait for the network to actually reach the expected state, with an upper bound so a genuinely-broken run fails fast instead of hanging.

Most of these files already have a private `waitFor` (see `multi-coordinator-write.integration.spec.ts:64`, `real-libp2p.integration.spec.ts:94`, etc.) — ticket `test-wait-helpers` will have already replaced those private copies with the canonical import. This ticket removes the *remaining fixed sleeps* in these files that were NOT already using `waitFor`.

## Mechanism

For each residual fixed sleep:

- Find the network state it waits for (peer connected, block replicated across coordinators, relay reservation established, dial completed/timed out).
- Replace with `await waitFor(() => <state>, { timeoutMs, intervalMs: 250, description })`. Keep the larger `intervalMs`/`timeoutMs` these real-network tests use — polling a live mesh every 10ms is wasteful and can perturb it; 250ms is the established cadence.

Some sleeps here are legitimately irreducible: `protocol-client-dial-timeout.spec.ts` and `circuit-relay-long-lived.spec.ts` may *assert timeout/liveness behavior itself*, where the passage of real time is the thing under test. Those sleeps stay (a timeout test must let the timeout elapse), but should still be bounded by the test framework timeout and documented as intentional.

## Edge cases & interactions

- **Do not fake-clock these.** Any attempt to inject a clock into real libp2p is out of scope and wrong; the mechanism here is condition-poll only.
- **Irreducible timing tests.** A dial-timeout / long-lived-relay test that asserts "after T the connection is X" genuinely needs T to pass. Keep the real wait, mark it intentional with a comment, and ensure the framework `this.timeout()` covers it. Distinguish these from convergence sleeps that should become polls.
- **Poll cadence vs perturbation.** Use the existing ~250ms interval, not a tight loop; a live mesh under a fast poll can behave differently.
- **Bounded timeout headroom.** Real-network convergence is variable under load; pick a `timeoutMs` with headroom (these files already use multi-second budgets) so CI doesn't flake, while the happy path returns early.
- **Preserve assertions.** A convergence sleep becomes an explicit wait for that convergence + the same assertion, not a deletion.
- **Determinism / repeat.** Real-network tests can't be perfectly deterministic, but converting padded sleeps to early-exit polls should reduce both runtime and flake. Re-run a few times to confirm no new flake was introduced.

## TODO

- In each listed file, enumerate remaining fixed sleeps (after the `test-wait-helpers` consolidation) and classify: convergence-wait (→ `waitFor`) vs intentional-timing-assertion (keep, comment, bound by framework timeout).
- Convert convergence-waits to canonical `waitFor` with the real-network cadence (`intervalMs: 250`, multi-second `timeoutMs`).
- Comment the intentional irreducible sleeps in `protocol-client-dial-timeout` / `circuit-relay-long-lived` as deliberate.
- Run the integration specs (these are slower — stream output with `tee`); confirm assertions preserved and no new flake across a couple of runs.
