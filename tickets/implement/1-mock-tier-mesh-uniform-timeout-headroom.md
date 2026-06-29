description: The long-running real-crypto mesh end-to-end tests sometimes fail not because anything is broken but because they run out of time when the whole test suite is loading the machine; give that whole family of tests the same generous time budget so a slow-but-passing test is never failed by the clock.
prereq:
files:
  - packages/db-p2p/test/reactivity/mesh-cold-to-hot.spec.ts (already 120s — verify comment, leave value)
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts (60s → 120s; line 31)
  - packages/db-p2p/test/reactivity/mesh-partition-healing.spec.ts (60s → 120s; line 34)
  - packages/db-p2p/test/reactivity/mesh-mobile-resume.spec.ts (30s → 120s; line 33)
  - packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts (30s → 120s; line 22)
  - packages/db-p2p/test/matchmaking/mesh-lifecycle.spec.ts (60s → 120s; lines 23 AND 77 — two describe blocks)
  - packages/db-p2p/test/matchmaking/mesh-sweep.spec.ts (30s → 120s; line 65)
  - packages/db-p2p/test/matchmaking/mesh-walk.spec.ts (30s → 120s; line 24)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (60s → 120s; line 80 — secondary/insurance, see notes)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts (30s → 120s; line 68 — secondary/insurance, see notes)
  - packages/db-p2p/package.json (the `test` script — no `--parallel`; do NOT change, context only)
  - packages/db-p2p/.mocharc.json (global `timeout: 10000` — do NOT change, context only)
difficulty: easy
----

# Uniform timeout headroom across the real-Ed25519 mesh e2e test class

## Chosen remedy (decided during fix): Direction 1 — raise headroom uniformly

The triage proved this is a **timeout-headroom / contention class**, not a bug in any one
test: every flagged test passes in isolation and asserts correctly; the victim set
*moves between runs of the same commit* (reactivity **and** matchmaking), which is only
explicable as suite-wide machine load tipping a genuinely-passing test past its mocha
ceiling. So the fix must cover the **whole class**, not one file.

A prior triage commit (`83ab553`) already bumped **only** `mesh-cold-to-hot` from 60s to
120s. That is exactly the whack-a-mole the report warned against — the failure simply
relocated to `mesh-tail-rotation` (60s) and `matchmaking/mesh-walk` (30s). This ticket
finishes the job: bring every sibling in the same real-Ed25519 in-process mesh e2e class
up to the **same** generous 120s ceiling so the per-test >20× run-to-run wall-clock
variance is absorbed and no member of the class can become the next victim.

### Why not Direction 3 (chase a cross-suite leak)

Investigated and ruled out during fix. The cohort-topic host owns exactly one real timer
(`setInterval` in `src/cohort-topic/host.ts:863`); the mesh harness parks it at
`gossipIntervalMs: 3_600_000` (1 hour, so it never fires in a ~7-minute suite), it is
`unref()`'d (does not pin the event loop), and `stop()` (`host.ts:876`) sets `stopped`,
calls `clearInterval`, and closes the registry/bus. The reactivity harness's virtual
timers are a plain array dropped by `scheduler.stop()` / `ReactivityMesh.stop()`. There
is **no live-timer or handle accumulation** to chase.

The harness has *already* eliminated the cheap algorithmic wins: PoW minting disabled
(`powDifficultyBits: 0`), rate limiter and replay-guard neutralized, and slope
pre-promotion disabled (`reactivity-mesh-harness.ts:296-324`). The residual cost is
inherent real-Ed25519 mesh setup plus single-process heap/GC accumulation: the suite runs
**serially in one Node process** (the `test` script has **no `--parallel`**), so tests
near the back of ~963 cases run against a large, GC-pressured heap. Triage profiling
showed kernel-wait + ts-node type-stripping dominance with no single JS hotspot. Reducing
that accumulation would require `--parallel` worker processes or splitting the suite into
separate mocha invocations — a CI-architecture change with real semantic risk (root
hooks, shared state), not justified by the evidence and out of scope for this fix.

### Why not Direction 2 (quarantine into a serial/separate lane) now

It is the right *future* hardening if 120s ever proves insufficient, but it is a
CI-policy + test-harness change (a second mocha invocation or a tagged lane) that is
larger, riskier, and not agent-confirmable (the symptom is intermittent over ~7-minute
runs). Direction 1 is the lowest-risk durable remedy and matches the headroom intent
already documented in `mesh-cold-to-hot.spec.ts`. If flakes survive 120s, file a
follow-up to pursue Direction 2.

## Scope

Set `this.timeout(120_000)` on every heavy real-Ed25519 mesh e2e describe block. Keep the
explanatory comment on each accurate: the headroom exists because these tests do real
threshold-Ed25519 mesh setup/round-trips and run near the back of a ~7-minute single-process
suite, so machine load — not a defect — is what threatens the clock. Do not invent
per-test timing claims you cannot back up; a short shared rationale is fine.

**Primary class** (the triage-named victims + their direct siblings on the same
`reactivity-mesh-harness` / `matchmaking-mesh-harness` → `cohort-topic-mesh-harness`
substrate): the reactivity `mesh-*` specs and the matchmaking `mesh-*` specs listed above.

**Secondary / insurance** (`cohort-topic-scale-antiflood`, `cohort-topic-scale-lifecycle`):
these drive the cohort mesh directly with **virtual time** (documented "fast and
deterministic") and were *not* observed flaking, but they share the same single process
and heap and still do real Ed25519. Bumping them to 120s in the same pass is cheap,
consistent insurance against them becoming the next relocation target. Apply it; note it
in the review handoff as a judgment call so the reviewer can object if they prefer to keep
those two at their lower ceilings. Leave `live-tier.spec.ts` (15s) and `node-wiring.spec.ts`
(40s, real-libp2p — a *different* substrate, not the in-process mesh) **unchanged**: neither
is in the observed class.

**Do not** raise the global `.mocharc.json` timeout (10s) — that would mask genuine hangs
in the ~900 fast unit tests. Per-describe `this.timeout()` on the heavy blocks is the
correct scope.

## Validation notes (read before running anything)

- The full `packages/db-p2p` suite is ~7 minutes and the flake is **intermittent**, so a
  single full run can neither reproduce nor confirm the fix, and several runs exceed
  agent wall-clock/idle limits. **Do not** try to confirm flakiness removal inside this
  ticket — that is a CI/human job. Document the deferral.
- What you CAN and SHOULD verify cheaply: each edited spec still **passes and still
  type-checks**. Run the changed spec files directly (fast in isolation), streaming output
  so the idle timer never expires, e.g. from `packages/db-p2p`:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/reactivity/mesh-*.spec.ts" "test/matchmaking/mesh-*.spec.ts" --reporter spec 2>&1 | tee /tmp/mesh.log`
  (and the two cohort-topic-scale specs). Never use silent `> log 2>&1` redirection.
- Confirm the package still builds / type-checks (the repo's normal `tsc` / build step for
  `db-p2p`). A bare `this.timeout(120_000)` change is type-trivial, but run it to be honest.
- If any spec surfaces a failure that is **not** a timeout and is plainly unrelated to the
  timeout edits, follow the pre-existing-error protocol (`tickets/.pre-existing-error.md`)
  rather than chasing it here.

## TODO

- [ ] Bump `this.timeout(...)` to `120_000` in the primary-class specs: `mesh-tail-rotation`,
      `mesh-partition-healing`, `mesh-mobile-resume`, `mesh-slow-subscriber` (reactivity);
      `mesh-lifecycle` (BOTH describe blocks, lines 23 & 77), `mesh-sweep`, `mesh-walk`
      (matchmaking). Keep/adjust each comment so it accurately states the headroom rationale.
- [ ] Verify `mesh-cold-to-hot` is already at 120s (it is, from commit 83ab553) and its
      comment is accurate; leave the value as-is.
- [ ] Bump the secondary/insurance specs `cohort-topic-scale-antiflood` (line 80) and
      `cohort-topic-scale-lifecycle` (line 68) to 120s; flag this as a judgment call in the
      review handoff.
- [ ] Leave `node-wiring.spec.ts` (real-libp2p, different substrate) and `live-tier.spec.ts`
      unchanged; do not touch `.mocharc.json` or the `test` script.
- [ ] Run the edited specs in isolation (streamed `--reporter spec | tee`) to confirm they
      pass and type-check. Do NOT attempt multi-run full-suite flake confirmation — defer it
      to CI/human and say so in the handoff.
- [ ] Write the review handoff honestly: the fix is a headroom bump (it masks, not removes,
      the underlying slowness), the intermittent-flake confirmation is deferred to CI, and
      Direction 2 (serialize/quarantine the mesh e2e lane) is the documented next step if
      120s proves insufficient.
