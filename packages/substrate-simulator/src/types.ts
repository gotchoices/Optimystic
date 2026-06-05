/**
 * Core contracts for the discrete-event virtual-clock engine.
 *
 * Decision 1 — Event precision: integer virtual milliseconds. `VTime` is a JS
 * number constrained to non-negative integers, monotonic non-decreasing. Integers
 * (not floats) keep `now() + delay` exact and `(at, seq)` comparisons platform-stable,
 * a prerequisite for byte-reproducible traces. A multi-day horizon (~10^8 ms) sits far
 * inside Number.MAX_SAFE_INTEGER (2^53), so clock width is never the scale constraint —
 * the number of heap entries is (see scheduleBatch, Decision 3).
 */
export type VTime = number;

/**
 * Decision 5 — Opaque synthetic peer identity. NOT a real libp2p PeerId/keypair
 * (real Ed25519 keygen is far too slow at 1M peers). Ring placement / XOR-distance
 * math lives in `simulator-fret-cohort-model`, not here.
 */
export interface PeerRef {
	readonly id: string;
	/** Deterministic 256-bit synthetic id (bytes) for later ring math; opaque to the engine. */
	readonly key: Uint8Array;
}

export type EventRun = (ctx: EventContext) => void;
export type BatchRun = (ctx: EventContext, index: number) => void;

export interface EventScheduler {
	/** Current virtual time = the `at` of the event currently (or most recently) firing. */
	now(): VTime;
	/** Schedule at absolute virtual time `at`. Throws if `at < now()` (causality violation). */
	scheduleAt(at: VTime, run: EventRun): void;
	/** Relative: scheduleAt(now() + delay, run). Throws if `delay < 0`. */
	scheduleAfter(delay: VTime, run: EventRun): void;
	/**
	 * Single heap entry that fires `run(ctx, i)` for i in 0..count-1 at `at`, ascending i
	 * (Decision 3). count >= 0; count 0 is a no-op; throws if count < 0 or at < now().
	 */
	scheduleBatch(at: VTime, count: number, run: BatchRun): void;
	/**
	 * Drain in (at, seq) order. Without `until`, drains to empty. With `until`, fires every
	 * event with at <= until and stops. Returns logical events fired (a batch contributes `count`).
	 */
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
