----
description: The cohort-topic tests hold the largest cluster of real-timer sleeps, including one file with over twenty; migrate them to explicit timestamps where the engine already accepts them and bounded condition-polls where a real background timer is involved.
prereq: test-wait-helpers
files: packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts, packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts, packages/db-core/test/cohort-topic/coldstart.spec.ts, packages/db-core/test/cohort-topic/member-engine.spec.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts, packages/db-p2p/src/cohort-topic/host.ts
difficulty: hard
----

The cohort-topic suites carry the biggest concentration of sleeps — `gossip-cadence.spec.ts` alone has ~21. Unlike cluster-coordinator, the cohort-topic *engine* is already time-parameterized: `handleRegister(..., now)`, `handleRenew(..., now)`, `gossipRound(now)`, and `buildCohortGossip({... })` all take an explicit `now`/timestamp. The sleeps are almost never for the engine itself — they're for (a) the **host's real background gossip driver timer**, and (b) letting **async gossip delivery** settle in the fake-node harness.

## The seam to understand

- **Engine layer (db-core + db-p2p engine calls):** pure, takes explicit `now`. Tests that call `ce.gossipRound(7_000)`, `engine.handleRegister(..., now)` etc. already pass numbers — these need NO sleep. Any file whose sleeps sit around engine calls should have the sleep deleted and the timestamp passed explicitly (several `gossip-cadence` tests already do this — e.g. the "host gossip round" describe drives rounds by hand with `gossipRound(5_000)` / `gossipRound(7_000)`).
- **Host driver timer (`packages/db-p2p/src/cohort-topic/host.ts` + `cohort-gossip-driver.ts`):** the host owns a single repeating real timer (`gossipIntervalMs`, default `DEFAULT_GOSSIP_INTERVAL_MS = 5_000`). The "gossip driver timer lifecycle" test sets `gossipIntervalMs: 25` then `delay(120)` to let several ticks fire, and asserts `dialLog` grew. This is the class of sleep to migrate.

Two options for the host-driver sleeps — **pick condition-poll as the default; only inject a clock if the driver already supports it:**

1. **Condition-poll (default).** Keep the fast `gossipIntervalMs` (25ms) and replace `await delay(120)` + `expect(gossipDials()).greaterThan(1)` with `await waitFor(() => gossipDials() > 1, { description: 'gossip driver fired multiple rounds', timeoutMs: 2000 })`. This keeps the real timer but removes the fixed padded wait — the test finishes as soon as the rounds land and fails fast (bounded) if they never do. The "no ticks after stop()" assertion becomes: record `atStop`, then `waitFor` a short quiet window OR assert equality after a bounded settle — see edge cases.
2. **Fake clock (only if cheap).** If threading an injectable `setTimer`/`now` through `host.ts`'s driver is a small, clean change matching the `rotation-rereg-scheduler` shape, do it and drive ticks with `advance()`. Given the host wires the timer at the libp2p boundary, condition-poll is expected to be the lower-risk default; document the choice made.

- **Async-settle sleeps (`delay(20)`, `delay(30)`):** these wait for `deliverGossip(...)` to flow through the fake node. Replace with `waitFor` on the resulting observable (e.g. the record appearing in the registry / the engine becoming non-idle), not a fixed sleep.

## Files

- `gossip-cadence.spec.ts` (~21 sleeps) — the bulk. Classify each sleep as engine-explicit-now (delete, pass timestamp), host-driver-timer (condition-poll), or async-settle (condition-poll on state).
- `live-tier.spec.ts`, `host-antidos-coldstart.spec.ts`, `cohort-topic-scale-lifecycle.spec.ts` (db-p2p) — same classification; scale-lifecycle already uses the mock transport per its header and is a fake-clock scale suite in spirit.
- `coldstart.spec.ts`, `member-engine.spec.ts` (db-core) — engine-level; sleeps here almost certainly become explicit `now` arguments.

## Edge cases & interactions

- **Freshness gate vs synthetic `now`.** The engine's renewal freshness gate needs a privileged withdraw/reattach stamped strictly *after* the record's last touch. Several tests deliberately use real-clock `now` because a single synthetic tick can't show monotonic advance (see the `liveRecord`/`buildMockService` comments in `gossip-cadence.spec.ts` and `service.spec.ts`). When converting to explicit timestamps, advance the passed `now` between touch and re-touch (e.g. `5_000` then `6_000`) — do NOT collapse them to one value or the gate rejects/accepts wrongly.
- **TTL staleness.** Records carry `ttl`/`lastPing`; a synthetic `now` far from the stamped `attachedAt` makes a record look instantly stale and the engine idle (vacuous pass). Stamp fixtures and drive `now` consistently.
- **"No ticks after stop()".** After `host.stop()`, proving *absence* of further ticks can't be done by waiting for a predicate to become true. Options: assert `gossipDials()` stays equal across a short bounded settle (a small real `delay` is acceptable *here* as a genuine "nothing should happen" window — document it), or make the driver expose a tick counter and assert it froze at stop. Prefer the latter if the driver already tracks it.
- **Fast interval + real timer jitter.** `gossipIntervalMs: 25` under full-suite load can still be jittery; the condition-poll timeout must be generous enough (e.g. 2s) that a loaded machine doesn't flake, while the happy path returns in ~tens of ms.
- **Assertion preservation.** A sleep that let gossip propagate must become an explicit `waitFor` on the propagated record/dial, never a bare deletion.
- **Determinism.** Re-run both `db-p2p/test/cohort-topic/**` and `db-core/test/cohort-topic/**` repeatedly.

## TODO

- Classify every sleep in each listed spec: engine-explicit-now / host-driver-timer / async-settle.
- Engine cases: delete the sleep, pass an explicit `now` (advancing it between dependent touches to satisfy the freshness gate).
- Host-driver cases: condition-poll via `waitFor` from `@optimystic/db-core/test` with a bounded timeout; only inject a clock into `host.ts`/`cohort-gossip-driver.ts` if it is a small clean change (document the decision).
- Async-settle cases: `waitFor` on the observable state, not a fixed sleep.
- Handle the "no ticks after stop()" absence-assertion explicitly (tick counter or documented bounded quiet window).
- Remove unused private `delay` where fully replaced.
- Run both cohort-topic test dirs repeatedly; confirm determinism and preserved assertions.
