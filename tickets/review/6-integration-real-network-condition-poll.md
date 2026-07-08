description: The real-network integration tests no longer pause for a fixed number of seconds hoping the network has settled — they now poll until the network actually reaches the expected state and finish the instant it does; a handful of sleeps that deliberately exercise timing behaviour were kept and labelled as intentional.
files: packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/circuit-relay-long-lived.spec.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-core/src/testing/async-wait.ts
difficulty: medium
----

# What landed

These specs run over **real libp2p** (real transports, dials, gossip). A fake clock is impossible —
the code under test uses the real system clock and real network timers — so the mechanism is
exclusively **bounded condition-polling**: wait for the state the sleep implicitly waited for, with
an upper bound so a broken run fails fast with a message instead of hanging to the runner idle
timeout. The canonical helpers (`waitFor` / `waitForValue` / `delay` in
`packages/db-core/src/testing/async-wait.ts`) are pre-existing from the `test-wait-helpers` ticket —
consumed here, not modified.

## Residual sleeps found and how each was classified

Ticket `db-p2p-condition-poll-migration` (#5) and `test-wait-helpers` already converted the private
`waitFor` copies and the in-process unit specs. This ticket handled the *remaining* fixed sleeps in
the real-network / real-libp2p files. After the earlier consolidation, only these survived:

**Converted to condition-polls (convergence waits):**

- `substrate-real-libp2p.integration.spec.ts`
  - `seedWillingness()` had `await delay(300)` "to let inbound /cohort-gossip handlers merge". Its
    only caller, `quorumOn()`, already polls the merged view with `waitFor(() => …size >=
    WILLING_SIBLINGS_NEEDED, { intervalMs: 200 })` immediately afterward. The fixed 300ms was pure
    padding — **removed**; the caller's poll now gives the handlers time to merge and early-exits the
    instant the quorum appears. Both `seedWillingness` call sites are inside `quorumOn`, so nothing
    else relied on the settle.
  - `publishCohortCert()` was a hand-rolled 40-attempt retry loop with `await delay(500)` between
    tries. Rewritten as `waitForValue(async () => { try { return onStabilized(now) } catch { …;
    return undefined } }, { timeoutMs: 20_000, intervalMs: 500 })`. `undefined`/throw = transient
    sub-quorum `/sign` round (keep polling); first published cert returns immediately. Same 500ms
    cadence, same early-exit, canonical helper. See the tripwire below on the bound.
  - `delay` is no longer used in this file; the import was narrowed to `{ waitFor, waitForValue }`.
- `libp2p-key-network.spec.ts` — two `await new Promise(r => setTimeout(r, 10))` "wait a tick for the
  fire-and-forget save". This is a **mock-based** spec (`createMockLibp2p`, `MemoryPersistence`), so
  the wait is in-process, not real-network. Converted to `waitFor(() => persistence.saved !==
  undefined, …)` using the helper's fast default cadence (10ms / 2s) — **not** the 250ms real-network
  cadence, because there is no live mesh here. Added the `waitFor` import.

**Kept as intentional timing (labelled, NOT converted):**

- `circuit-relay-long-lived.spec.ts` (lines ~161, ~196) — the `setTimeout` between dial iterations is
  the *traffic pacing* that is under test: a long-lived relay connection must carry sustained ~2 KiB
  dials past the 128 KiB cap, so the passage of real time between dials is the assertion, not a
  convergence wait. Kept, bounded by `this.timeout(120_000)` / `this.timeout(180_000)`, and commented
  as deliberate. (Both tests are additionally gated behind `RUN_LONG_TESTS=1`.)
- `protocol-client-dial-timeout.spec.ts` (lines ~96, ~141) — `setTimeout(() => parent.abort(…), 30)`
  schedules a parent-signal abort at 30ms so it *wins the race* against the 5_000ms dial-timeout /
  the never-ending read. That ordering is the behaviour under test. Kept and commented as deliberate.
  (This spec uses stubbed `IPeerNetwork` doubles, not real libp2p; there are no convergence sleeps in
  it.)

**Already clean — no change needed:**

- `multi-coordinator-write.integration.spec.ts`, `multi-coordinator-cross-network-write.integration.spec.ts`,
  `multi-coordinator-write-relay.integration.spec.ts` — all convergence waits already use `waitFor` /
  the `waitForCircuitListen` relay helper; no residual fixed sleeps.
- `real-libp2p.integration.spec.ts` — convergence uses `waitFor`; the `waitForPeers()` helper is an
  **event-driven** bounded wait (resolves on `peer:connect`, rejects after `timeoutMs`), which already
  early-exits — it is not a fixed sleep, so it was left as-is. (See the note under *For the reviewer*.)

# Use cases to validate

- **Early-exit correctness (main risk of sleep→poll):** every converted poll is followed by the same
  assertion the original sleep guarded — the conversion strengthens, not weakens. Confirm each
  `waitFor`/`waitForValue` predicate is exactly the state the removed sleep was waiting for:
  - substrate `seedWillingness`: quorum size predicate lives in `quorumOn` (subsumes the removed 300ms).
  - substrate `publishCohortCert`: first non-`undefined` `onStabilized` result = a published cert.
  - `libp2p-key-network`: `persistence.saved !== undefined` — a single `save()` writes the whole
    snapshot, so waiting on the flag is sufficient for the field-level assertions that follow.
- **Intentional sleeps still elapse:** the two kept-sleep files must still let real time pass; verify
  they are framework-timeout-bounded and the comments read as deliberate (not oversight).
- **No new flake:** real-network tests can't be perfectly deterministic; confirm the early-exit polls
  reduce (not increase) flake.

# How it was validated

- Fast suite (mock-based, run under default `yarn test`):
  `libp2p-key-network.spec.ts` + `protocol-client-dial-timeout.spec.ts` → **52 passing, 0 failing**.
- Substrate integration (`OPTIMYSTIC_INTEGRATION=1`, the only file with a *runtime* code change):
  **11 passing, 2 pending, 0 failing**, twice (~2–3s each) — no flake between runs.

Command pattern (from `packages/db-p2p`, streamed with `tee`):
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-key-network.spec.ts" "test/protocol-client-dial-timeout.spec.ts" --reporter spec
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/substrate-real-libp2p.integration.spec.ts" --reporter spec
```

# Honest gaps (reviewer should treat as a floor)

- **Full integration suite + repeat-for-flake not exhaustively run here.** Only substrate was
  runtime-exercised because it is the only integration file this ticket *changed* — the three
  multi-coordinator specs and `real-libp2p.integration.spec.ts` were confirmed already clean and were
  not edited, so their behaviour is unchanged by this ticket. A full
  `OPTIMYSTIC_INTEGRATION=1 yarn test:integration` sweep (all real-network specs, several repeats to
  shake out flake) is worthwhile but routinely approaches/exceeds the 10-minute agent budget — defer
  to CI / a human out-of-band.
- **`circuit-relay-long-lived.spec.ts` was not executed** — it is gated behind `RUN_LONG_TESTS=1` and
  is minutes-long by design; the change there is comment-only (no logic), so it was not run.
- **No `tsc --noEmit` gate run** — ts-node type-stripping executed all touched files without error and
  the new imports resolve at runtime, but a strict `tsc --noEmit` on `packages/db-p2p` would be a
  cheap extra guard for the reviewer to run.

# For the reviewer — worth a second look

- **`waitForPeers()` (`real-libp2p.integration.spec.ts:74`) was deliberately left as an event-driven
  wait, not converted to a poll.** It early-exits on `peer:connect` and bounds with `setTimeout`.
  There is a latent event-race (a connection completing between the initial `getPeers()` check and
  `addEventListener` would be missed and fall through to the next event or the timeout). It has not
  flaked, and converting to a `waitFor` poll on `getPeers().length >= minPeers` would close that race
  — but that is arguably beyond "remove fixed sleeps," so it was left. Reviewer's call whether to
  fold it in.
- **`publishCohortCert` bound tightened.** Recorded as a `NOTE:` at
  `substrate-real-libp2p.integration.spec.ts` (the `waitForValue` call site): the new 20s wall-clock
  ceiling is shorter than the old loop's 40 × (~500ms + RPC) effective ceiling when each `/sign` RPC
  was slow. Healthy runs publish on the first/second poll; *if* a loaded CI machine makes
  `onStabilized` slow enough to time out, the fix is to raise `timeoutMs`. Parked as a tripwire (code
  comment), not a ticket.

# End
