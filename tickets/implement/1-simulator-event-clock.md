description: Discrete-event virtual-clock engine (EventScheduler + SeededRng + LatencyModel) that founds the design simulator — advances by event completion so simulation scale decouples from wall-clock and 1M logical nodes drain in seconds, deterministically from (seed, config).
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-p2p/src/routing/responsibility.ts
  - packages/db-p2p/package.json
  - docs/cohort-topic.md
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts
effort: high
----

# Discrete-event virtual-clock engine for the design simulator

Foundation ticket for the simulator phase. The simulator must answer the design's quantitative claims (anti-flood, promotion convergence to depth `⌈log_F(N/cap_promote)⌉`, willingness back-off, reactivity replay/checkpoint coverage, matchmaking hang-out math) **before** the cohort-topic / reactivity / matchmaking subsystems commit to parameters. A virtual clock that advances by event completion (not wall-clock) is what lets the simulator reach 1M logical nodes deterministically and in seconds.

This ticket builds **only the engine**: the priority-queue scheduler over a virtual clock, the seeded PRNG, and the pluggable latency-injection strategy. It models **no** cohort/topic/reactivity/matchmaking domain behaviour — that is `simulator-fret-cohort-model` (seq 2) and later, which prereq this slug. The four engine-shaping design questions from the plan are **resolved below**; the implementer builds to those decisions and does not re-litigate them.

## Package placement

New mock-only package **`packages/substrate-simulator`** (name locked — `simulator-fret-cohort-model` already references this path). Not shipped to runtime consumers. ESM, `tsc` build, mocha+chai tests, tabs, no `any` — mirror `packages/db-p2p`'s `package.json` scripts (`build: tsc`, the `node --import ./register.mjs … mocha` test command) and add a `register.mjs` (ts-node/esm). FRET is **not** a dependency of *this* ticket — it is added by `simulator-fret-cohort-model`. This ticket has no `@optimystic/*` or `p2p-fret` runtime deps; it is self-contained, dependency-free engine code.

The event loop is **new code**, not an extension of `mesh-harness`. The harness is `async`/Promise-driven against a mock transport and generates real Ed25519 keypairs per node (`createMesh` → `generateKeyPair`); the simulator is a single-threaded, synchronous event-queue drain over a virtual clock with **synthetic** peer identities (real keypairs are far too slow at 1M). See *Decision 5 (peer identity)* below.

## Resolved design decisions (carry rationale into code comments)

### Decision 1 — Event precision: **integer milliseconds**

`type VTime = number`, unit = **integer virtual milliseconds**, monotonic non-decreasing.

- Sub-second resolution is required: per-hop RTT is ~10–200 ms and `T_rejoin_jitter` (30 s) must resolve the re-registration spike *shape*; seconds would erase both. Coarser-than-ms buys nothing the domain needs.
- **Integers, not floats.** `now()`, every `at`, and every `LatencyModel.hopDelay` result are integers. Avoids IEEE-754 accumulation drift in `now() + delay` and keeps `(at, seq)` comparisons exact and platform-stable — a prerequisite for byte-reproducible traces. Stochastic latency draws are `Math.round`-ed to integer ms and floored at a configured minimum (see Decision 2).
- **Drain-cost consequence (document in code):** virtual time is an unbounded integer; a multi-day sim horizon is ~10^8 ms, well inside `Number.MAX_SAFE_INTEGER` (2^53). The 1M-node cost driver is the *number of heap entries*, not the clock width — addressed by Decision 3.
- Independent events at the same `at` are **not** coalesced by value; they pop in `seq` order (Decision 4 below). Only *identical-shape bursts* are collapsed, via `scheduleBatch` (Decision 3).

### Decision 2 — Latency injection: ship all three; **`DeterministicLatency` is the default**

The `LatencyModel` interface (below) is the single seam; three implementations ship so later scenarios pick per-scenario without touching the engine:

- **`DeterministicLatency(fixedMs)`** — fixed per-hop delay. Default. Conservative and trivially reproducible; the right choice for anti-flood / promotion-convergence claims that must hold *under a bound*, not on average. A fixed-delay instance also serves the "one gossip round" stabilization model of Decision 6 (expose a named `gossipRoundMs` config constant, default e.g. 200 ms — final value is the consuming ticket's call).
- **`StochasticLatency({ rttMs, sigma, minMs })`** — log-normal around a configured RTT, drawn via `ctx.rng` (Box–Muller from two `rng.nextFloat()` draws → exp), `Math.round`-ed and clamped to `>= minMs >= 0`. Realistic; the right choice for throughput / hang-out latency math.
- **`AdversarialLatency({ worstMs })` (or a per-scenario `(a,b,ctx) => VTime` strategy)** — engine-chosen worst case to stress a specific claim. May inspect `a`/`b` for targeted stress; defaults to returning `worstMs`.

All draws of randomness route through `ctx.rng`, so a `LatencyModel` swap changes only *event times*, never the determinism guarantee for a fixed seed.

### Decision 3 — Reaching 1M logical nodes: binary min-heap **plus** a batch primitive

Two complementary mechanisms:

1. **Binary min-heap** priority queue keyed on `(at, seq)`, O(log n) push/pop. This alone drains 1M discrete events in well under a second; do **not** use a sorted-array insert (O(n) insert is the trap).
2. **`scheduleBatch(at, count, run)`** — a *single heap entry* that, when fired, invokes `run(ctx, index)` for `index` in `0..count-1` in ascending order, atomically at `at`. This collapses a burst of identical-shape events (e.g. 1M simultaneous arrivals, each differing only by identity/index) into one heap slot, so the queue never holds 1M entries for one burst. Per-event *work* is still O(count); the win is heap pressure and per-entry overhead.

Guidance to encode in the package README/internals (not a separate engine feature): a domain model that needs only the **aggregate** effect of a burst (e.g. "+1M to a cohort's `directParticipants`") schedules **one ordinary event** applying the magnitude as a scalar — O(1), no per-identity materialization. Use `scheduleBatch` when per-identity detail (distinct coords) is needed but 1M heap entries are not. The scale-sweep ticket (`simulator-metrics-and-scenarios`) relies on this to make 1M reachable.

`run()` returns the count of **logical** events fired (a batch of `count` contributes `count`), so the 1M assertion is comparable across discrete vs. batched scheduling.

### Decision 4 — Determinism & tie-break

- A single integer **seed** drives one `SeededRng` (mulberry32 or xorshift128 — small, dependency-free). Every stochastic choice (latency draws, jitter, churn timing, adversarial picks, value-level tie-breaks) draws from this stream, so a run is byte-reproducible from `(seed, scenario-config)`.
- **Tie-break rule:** events with equal `at` fire in ascending `seq`, where `seq` is a monotonic counter assigned **at schedule time** and **never reset** across `run()` calls. The seed never reorders equal-`at` events — it only affects values events compute. An event scheduled *during* firing at the current `now()` gets a higher `seq` and therefore fires strictly after the already-queued equal-time cohort (deterministic, no starvation surprise).
- **`SeededRng.fork(label)`** is provided as a documented escape hatch: it derives an independent sub-stream seeded deterministically from `hash(seed ‖ label)`, so a module that wants its draws insulated from unrelated insertion-order perturbation can fork. The *primary* contract remains the single shared stream (matches the plan's "one stream" intent); `fork` is opt-in. Both are deterministic functions of `(seed, config)`, so the reproducibility guarantee holds either way. Document the tradeoff: single stream is simplest but reordering insertions reorders draws; `fork` isolates at the cost of N streams.

### Decision 5 — Peer identity & placement

The `LatencyModel` signature needs a peer handle, so this ticket defines a minimal **`PeerRef`** — an opaque synthetic identity (`{ readonly id: string }`, plus a deterministic 256-bit value for later ring math) generated from the seed, **not** a real libp2p `PeerId`/keypair. A deterministic generator produces N synthetic peers reproducibly.

This ticket does **not** implement XOR-distance ring placement or cohort selection — that is `simulator-fret-cohort-model`'s `RingModel`/`CohortModel`, which derive coordinates and distance from **real FRET math** (`hashKey`/`hashPeerId`, distance primitives). Reasoning recorded here so the next agent doesn't import the wrong thing: the plan noted the simulator "may import `MockMeshKeyNetwork`'s XOR-distance routing model" for placement, but that model is `async`, holds real `PeerId` objects, and calls `sortPeersByDistance` over multihash bytes — none of which scales to 1M synthetic peers. The placement *concept* (deterministic nearest-by-distance) is reused, but reimplemented over synthetic ids against FRET's distance primitive in ticket 2. **Do not add a dependency on `db-p2p` or import `mesh-harness` from this package.**

### Decision 6 — FRET stabilization: **assume stable; model as one gossip-round latency**

The engine does **not** drive FRET's stabilization loop (neighbor discovery, bootstrap). Cohorts are assumed already stable and reachable; (re)assembly and `n_est` recompute are modeled coarsely as a **single configurable gossip-round latency** (a scheduled event delayed by `gossipRoundMs`). Rationale (record in README): the claims the simulator must move — promotion/demotion, walk routing, willingness back-off, replay/hang-out — all assume a cohort exists and is addressable; a full stabilization state machine adds large surface that shifts none of the design's numbers. This is the only stabilization fidelity the engine offers and it **bounds the scope** of `simulator-fret-cohort-model` (which already states this). Consequence to note: bootstrap-storm / partition-heal *transport* dynamics stay out of the simulator and remain validated by `mesh-harness` and `real-libp2p.integration.spec.ts`.

## The EventScheduler contract (pinned)

```ts
/** Integer virtual milliseconds; monotonic non-decreasing. */
export type VTime = number;

/** Opaque synthetic peer identity (Decision 5). Ring placement lives in simulator-fret-cohort-model. */
export interface PeerRef {
	readonly id: string;
	/** Deterministic 256-bit synthetic id (hex/bytes) for later ring math; opaque to the engine. */
	readonly key: Uint8Array;
}

export type EventRun = (ctx: EventContext) => void;
export type BatchRun = (ctx: EventContext, index: number) => void;

export interface EventScheduler {
	/** Current virtual time = the `at` of the event currently (or most recently) firing. */
	now(): VTime;
	/** Schedule at absolute virtual time `at`. Throws if `at < now()` (causality violation — see edge cases). */
	scheduleAt(at: VTime, run: EventRun): void;
	/** Relative: scheduleAt(now() + delay, run). Throws if `delay < 0`. */
	scheduleAfter(delay: VTime, run: EventRun): void;
	/** Single heap entry that fires `run(ctx, i)` for i in 0..count-1 at `at`, ascending i (Decision 3). count >= 0; count 0 is a no-op; throws if count < 0 or at < now(). */
	scheduleBatch(at: VTime, count: number, run: BatchRun): void;
	/** Drain in (at, seq) order. Without `until`, drains to empty. With `until`, fires every event with at <= until and stops. Returns logical events fired (a batch contributes `count`). */
	run(until?: VTime): number;
	/** Queue size (heap entries pending) — for tests/metrics. */
	pending(): number;
}

export interface EventContext {
	readonly scheduler: EventScheduler;
	readonly rng: SeededRng;
	readonly latency: LatencyModel;
	/** Convenience: equals scheduler.now() at the moment this event fires. */
	readonly now: VTime;
}

export interface SeededRng {
	/** Uniform 32-bit unsigned. */
	nextU32(): number;
	/** Uniform [0, 1). */
	nextFloat(): number;
	/** Uniform integer in [0, maxExclusive). */
	nextInt(maxExclusive: number): number;
	/** Deterministic independent sub-stream seeded from hash(seed ‖ label) (Decision 4). */
	fork(label: string): SeededRng;
}

export interface LatencyModel {
	/** Integer virtual delay (ms, >= 0) for one RPC hop a → b at current load. Draws via ctx.rng. */
	hopDelay(a: PeerRef, b: PeerRef, ctx: EventContext): VTime;
}
```

### Run semantics (pin precisely)

- `run()` (no arg): pop events in `(at, seq)` order; for each, set `now = at`, build the `EventContext`, fire. Events scheduled *during* a fire are picked up because the loop re-reads the heap top each iteration. Terminates when the heap empties.
- `run(until)`: same, but stop **before** firing any event whose `at > until`; those remain queued. `now()` is left at the last fired event's `at` (it does **not** fabricate time forward to `until`). An event whose `at == until` **fires**.
- Empty queue: `run()`/`run(until)` return `0`, `now()` unchanged.
- `now()` is monotonic non-decreasing across the whole scheduler lifetime, including across multiple `run()` calls and within a `scheduleBatch` expansion.

## SimWorld seam (minimal, here; extended downstream)

Downstream tickets pass a `world` object (`simulator-metrics-and-scenarios` uses `Scenario.setup(world: SimWorld)`). Define the **core** seam here so later tickets extend by composition rather than churning the type:

```ts
export interface SimConfig {
	readonly seed: number;
	/** Coarse stabilization / gossip-round latency in ms (Decision 6). */
	readonly gossipRoundMs: VTime;
	/** Open for scenario params; later tickets widen this. */
	readonly [k: string]: unknown;
}

export interface SimWorldCore {
	readonly scheduler: EventScheduler;
	readonly rng: SeededRng;
	readonly latency: LatencyModel;
	readonly config: SimConfig;
}
```

`simulator-fret-cohort-model` adds the peer population + ring models on top of `SimWorldCore`; this ticket ships only the core four fields and a factory that wires them from `(SimConfig, LatencyModel)`. Do not add population/topics here.

## Edge cases & interactions (the implementer must cover; the reviewer will check)

- **Past-time scheduling.** `scheduleAt(at < now())` throws (causality violation — a model bug, surfaced not hidden); `scheduleAfter(delay < 0)` throws; `scheduleBatch` with `at < now()` or `count < 0` throws. `at == now()` and `delay == 0` are **allowed** and fire after the current equal-time cohort (higher `seq`).
- **Equal-`at` ordering across three sources:** (a) events queued before `run` starts, (b) events scheduled *during* firing at the same `at`, (c) batch sub-indices. Assert the total order is `seq`-ascending, with batch index ascending *within* the batch's single `seq` slot — and identical across two same-seed runs.
- **`run(until)` boundary:** event exactly at `until` fires; event at `until + 1` stays queued; a second `run(until)` with the same `until` and only future events returns `0` and leaves `now()` unchanged.
- **Reentrancy / infinite reschedule.** An event that schedules another at `now()` must not deadlock; an *unbounded* same-time reschedule loop is a model error — document that callers bound runaway scenarios with `run(until)`. (Optionally add a `maxEvents` safety backstop to `run` that throws on exceeding a configured ceiling; if added, document it. Not required by the contract.)
- **`seq` magnitude.** 1M+ events: `seq` is a JS number, exact to 2^53 — fine; document the bound.
- **Batch atomicity & determinism.** A `scheduleBatch(at, count, …)` fires all `count` invocations at the same `now == at`, ascending index, before any later-`seq` event at the same `at`; events the batch *itself* schedules land at higher `seq` and fire after the batch completes.
- **Stochastic latency floor.** `StochasticLatency` must never return a negative or sub-floor delay (would violate `at >= now()` causality on the resulting `scheduleAfter`); clamp to `>= minMs` and round to integer.
- **`fork` determinism.** Same `(seed, label)` → identical sub-stream regardless of when `fork` is called or how the parent stream has been drawn; two runs agree.
- **No real time anywhere.** No `Date.now()`, `new Date()`, `Math.random()`, `setTimeout`/`setInterval`, or `await`/Promise in the hot path. Any of these breaks byte-reproducibility (or smuggles in wall-clock). Add a test/guard that asserts their absence (e.g. a source-scan test over `src/`, plus spies asserting `setTimeout`/`Date.now` are not invoked during a drain).
- **Cross-subsystem seam check.** `simulator-fret-cohort-model` schedules (re)assembly + `n_est` recompute as events at `gossipRoundMs`; `simulator-cohort-topic-tree` schedules promotion/demotion/gossip/TTL decay; `simulator-participant-walk` schedules per-hop probes via `LatencyModel` and jittered re-registration via `scheduleAfter` + `rng`; `simulator-metrics-and-scenarios` subscribes to the fired-event stream and reads `now()` for timelines. The engine must (a) let events push events, (b) expose `now()` and `pending()`, and (c) keep `seq` global — all satisfied by the contract above. Verify nothing in the engine assumes a domain shape.

## TODO

### Phase 1 — package scaffold + RNG
- Create `packages/substrate-simulator` with `package.json` (ESM, `type: module`, `build: tsc`, the `node --import ./register.mjs … mocha "test/**/*.spec.ts"` test command mirroring `db-p2p`), `tsconfig.json`, `register.mjs` (ts-node/esm), and add it to the workspace. No `@optimystic/*` / `p2p-fret` / `db-p2p` deps.
- Implement `SeededRng` (mulberry32 or xorshift128) with `nextU32`/`nextFloat`/`nextInt`/`fork`. `fork(label)` seeds from a deterministic hash of `(seed, label)`.

### Phase 2 — scheduler core
- Implement the binary min-heap keyed on `(at, seq)` with O(log n) push/pop; `seq` is a never-reset monotonic counter assigned at schedule time.
- Implement `EventScheduler`: `now`, `scheduleAt`, `scheduleAfter`, `scheduleBatch`, `run(until?)`, `pending`, with the run semantics and past-time/`count<0` rejection above. Build `EventContext` per fire (carry `rng`, `latency`, `now`).

### Phase 3 — latency models + SimWorld core
- Implement `LatencyModel` and the three strategies: `DeterministicLatency(fixedMs)` (default; expose `gossipRoundMs` constant for Decision 6), `StochasticLatency({rttMs, sigma, minMs})` (log-normal via Box–Muller on `ctx.rng`, rounded + floored), `AdversarialLatency({worstMs})` (or strategy fn).
- Implement `PeerRef` + the deterministic synthetic-peer generator, and the `SimWorldCore` factory wiring `(SimConfig, LatencyModel)` → `{ scheduler, rng, latency, config }`.

### Phase 4 — tests + docs
- Add the *Done when* tests (below).
- Add `packages/substrate-simulator/README.md` (or a docs entry) recording Decisions 1–6 and the aggregate-vs-batch 1M guidance, so domain tickets inherit the rationale. Do **not** create a throwaway summary doc elsewhere; this README is the package's living doc.

## Key tests (TDD)

- Events fire in strictly non-decreasing `at` order; `now()` is monotonic and equals the firing event's `at`.
- Equal-`at` events fire in insertion (`seq`) order, identically across two runs with the same seed; an event scheduled at `now()` during a fire lands after the current equal-time cohort.
- Two full runs with the same `(seed, config)` produce **byte-identical** event traces; changing only the seed changes stochastic values but **not** the equal-time ordering rule.
- `run()` over an empty queue returns `0`; a run that schedules no further events drains to empty and terminates (no infinite loop, no wall-clock sleep).
- **1,000,000** scheduled events drain to completion in seconds; assert (a) the logical fired-event count, (b) `now()` ended monotonic, (c) no `setTimeout`/`Date.now`/`Math.random` was invoked (spy assertions) and a source-scan finds none in `src/`.
- `scheduleBatch(at, 1_000_000, run)` drains from a small heap (`pending()` stays O(1) for the burst) and fires indices `0..N-1` ascending; logical fired count includes the full `count`.
- `scheduleAfter(delay)` is exactly `scheduleAt(now()+delay)`; `scheduleAt(at < now())`, `scheduleAfter(delay < 0)`, `scheduleBatch(count < 0)` throw.
- `run(until)` fires events with `at <= until` only; an event at `until` fires, one at `until+1` stays; `now()` is not fabricated past the last fired `at`.
- A `LatencyModel` swap (`Deterministic` → `Stochastic`) changes only event times, never the determinism guarantee for a fixed seed; `StochasticLatency` never returns a sub-`minMs` or negative delay.
- `SeededRng.fork(label)` yields identical sub-streams for the same `(seed, label)` across two runs, independent of parent-stream draw interleaving.

## Done when

- `yarn build` for `packages/substrate-simulator` (tsc) is green; ESM, no `any`, tabs, small single-purpose functions.
- `yarn test` for the package passes, including every Key test above.
- No dependency on `@optimystic/*`, `p2p-fret`, or `db-p2p`; no `mesh-harness` import. No real timers / `Date.now` / `Math.random` anywhere in `src/`.
- The package README records Decisions 1–6 and the 1M aggregate-vs-batch guidance, so `simulator-fret-cohort-model` and later inherit the contract and rationale.
