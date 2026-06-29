description: Long-running mock-tier mesh e2e tests (reactivity + matchmaking) intermittently exceed their mocha timeouts under full-suite CPU/GC contention. The failing test moves between runs (different victims each time), so it is a timeout-headroom/contention class, not a bug in any one test. Decide a durable remedy (raise headroom on the heavy mesh suites, serialize/split them, or address whatever degrades the ~7-minute run for late tests).
prereq:
files:
  - packages/db-p2p/test/reactivity/mesh-cold-to-hot.spec.ts (this.timeout(60_000); the report's two victims)
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts (this.timeout(60_000); a victim in the triage repro)
  - packages/db-p2p/test/matchmaking/mesh-walk.spec.ts (this.timeout(30_000); a victim in the triage repro)
  - packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts (this.timeout(30_000); prior-flake sibling per the report)
  - packages/db-p2p/src/testing/reactivity-mesh-harness.ts (the real-Ed25519 mesh substrate under these tests)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (buildMesh/setupTopic + per-host renewal/gossip drivers; teardown via CohortMesh.stop)
----

# Mock-tier mesh e2e tests flake on timeout under full-suite contention

## Summary

A triage pass confirmed that the full `packages/db-p2p` suite reproduces timeout
failures at HEAD, but the **specific failing tests differ from run to run**. This is a
flaky-timeout *class* affecting the long-running, real-Ed25519 "mock-tier mesh" e2e
tests — not a correctness bug in any one test. Every flagged test **passes in
isolation** and asserts correctly; they only blow their mocha timeout when the whole
~7-minute suite has loaded the machine.

## Reproduction

Command (from `packages/db-p2p`):

```
yarn test    # node --import ./register.mjs mocha "test/**/*.spec.ts" --colors --reporter min
```

### Original report (one run)
`963 passing, 30 pending, 2 failing`. Both failures in
`test/reactivity/mesh-cold-to-hot.spec.ts` (describe `reactivity / mesh — cold-to-hot
growth + delivery`):

1. `a cold collection gains subscribers across nodes and every one receives contiguous, verified notifications`
2. `[mock-tier] the tier-0 cohort promotes once subscribers cross cap_promote (the tree begins to form), and delivery still reaches all`

### Triage repro (a different run, same HEAD)
`963 passing, 30 pending, 2 failing` — but a **different two tests**, and the report's
two **passed**:

1. `matchmaking / mesh — seeker walk regimes` → `borderline regime: ... polling at requery_interval_ms ...`
   — `Timeout of 30000ms exceeded` (`test/matchmaking/mesh-walk.spec.ts`)
2. `reactivity / mesh — tail rotation continuity` → `the re-registration wave stays within cap_promote_fast (the fast-promote bound)`
   — `Timeout of 60000ms exceeded` (`test/reactivity/mesh-tail-rotation.spec.ts`)

All failures share the identical shape:

```
Error: Timeout of <N>ms exceeded. For async tests and hooks, ensure "done()" is called;
if returning a Promise, ensure it resolves.
    at listOnTimeout (node:internal/timers:608:17)
    at process.processTimers (node:internal/timers:543:7)
```

That the victim set *moved across subsystems* (reactivity **and** matchmaking) between
two runs of the same commit is the decisive evidence: this is contention/headroom, not
a per-test defect.

## What was measured

Instrumented timing of `mesh-cold-to-hot`'s cold-to-hot test (12-node, wantK 6) in
isolation showed the cost is concentrated in the **first** `subscribe` (the cold-start
cohort instantiation), with subsequent subscribes ~5 ms:

```
build: 7ms, registerCollection: 102ms, subscribesTotal: 7792ms,
subTimes: [7771, 5, 4, 4, 7], commit6: 459ms
```

Run-to-run wall-clock for that *same single test* on an otherwise-idle machine varied
enormously: ~2s (under `--prof`), ~8s (plain), and ~43.7s (as test #1 of the full
file). A V8 profile of a fast run is dominated by `ntdll.dll` (kernel wait/scheduling)
and ts-node type-stripping — i.e. real async work + scheduling latency, **no single JS
hotspot** to optimize away. The heavy tests use the largest meshes (node counts 12/16),
do real threshold Ed25519 signing per cohort/commit, and run near the back of a
~7-minute suite where heap/GC pressure is highest.

## What was ruled out

- **A bug in `mesh-cold-to-hot`.** The two reported tests passed in the triage repro;
  the failures landed on tail-rotation and matchmaking instead. The assertions are
  correct; only the clock is at issue.
- **A crypto/JS hotspot.** Profiling shows kernel-wait + module-load dominance, not a
  hot function. The work is inherent real-Ed25519 mesh setup; there is no cheap algo win.
- **A correctness regression.** 963 tests pass; the 2 failures are pure 30s/60s timeouts
  with no assertion failure.
- **A targeted timeout bump as "the fix".** Raising only `mesh-cold-to-hot`'s 60s budget
  would be whack-a-mole — this triage run already showed the failure relocating to
  `mesh-tail-rotation` (also 60s) and `matchmaking/mesh-walk` (30s). Any durable remedy
  must cover the whole heavy-mesh-suite set, not one file.

## Not done (and why)

No code change was applied. A confident, tightly-scoped *root-cause* fix is not in reach
within a triage pass: the symptom is non-deterministic and cross-subsystem, and the
candidate remedies are policy decisions (how much CI headroom to grant vs. whether to
serialize/split these e2e tests vs. whether to chase a possible cross-test resource
accumulation that slows late tests). Each warrants a deliberate call rather than an
in-place band-aid.

## Suggested directions (pick during plan/fix)

1. **Raise headroom consistently** across the heavy mock-tier mesh suites
   (`mesh-cold-to-hot`, `mesh-tail-rotation` at 60s; `mesh-walk`, `mesh-slow-subscriber`,
   `mesh-partition-healing`, `mesh-mobile-resume` at 30s) to a value that absorbs the
   observed >20× run-to-run variance (e.g. 120–180s). Lowest-risk; matches the existing
   "generous headroom over the default" intent already documented in
   `mesh-cold-to-hot.spec.ts`. Downside: masks slowness.
2. **Serialize/quarantine the e2e mesh tests** into a separate mocha invocation (or
   `--jobs 1` lane / tag) so they don't compete with the rest of the suite for the
   machine, and/or split the largest meshes into smaller node counts.
3. **Investigate cross-suite degradation** — confirm whether per-host renewal/gossip
   timers or retained mesh objects accumulate across the ~900 tests (harness teardown is
   `ReactivityMesh.stop` → `CohortMesh.stop`; verify nothing leaks live timers), which
   would progressively starve the event loop and explain why late tests time out while
   the same tests are fast in isolation. If a leak is found, that is the real fix.

## TODO

- [ ] Decide remedy direction (1/2/3 above) — this is a CI-policy + test-architecture call.
- [ ] If (1): bump timeouts across all listed heavy mesh specs in one pass; keep the
      explanatory comments accurate.
- [ ] If (3): audit harness teardown for leaked timers/handles; add a regression guard
      (e.g. assert no growth in active handles across a representative spec).
- [ ] Re-run the full `packages/db-p2p` suite several times to confirm the chosen remedy
      removes the intermittent timeouts.
