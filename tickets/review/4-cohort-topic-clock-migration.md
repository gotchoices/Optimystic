----
description: Reviewed the change that moved the cohort-topic tests off fixed real-time sleeps onto explicit timestamps and bounded condition-polls, so those suites run fast and stop flaking on timing.
files: packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts, packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts, packages/db-core/test/cohort-topic/coldstart.spec.ts, packages/db-core/test/cohort-topic/member-engine.spec.ts, packages/db-core/src/testing/async-wait.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts
difficulty: hard
----

# What was implemented

Migrated the six cohort-topic spec files off fixed real-timer sleeps. Every `await delay(...)` / `setTimeout`
sleep was classified into one of three buckets and handled accordingly:

- **async-settle** (the bulk) — a sleep that waited for `gossipTransport.deliver(...)` to flow through the
  fake node / mesh before asserting. The gossip protocol handler runs on a fire-and-forget
  `void (async () => …)()` (`host.ts` `makeFrameHandler`), so the test cannot await it directly. Each became a
  `waitFor(...)` on the resulting **observable** state (record held, willingness merged, child count, forwarder
  phase, limiter size).
- **host-driver-timer** — the host owns one raw repeating `setInterval` (`host.ts:1089`, `gossipIntervalMs`);
  there is no injectable clock. Handled by **condition-poll** (default per the ticket): keep the fast interval,
  `waitFor` the observable dial/sweep count. No production code was changed (see decision below).
- **engine-explicit-now** — none needed converting: the engine calls in these files (`gossipRound(7_000)`,
  `handleRegister(..., now)`) already pass explicit timestamps; the sleeps sat around *delivery*, not the
  engine.

**No production source changed.** `host.ts` and `cohort-gossip-driver.ts` are listed only because I read them
to confirm the driver has no injectable timer seam; condition-poll was the correct, lower-risk default. Only
test files and (import-only) test helpers are in the diff.

## Per-file summary

- **`gossip-cadence.spec.ts`** (~21 sleeps, the bulk) — removed the local `const delay`; now imports
  `waitFor, delay` from `@optimystic/db-core/test`. Async-settle deliveries → `waitFor` on the merged state.
  The gossip-driver-lifecycle test polls `gossipDials() > 1` (timer fired) with a bounded 2s timeout. Four
  `delay` calls are **retained and documented** as absence/quiescence windows (see gaps).
- **`host-antidos-coldstart.spec.ts`** — local `const delay` swapped for the import. Promote-gate sweep,
  parent-link-serving flip, and child-record-count → `waitFor`. One retained `delay(30)` for the
  failed-parent-link absence assertion (documented).
- **`live-tier.spec.ts`**, **`cohort-topic-scale-lifecycle.spec.ts`** — the three/three mesh-replication
  settles → the mesh-harness `waitFor` (boolean-returning) with an explicit `5_000`ms bound, matching the
  existing in-file idiom. `delay` dropped from both harness imports.
- **`coldstart.spec.ts`**, **`member-engine.spec.ts`** (db-core) — three `setTimeout(r, 0)` microtask
  flushes → `waitFor` on the observable (`servesParentOps()`, log count, `parentCalls()`), imported from the
  db-core source `../../src/testing/async-wait.js` (not the package `/test` export — a package's own tests
  import the source directly to avoid a stale `dist`).

# Use cases to validate (reviewer)

- **Determinism under load.** Re-run both dirs repeatedly; they were stable across 2 back-to-back runs each
  (`db-p2p/test/cohort-topic/**` 213 passing / 4 pending; `db-core/test/cohort-topic/**` 426 passing). The
  loaded-machine risk is the `gossipIntervalMs: 25` timer test — its `waitFor` bound is 2s (happy path returns
  in ~tens of ms), so a slow CI box has generous headroom.
- **Freshness-gate preservation.** The `gossip-cadence` "stale eviction reordered AFTER a re-registration"
  test is the delicate one: it now `waitFor`s `eB.records(TOPIC).some(r => r.lastPing >= t2)` to prove R2
  (lastPing = t2) is applied **before** the reordered t1 eviction is delivered. Confirm this is a genuine
  observable of R2 landing (not vacuous) — `records()` returns the live registration records with their
  `lastPing`. The synthetic `t1 → t2` advance between touch and re-touch was left intact (do NOT collapse).
- **Assertion preservation.** Every migrated settle kept its original `expect(...)` (the `waitFor` guards
  propagation; the `expect` documents intent). No bare deletions.
- **Absence windows are honest, not lazy.** Confirm the retained `delay` sites are all genuine *absence*
  assertions (proving something did NOT happen — a condition-poll can't express that), each with an inline
  comment.

# Known gaps / decisions (be adversarial here)

- **Retained `delay` sites (5 total), all documented absence/quiescence windows** — not filed as tickets:
  - `gossip-cadence.spec.ts`: (a) stale-eviction-must-not-delete, (b) driver "no ticks after stop()", (c/d)
    two auth-gate "must drop" assertions.
  - `host-antidos-coldstart.spec.ts`: failed-parent-link "stays awaiting_parent, must not flip to serving".
  Each is a "nothing should happen" window sanctioned by the ticket's edge-cases section. The fully
  deterministic alternative for the driver-stop case is a driver tick-counter (production change); the ticket
  said condition-poll is the expected default and the driver does not already expose one, so I did not add it.
- **"No ticks after stop()" — chose the documented bounded window, not a tick counter.** The ticket preferred
  a tick counter "if the driver already tracks it" — it does not, and adding one is production surface I judged
  out of scope for a test-only migration. Reviewer: if you disagree, the change is small (expose a counter on
  the host, freeze-at-stop assertion).
- **Mesh-harness `waitFor` (boolean-returning, `test/cohort-topic-mesh-harness.ts:64`) was NOT migrated to the
  canonical throw-on-timeout `waitFor`.** Its own NOTE says "downstream tickets (3-8) replace each call site
  with the canonical". This ticket is #4, but its scope is the *sleeps*, and the harness file is not in my
  files list. I used the existing harness `waitFor` for the live-tier / scale-lifecycle conversions to match
  in-file idiom and keep the diff minimal. The harness-`waitFor`→canonical refactor (and eventual removal of
  the boolean wrapper) remains open work — likely folded into the broader ticket-5/6 condition-poll sweep.
- **Pre-existing unused import.** `live-tier.spec.ts` imports `bytesEqual` but never uses it — pre-existing
  (not in my diff; the file was green at baseline with it). Left untouched.
- **`gossipIntervalMs: 25` + real-timer jitter.** Under full-suite load the 25ms timer can be jittery; the
  poll timeout (2s) absorbs it. NOTE this is the one condition-poll whose *upper* bound matters — if it ever
  flakes on CI, raise that single call's `timeoutMs`, don't touch the interval.

# Validation performed

- `db-p2p/test/cohort-topic/**/*.spec.ts`: **213 passing, 4 pending**, deterministic across 2 runs (~14–15s).
- `db-core/test/cohort-topic/**/*.spec.ts`: **426 passing**, deterministic across 2 runs (~0.2s).
- Touched-file focused runs: gossip-cadence 18✓, host-antidos-coldstart 26✓, live-tier 12✓,
  scale-lifecycle 7✓/3 pending, db-core coldstart+member-engine 43✓.
- Grepped all six files post-migration: no residual `setTimeout` / fixed-`delay` sleeps except the five
  documented absence windows; the lone `new Promise<void>` left in `coldstart.spec.ts` is a deferred-ack test
  fixture, not a sleep.
- No pre-existing failures surfaced; no `tickets/.pre-existing-error.md` written.
