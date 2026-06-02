description: Discrete-event virtual-clock engine for the design simulator — advances by RPC-completion events so simulation scale decouples from wall-clock.
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-p2p/test/util/relay-topology.ts
  - docs/cohort-topic.md
  - docs/architecture.md
effort: high
----

# Discrete-event virtual-clock engine for the design simulator

This is the **foundation ticket** for the simulator phase. Per PROGRAM INTENT, the simulator must answer the design's quantitative claims (anti-flood, promotion convergence to depth `⌈log_F(N/cap_promote)⌉`, willingness back-off, reactivity replay/checkpoint coverage, matchmaking hang-out math) **before** the cohort-topic / reactivity / matchmaking subsystems commit to parameters or structure. A virtual clock that advances by event completion (not wall-clock) is what lets the simulator reach 1M logical nodes deterministically and in seconds.

This is a **plan** ticket because several engine-shaping design questions must be settled before any code is written. They are listed under *Open questions*. The job of this ticket is to settle them (or hand a defensible default plus the rejected alternatives to the implement ticket), define the `EventScheduler` contract, and enumerate the key tests — **not** to model any cohort/topic/reactivity/matchmaking domain behaviour (that is `simulator-fret-cohort-model` and later).

## Package placement

A new mock-only package `packages/substrate-simulator` (name TBD; not shipped to runtime consumers). It depends on FRET for ring/hash/size-estimator math (consumed in later tickets) and may import `MockMeshKeyNetwork`'s XOR-distance routing model from `packages/db-p2p/src/testing/mesh-harness.ts` for peer **placement** (deterministic peer selection by distance) — but the event loop itself is new code, not an extension of the mesh harness (the harness is `async`/Promise-driven against a mock transport; the simulator is a single-threaded event-queue drain over a virtual clock).

## The EventScheduler contract

The engine is a priority queue of timed events keyed on a virtual timestamp. Other simulator modules push events; the engine drains them in timestamp order, advancing `now()` to each event's time as it fires. There is no real `setTimeout` and no real concurrency — "parallelism" is modeled purely by interleaving events at the same or adjacent virtual times.

Sketch (final shapes to be pinned in implement):

```ts
// Virtual time. Unit (ms vs s) is an open question below.
type VTime = number;

interface ScheduledEvent {
	readonly at: VTime;          // virtual time the event fires
	readonly seq: number;        // monotonic insertion sequence — deterministic tiebreak
	run(ctx: EventContext): void; // may schedule further events via ctx.scheduler
}

interface EventScheduler {
	now(): VTime;
	/** Schedule `event` to fire at absolute virtual time `at` (must be >= now()). */
	scheduleAt(at: VTime, run: (ctx: EventContext) => void): void;
	/** Schedule relative to now(): scheduleAt(now() + delay, run). */
	scheduleAfter(delay: VTime, run: (ctx: EventContext) => void): void;
	/** Drain until the queue is empty or `until` (optional) is reached. Returns events fired. */
	run(until?: VTime): number;
}

interface EventContext {
	readonly scheduler: EventScheduler;
	readonly rng: SeededRng;     // all randomness flows through here for reproducibility
	readonly latency: LatencyModel;
}
```

### Determinism

- A single integer **seed** drives a `SeededRng` (small, dependency-free PRNG — e.g. mulberry32/xorshift). Every stochastic choice (tie-breaks beyond insertion order, latency draws, churn timing, adversarial choices) draws from this one stream so a run is byte-reproducible from `(seed, scenario-config)`.
- **Tie-break rule:** events with equal `at` fire in ascending `seq` (insertion order). Seq is the deterministic tiebreak; the seed does not reorder equal-time events (it only affects values the events compute). This keeps replays identical while still letting a scenario perturb ordering by perturbing insertion.

### Pluggable latency injection

RPC "completion" is the event that advances the clock, so per-hop latency is how the model assigns event times. The latency model is an injected strategy:

```ts
interface LatencyModel {
	/** Virtual delay for one RPC hop from peer a to peer b at current load. */
	hopDelay(a: PeerRef, b: PeerRef, ctx: EventContext): VTime;
}
```

Candidate implementations (which to ship is an open question): `DeterministicLatency` (fixed per-hop, conservative for anti-flood claims), `StochasticLatency` (log-normal around a configured RTT, realistic for throughput/hang-out latency), `AdversarialLatency` (engine-chosen worst case to stress a specific claim). The interface must support all three so later tickets can pick per-scenario without touching the engine.

## Open questions (resolve in this ticket; carry the decision + rationale into the implement ticket)

- **Event precision — ms vs s vs coarser.** Cohort-topic defaults span orders of magnitude (`ping_interval=30s`, `TTL=90s`, `T_demote=5min`) yet anti-flood jitter (`T_rejoin_jitter=30s`) and per-hop RTT (~10–200ms) need sub-second resolution to demonstrate the re-registration spike bound. Decide on a single integer unit (likely ms) and document the consequence for 1M-node drain cost; consider whether independent same-second events can be batched to cut queue churn without losing the spike shape.
- **Latency-injection model.** Deterministic vs stochastic vs adversarial — pick the default and confirm the interface above supports all three as pluggable strategies. Anti-flood claims likely want conservative/worst-case; hang-out latency wants realistic distributions.
- **Event batching strategy to reach 1M logical nodes.** Can the queue collapse a burst of identical events (e.g. 1M simultaneous arrivals) into a single parameterized event with a count, or must each be discrete? Decide the representation that keeps the 1M-event drain within seconds.
- **FRET stabilization: model or assume.** Decide whether the engine must eventually drive FRET's stabilization loop (neighbor discovery, bootstrap) or assume cohorts are already stable and reachable (model stabilization coarsely as a single gossip-round latency). The critical path is promotion/demotion + walk routing; stabilization is likely orthogonal — confirm and record. (This bounds the scope of `simulator-fret-cohort-model`.)

## Resolve later (explicit follow-up, not this ticket)

- **Calibration against real transport.** The simulator validates *relative/structural* claims (depth scales as `log_F(N)`, jitter bounds the spike), not absolute wall-clock numbers. Calibrating virtual latency against `mesh-harness` and `real-libp2p.integration.spec.ts` observations is a follow-up after the engine and first domain models exist — note it, don't do it here.

## Key tests (TDD bullets for the implement phase)

- Events fire in strictly non-decreasing timestamp order; `now()` is monotonic and equals the firing event's `at`.
- Equal-`at` events fire in insertion (`seq`) order, identically across two runs with the same seed.
- Two full runs with the same `(seed, config)` produce byte-identical event traces; changing only the seed changes stochastic values but not the equal-time ordering rule.
- `run()` over an empty queue terminates immediately (returns 0); a run that schedules no further events drains to empty and terminates (no infinite loop, no wall-clock sleep anywhere).
- 1,000,000 scheduled events drain to completion in seconds (assert an upper bound on fired-event count and that no real timer/`setTimeout` is used).
- `scheduleAfter(delay)` is exactly `scheduleAt(now()+delay)`; scheduling in the past (`at < now()`) is rejected or clamped per the documented contract.
- A `LatencyModel` swap (deterministic → stochastic) changes only event times, never the determinism guarantee for a fixed seed.
