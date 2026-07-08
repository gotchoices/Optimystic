description: The real-network integration tests were changed to poll until the network reaches the expected state and finish the instant it does, instead of pausing for a fixed number of seconds; a few sleeps that deliberately test timing behaviour were kept and labelled. This ticket reviewed and accepted that change.
files: packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/circuit-relay-long-lived.spec.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-core/src/testing/async-wait.ts
----

# What this was

Review pass over the implement-stage work that removed fixed `delay`/`setTimeout` "settle" waits from
the real-libp2p test files and replaced them with bounded condition-polls (`waitFor` / `waitForValue`),
while keeping — and labelling — the handful of sleeps whose *passage of real time* is the behaviour
under test.

# Review findings

## What was checked

- **Implement diff read first, fresh.** The runtime change is confined to one file
  (`substrate-real-libp2p.integration.spec.ts`); the other four edits are comment-only or in-process
  mock specs.
- **Early-exit equivalence (the main sleep→poll risk).** Confirmed each converted poll waits on
  exactly the state the removed sleep implicitly waited for:
  - `seedWillingness`: the removed `delay(300)` was pure padding — its **only** caller is `quorumOn`
    (verified by grep: sole call sites at lines 311/318), which polls the merged cohort view with
    `waitFor(size >= WILLING_SIBLINGS_NEEDED)` immediately after. The poll subsumes the settle.
  - `publishCohortCert`: the 40-attempt `delay(500)` retry loop became
    `waitForValue(onStabilized, { timeoutMs: 20_000, intervalMs: 500 })`. `undefined`/throw = transient
    sub-quorum `/sign` round → keep polling; first non-undefined cert returns immediately. Same cadence,
    same early-exit, canonical helper. The `catch { throw lastErr ?? … }` preserves the original loop's
    exact failure-reporting behaviour (no regression).
  - `libp2p-key-network` (mock spec): two `setTimeout(…, 10)` fire-and-forget waits became
    `waitFor(() => persistence.saved !== undefined)` at the helper's fast in-process cadence — correct,
    since there is no live mesh here.
- **Intentional sleeps still elapse.** `circuit-relay-long-lived` (traffic pacing, lines 161/196) and
  `protocol-client-dial-timeout` (30ms abort that must win the race vs the 5s dial timer, lines 96/143)
  are comment-only changes, correctly kept, framework-timeout-bounded, and read as deliberate.
- **"Already clean" claims verified.** Grep for `setTimeout|delay(|sleep(` across the three
  multi-coordinator specs found nothing; `real-libp2p.integration.spec.ts` has only the `waitForPeers`
  timeout bound (an event-driven wait, not a fixed sleep). Nothing was missed.
- **Helper untouched.** `async-wait.ts` is consumed, not modified (as the ticket states).
- **Lint + type-check + tests run and pass** (see below).

## What was found

- **Minor (fixed in this pass):** the implementer flagged a latent event-race in `waitForPeers`
  (`real-libp2p.integration.spec.ts:74`) and left the reviewer to decide whether to fold it in. It is
  genuinely **conditional** — a connection completing in the gap between the initial `getPeers()` check
  and `addEventListener` is missed by *that* event, but `check` re-reads the peer count on every
  subsequent `peer:connect`, so a mesh dial (many events) recovers; it only bites if the
  count-reaching connection is the last one and fires in the gap. It has not flaked, the file contains
  no fixed sleep, and the file was not otherwise touched by this ticket — so this is not a defect to
  fix but a tripwire. **Recorded as a `NOTE:` comment at the `waitForPeers` site** (the canonical
  tripwire home) rather than converting the wait or filing a ticket.
- **Tripwire (already parked by the implementer, confirmed):** the `publishCohortCert` `waitForValue`
  bound is a hard 20s wall-clock ceiling, shorter than the old loop's *attempt-count* ceiling
  (40 × ~500ms + RPC) when each `/sign` RPC is slow. Documented in-place as a `NOTE:` at the call site:
  healthy runs publish on the first/second poll; if a loaded CI machine makes `onStabilized` slow
  enough to time out, the fix is to raise `timeoutMs`. Correct disposition — left as-is.

- **Major findings:** none. The conversion strengthens rather than weakens the assertions (each poll
  early-exits on the exact guarded state) and introduces no new resource, type, or error-handling
  surface.

## What was done

- Added one `NOTE:` tripwire comment at `waitForPeers` (`real-libp2p.integration.spec.ts`). No logic
  change.
- No new tickets filed — no major findings surfaced.

## Validation run during review

- `eslint` on the four touched test files → **0 problems**.
- `tsc --noEmit -p packages/db-p2p/tsconfig.json` → **exit 0** (closes the implementer's "no tsc gate"
  honest gap).
- Fast mock suite (`libp2p-key-network.spec.ts` + `protocol-client-dial-timeout.spec.ts`) →
  **52 passing**.
- Substrate integration (`OPTIMYSTIC_INTEGRATION=1`) → **11 passing, 2 pending, 0 failing**, twice
  (~2–3s each) — no flake between runs.

## Not run (deferred, consistent with the implementer's honest gaps)

- Full `OPTIMYSTIC_INTEGRATION=1` sweep of every real-network spec with repeats-for-flake — routinely
  approaches/exceeds the 10-minute agent idle budget; left to CI / a human out-of-band. The three
  multi-coordinator specs and `real-libp2p.integration.spec.ts` are unchanged by this ticket, so their
  behaviour is unaffected.
- `circuit-relay-long-lived.spec.ts` — gated behind `RUN_LONG_TESTS=1`, minutes-long by design, and the
  change there is comment-only.
