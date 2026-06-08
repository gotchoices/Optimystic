# @optimystic/substrate-simulator

Discrete-event virtual-clock engine that founds the Optimystic **design simulator**. It
advances by *event completion* rather than wall-clock, so simulation scale decouples from
real time and ~1M logical nodes drain in seconds, **deterministically** from `(seed, config)`.

Two layers ship here:

- **The engine** — a priority-queue scheduler over a virtual clock, a seeded PRNG, and a
  pluggable latency-injection seam. No domain behaviour; everything builds on the
  `SimWorldCore` seam.
- **The FRET model** (`RingModel` / `CohortModel` / `SizeModel`, assembled by `FretModel`) — a
  thin wrapper over **real FRET** that derives ring coordinates, cohort membership, `n_est`,
  and `d_max` from an injected synthetic population using the *same* functions production calls
  (`hashKey`, `xorDistance`, `assembleCohort`, `estimateSizeAndConfidence`). It reimplements
  none of that math; the simulator is FRET's first non-libp2p consumer.

Mock-only: it is **not** shipped to runtime consumers and depends on **no** `@optimystic/*` or
`db-p2p` code. It depends on **`p2p-fret`** (via a `portal:` path ref to the sibling FRET repo)
solely to wrap its ring/cohort/size math — see Decision 5.

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

```ts
import { createSimWorld, createRng, generatePeers, FretModel, DEFAULT_DMAX_CONFIG } from '@optimystic/substrate-simulator';

const world = createSimWorld({ seed: 42, gossipRoundMs: 200 });
const peers = generatePeers(10_000, createRng(42));
const fret = await FretModel.create(peers, { m: 8 });        // seeds a real FRET DigitreeStore

const coord = await fret.ring.coordOf(peers[0]!.key);        // FRET hashKey
const cohort = fret.cohort.assemble(coord, 15);              // FRET assembleCohort (two-sided)
const { n, confidence } = fret.size.estimate();              // FRET estimateSizeAndConfidence
const dMax = fret.size.dMax(DEFAULT_DMAX_CONFIG);            // max(0, ⌊log_F(n_est)⌋−1), clamped

fret.scheduleRecompute(world.scheduler, 200);                // recompute n_est one gossip round out
world.scheduler.run();
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
256-bit key for ring math) generated from the seed via `generatePeers(count, rng)` —
**not** a real libp2p `PeerId`/keypair (real Ed25519 keygen is far too slow at 1M). Ring
placement and cohort selection are **not** reimplemented here: `RingModel`/`CohortModel`/
`SizeModel` (assembled by `FretModel`) derive coordinates, cohorts, `n_est`, and `d_max` from
real FRET math over these synthetic keys (`hashKey` for ring placement, since synthetic peers
carry a key rather than a `PeerId`). `coordOf` is async — FRET hashes with sha256 — and is the
model's only async seam; it runs at seeding time, never inside a scheduler event, so
determinism is unaffected (sha256 is deterministic). Do **not** add a dependency on `db-p2p` or
import `mesh-harness` here.

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
