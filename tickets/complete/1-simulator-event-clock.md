description: Discrete-event virtual-clock engine (EventScheduler + SeededRng + LatencyModel + SimWorldCore) founding the design simulator. New self-contained, mock-only package `packages/substrate-simulator`; engine only, no domain behaviour. Implemented, reviewed, and accepted.
prereq:
files:
  - packages/substrate-simulator/src/types.ts
  - packages/substrate-simulator/src/rng.ts
  - packages/substrate-simulator/src/heap.ts
  - packages/substrate-simulator/src/scheduler.ts
  - packages/substrate-simulator/src/latency.ts
  - packages/substrate-simulator/src/peer.ts
  - packages/substrate-simulator/src/world.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/README.md
  - packages/substrate-simulator/test/*.spec.ts
  - packages/substrate-simulator/package.json
  - packages/substrate-simulator/tsconfig.json
  - packages/substrate-simulator/register.mjs
  - package.json (root build/test/clean aggregate scripts)
  - README.md (root package inventory)
----

# Complete: discrete-event virtual-clock engine

The engine for the Optimystic design simulator shipped as a new mock-only, dependency-free
package `packages/substrate-simulator`, mirroring `db-p2p`'s toolchain (ESM, tabs, `tsc` build,
`node --import ./register.mjs … mocha` test). It contains the four core seams — `EventScheduler`
(virtual clock + min-heap + batch primitive), `SeededRng` (mulberry32 + deterministic `fork`),
`LatencyModel` (Deterministic / Stochastic / Adversarial), and `SimWorldCore` wiring — and **no**
cohort / topic / ring / matchmaking behaviour. Ring placement, real FRET math, and scenarios are
downstream tickets (`simulator-fret-cohort-model` and later) that compose on the `SimWorldCore`
seam exported here.

All six resolved plan decisions (event precision = integer ms; latency = three pluggable models,
Deterministic default; 1M scale via min-heap + batch + aggregate-scalar guidance; determinism via
single seeded stream + `(at, seq)` tie-break + opt-in `fork`; opaque synthetic `PeerRef`; FRET
stabilization modeled coarsely as one gossip-round latency) are recorded in `README.md` and in
source comments next to the implementing code. They were built to as written.

## Validation (post-review)

```
cd packages/substrate-simulator
yarn build      # tsc — clean, no errors
yarn test       # mocha + chai — 49 passing (~0.65 s), incl. two 1M-scale tests
```

Build is clean; the full package suite is green (was 48 at implement handoff; 49 after the review
added one regression test). The repo has no real linter — root `lint` is an `echo` placeholder and
the package defines no lint script — so the "lint must pass" gate is a no-op here, noted rather than
run. The full monorepo `yarn test` was not run (long-running, unrelated packages); the engine is
self-contained with no `@optimystic/*` / libp2p imports, so it cannot affect other packages' suites.

## Review findings

Adversarial pass over the implement-stage diff (`b5e3d83`), read fresh before the handoff summary.
Scrutinized for SPP, DRY, modularity, scalability, performance, resource cleanup, error handling,
and type safety, plus doc-sync and test-coverage gaps.

### Checked — no action needed (engine is sound)

- **Heap correctness** — binary min-heap `before(a,b) = at<at || (at==at && seq<seq)`; `seq` is a
  single never-reset counter incremented on every push (incl. batches), so it is globally unique →
  a strict total order → a deterministic heap. `pop()` n==1 / n==0 edge cases traced correct.
- **Causality & ordering** — `assertNotPast`/`assertInteger` reject `at < now()`, negative delay,
  negative/non-integer count, and non-integer times (also rejects `NaN`/`Infinity`). Events queued
  at `now()` during a fire get a higher `seq` and land strictly after the current equal-time cohort.
  Verified against the spec's run-semantics list.
- **`run(until)`** — fires `at == until`, stops before `at > until`, does **not** fabricate `now()`
  forward, and a second `run(until)` over only-future events returns 0 with `now()` unchanged.
- **Determinism** — every stochastic draw routes through the seeded `ctx.rng`; a model swap moves
  only event *times*, never the equal-`at` ordering rule. `fork(label)` keys on the *construction*
  seed (never live state), so sub-streams are independent of parent draw interleaving; fork-of-fork
  composes. `nextFloat ∈ [0,1)` ⇒ `nextInt(max) < max` (no off-by-one).
- **Scale** — 1M discrete events and a 1M `scheduleBatch` (one heap slot) both drain in seconds
  with spies proving zero `Math.random`/`Date.now`/`setTimeout`. The `no-real-time` source scan also
  rejects `await`/`Promise`/`new Date`/`setInterval`.
- **Per-event `ctx` allocation** — `fire()` builds a fresh `EventContext` per event (1M allocations
  at scale). Considered and judged correct, not a flaw: `ctx.now` is `readonly` and exposed to
  handlers that may capture it, so a hoisted-and-mutated shared ctx would be a determinism hazard.
  The allocation is the safe choice and scale tests confirm it is fast enough.
- **Latency math** — Box–Muller uses `1 - u1` to keep the log argument in `(0,1]`; result is
  `Math.round`-ed then floored to `minMs ≥ 0`, so a hop delay is never sub-`minMs` or negative
  (which would violate `at ≥ now()` on the resulting `scheduleAfter`). Constructors validate inputs.
- **`maxEvents` backstop** — counts heap pops (a batch is one pop), throwing past the ceiling on an
  unbounded same-time reschedule loop. By design it does not bound per-batch work; documented and
  matches intent.
- **Package hygiene** — `private: true`, mock-only, depends on no `@optimystic/*` / `p2p-fret` /
  `db-p2p` code; scripts/tsconfig/register.mjs mirror `db-p2p`. Root aggregate `build`/`test`/`clean`
  scripts correctly append the package; the `packages/*` workspace glob already covered install.

### Minor — fixed in this pass

- **Doc-sync: root README package inventory was stale.** `README.md`'s "## Packages" list enumerates
  every workspace package but omitted the newly added `substrate-simulator`. Added an entry flagging
  it as mock-only design-simulator dev tooling not shipped to runtime consumers.
- **Missing regression test for the batch/`until` boundary** (an adversarial angle the handoff
  explicitly flagged). A batch has a single `at`, so it is wholly before/after `until` and never
  fires partially — verified empirically, then locked with a new `scheduler.spec.ts` test
  (`run(until)` › "a batch is atomic across the until boundary"). Suite now 49 passing.

### Major — none

No findings warranted a new fix/plan/backlog ticket. The implement-stage handoff's own
"Known gaps" list (maxEvents-counts-pops, rare floor-binding at low sigma, no explicit 2^53
boundary assertion, FNV-1a not collision-proof under adversarial labels) was reviewed: each is an
accurate, low-risk, by-design tradeoff appropriate for a mock simulator, not a defect. The
near-2^53 overflow and FNV-1a label-collision concerns are bounded well outside this engine's
operating envelope (multi-day horizon ~10^8 ms; 1M+ events « 2^53) and are the natural concern of
the downstream ticket that actually chooses fork labels and scenario horizons — no separate ticket
filed.

## Downstream

`simulator-fret-cohort-model` builds `RingModel`/`CohortModel` over `generatePeers` synthetic ids
(XOR-distance ring placement, cohort selection) on top of `SimWorldCore`. When it picks `fork`
labels, a one-line sanity check that its label set does not collide under FNV-1a is worth a moment —
not a blocker, just the place where that concern actually lands.
