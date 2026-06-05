# @optimystic/substrate-simulator

Discrete-event virtual-clock engine that founds the Optimystic **design simulator**. It
advances by *event completion* rather than wall-clock, so simulation scale decouples from
real time and ~1M logical nodes drain in seconds, **deterministically** from `(seed, config)`.

This package is the **engine only** — a priority-queue scheduler over a virtual clock, a
seeded PRNG, and a pluggable latency-injection seam. It models **no** cohort / topic /
reactivity / matchmaking domain behaviour; that is `simulator-fret-cohort-model` and later,
which build on the `SimWorldCore` seam exported here.

Mock-only: it is **not** shipped to runtime consumers and depends on **no** `@optimystic/*`,
`p2p-fret`, or `db-p2p` code. It is self-contained, dependency-free engine code.

## Quick start

```ts
import { createSimWorld, DeterministicLatency } from '@optimystic/substrate-simulator';

const world = createSimWorld({ seed: 42, gossipRoundMs: 200 }, new DeterministicLatency(50));
world.scheduler.scheduleAt(0, ctx => {
	// schedule more events; they fire in (at, seq) order over the virtual clock
	ctx.scheduler.scheduleAfter(100, c => console.log('fired at', c.now));
});
world.scheduler.run(); // drains to empty; returns the count of logical events fired
```

## Resolved design decisions

These six decisions are settled; the engine is built to them and downstream tickets inherit
the rationale. (Source comments carry the same reasoning next to the code that implements it.)

### Decision 1 — Event precision: integer milliseconds

`VTime` is integer virtual milliseconds, monotonic non-decreasing. Sub-second resolution is
required (per-hop RTT ~10–200 ms; the 30 s rejoin jitter must resolve the re-registration
spike *shape*). **Integers, not floats** — avoids IEEE-754 drift in `now() + delay` and keeps
`(at, seq)` comparisons exact and platform-stable, a prerequisite for byte-reproducible
traces. A multi-day horizon (~10^8 ms) sits far inside `Number.MAX_SAFE_INTEGER` (2^53), so
clock width is never the scale constraint — heap entry count is (Decision 3).

### Decision 2 — Latency injection: three models, `DeterministicLatency` is the default

`LatencyModel.hopDelay(a, b, ctx)` is the single seam. All three ship so scenarios pick
per-scenario without touching the engine; all randomness routes through `ctx.rng`, so a model
swap changes only *event times*, never the determinism guarantee for a fixed seed.

- **`DeterministicLatency(fixedMs)`** — fixed per-hop delay. **Default.** Conservative and
  trivially reproducible; right for anti-flood / promotion-convergence claims that must hold
  *under a bound*. Also models the "one gossip round" assumption of Decision 6 via the
  exported `DEFAULT_GOSSIP_ROUND_MS` constant (200 ms; final value is the consumer's call).
- **`StochasticLatency({ rttMs, sigma, minMs })`** — log-normal around `rttMs` (Box–Muller on
  `ctx.rng`), `Math.round`-ed and clamped to `>= minMs >= 0`. Right for throughput / hang-out
  latency math. Never returns a sub-`minMs` or negative delay.
- **`AdversarialLatency({ worstMs })`** (or a `(a, b, ctx) => VTime` strategy) — engine-chosen
  worst case to stress a specific claim; may inspect `a`/`b`.

### Decision 3 — Reaching 1M logical nodes: min-heap + a batch primitive + aggregate scalars

Three complementary mechanisms, in increasing order of leverage:

1. **Binary min-heap** keyed on `(at, seq)`, O(log n) push/pop. This alone drains 1M discrete
   events in well under a second. (A sorted-array insert is O(n) per push — the trap to avoid.)
2. **`scheduleBatch(at, count, run)`** — a *single heap entry* that fires `run(ctx, i)` for
   `i` in `0..count-1` atomically at `at`, ascending. Collapses a burst of identical-shape
   events (e.g. 1M simultaneous arrivals differing only by index) into one heap slot, so the
   queue never holds 1M entries for one burst. Per-event *work* is still O(count); the win is
   heap pressure and per-entry overhead.
3. **Aggregate-vs-batch guidance (most important for scale):** a domain model that needs only
   the **aggregate** effect of a burst (e.g. "+1M to a cohort's `directParticipants`") should
   schedule **one ordinary event** applying the magnitude as a *scalar* — O(1), no per-identity
   materialization. Use `scheduleBatch` only when per-identity detail (distinct coords) is
   genuinely needed but 1M heap entries are not. The scale-sweep ticket
   (`simulator-metrics-and-scenarios`) relies on this to make 1M reachable.

`run()` returns the count of **logical** events fired (a batch of `count` contributes
`count`), so the 1M assertion is comparable across discrete vs. batched scheduling.

### Decision 4 — Determinism & tie-break

A single integer **seed** drives one `SeededRng` (mulberry32) stream; every stochastic choice
draws from it, so a run is byte-reproducible from `(seed, config)`. **Tie-break:** equal-`at`
events fire in ascending `seq`, a monotonic counter assigned at schedule time and never reset.
The seed never reorders equal-`at` events — it only affects the *values* events compute. An
event scheduled *during* firing at the current `now()` gets a higher `seq` and fires strictly
after the already-queued equal-time cohort.

**`SeededRng.fork(label)`** is an opt-in escape hatch: a sub-stream seeded deterministically
from `hash(seed ‖ label)`, insulating a module's draws from unrelated insertion-order
perturbation. Tradeoff — the single shared stream is simplest but reordering insertions
reorders draws; `fork` isolates at the cost of N streams. Both are deterministic functions of
`(seed, config)`, so reproducibility holds either way; the **primary** contract is the single
shared stream.

### Decision 5 — Peer identity & placement

`PeerRef` is an opaque synthetic identity (`{ id: string; key: Uint8Array }`, a deterministic
256-bit key for later ring math) generated from the seed via `generatePeers(count, rng)` —
**not** a real libp2p `PeerId`/keypair (real Ed25519 keygen is far too slow at 1M). This
package does **not** implement XOR-distance ring placement or cohort selection; that is
`simulator-fret-cohort-model`'s `RingModel`/`CohortModel`, derived from real FRET math over
these synthetic ids. Do **not** add a dependency on `db-p2p` or import `mesh-harness` here.

### Decision 6 — FRET stabilization: assume stable; model as one gossip-round latency

The engine does **not** drive FRET's stabilization loop (neighbor discovery, bootstrap).
Cohorts are assumed already stable and reachable; (re)assembly and `n_est` recompute are
modeled coarsely as a single configurable **gossip-round latency** (`gossipRoundMs`, a
scheduled event). The claims the simulator must move — promotion/demotion, walk routing,
willingness back-off, replay/hang-out — all assume an addressable cohort; a full stabilization
state machine adds large surface that shifts none of the design's numbers. Consequence:
bootstrap-storm / partition-heal *transport* dynamics stay out of the simulator and remain
validated by `mesh-harness` and `real-libp2p.integration.spec.ts`.

## The contract

See `src/types.ts` for the pinned interfaces: `EventScheduler`, `EventContext`, `SeededRng`,
`LatencyModel`, `SimConfig`, `SimWorldCore`, plus `VTime`, `PeerRef`, `EventRun`, `BatchRun`.

Run semantics:

- `run()` — pop in `(at, seq)` order; set `now = at`; fire. Events scheduled *during* a fire
  are picked up (the loop re-reads the heap top). Terminates when the heap empties.
- `run(until)` — stop **before** firing any event with `at > until`; those stay queued. An
  event at exactly `until` fires. `now()` is **not** fabricated forward to `until` — it is left
  at the last fired `at`.
- Empty queue → returns `0`, `now()` unchanged. `now()` is monotonic across the whole
  scheduler lifetime, including across multiple `run()` calls and within a batch expansion.
- Past-time / negative scheduling throws (causality violations are surfaced, not hidden):
  `scheduleAt(at < now())`, `scheduleAfter(delay < 0)`, `scheduleBatch(count < 0 | at < now())`.
  `at == now()` and `delay == 0` are allowed and fire after the current equal-time cohort.
- Optional `maxEvents` backstop (constructor option / `createSimWorld`'s `schedulerOptions`)
  throws if a single `run()` exceeds the ceiling — catches unbounded same-time reschedule
  loops. Default: no cap; bound runaway scenarios with `run(until)`.

## Build & test

```
yarn build   # tsc
yarn test    # mocha + chai over test/**/*.spec.ts
```
