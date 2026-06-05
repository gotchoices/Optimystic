import type { VTime, PeerRef, EventContext, LatencyModel } from './types.js';

/**
 * Decision 6 — default coarse gossip-round latency. A `DeterministicLatency(gossipRoundMs)`
 * instance models the "one gossip round" stabilization assumption. Final value is the
 * consuming ticket's call; this is a sane default.
 */
export const DEFAULT_GOSSIP_ROUND_MS = 200;

/** Default fixed per-hop delay for the engine's default latency model. */
export const DEFAULT_HOP_MS = 50;

/**
 * Decision 2 (default) — fixed per-hop delay. Conservative and trivially reproducible:
 * the right choice for anti-flood / promotion-convergence claims that must hold *under a
 * bound*, not on average. Ignores `ctx.rng`, so it never perturbs the shared stream.
 */
export class DeterministicLatency implements LatencyModel {
	private readonly fixedMs: VTime;

	constructor(fixedMs: VTime) {
		if (!Number.isInteger(fixedMs) || fixedMs < 0) {
			throw new RangeError(`fixedMs must be a non-negative integer, got ${fixedMs}`);
		}
		this.fixedMs = fixedMs;
	}

	hopDelay(_a: PeerRef, _b: PeerRef, _ctx: EventContext): VTime {
		return this.fixedMs;
	}
}

export interface StochasticLatencyOptions {
	/** Geometric mean RTT in ms (must be > 0 — it is the log-normal's scale). */
	readonly rttMs: number;
	/** Log-space standard deviation (>= 0); spread of the distribution. */
	readonly sigma: number;
	/** Hard integer floor (>= 0); a draw is clamped up to this. Guarantees causality. */
	readonly minMs: number;
}

/**
 * Decision 2 — log-normal latency around a configured RTT, drawn via `ctx.rng` (Box–Muller
 * from two `nextFloat()` draws → exp), rounded and clamped to `>= minMs >= 0`. Realistic;
 * the right choice for throughput / hang-out latency math. Never returns a sub-`minMs` or
 * negative delay, which would violate `at >= now()` on the resulting `scheduleAfter`.
 */
export class StochasticLatency implements LatencyModel {
	private readonly rttMs: number;
	private readonly sigma: number;
	private readonly minMs: number;
	private readonly logRtt: number;

	constructor(options: StochasticLatencyOptions) {
		const { rttMs, sigma, minMs } = options;
		if (!(rttMs > 0)) {
			throw new RangeError(`rttMs must be > 0, got ${rttMs}`);
		}
		if (!(sigma >= 0)) {
			throw new RangeError(`sigma must be >= 0, got ${sigma}`);
		}
		if (!Number.isInteger(minMs) || minMs < 0) {
			throw new RangeError(`minMs must be a non-negative integer, got ${minMs}`);
		}
		this.rttMs = rttMs;
		this.sigma = sigma;
		this.minMs = minMs;
		this.logRtt = Math.log(rttMs);
	}

	hopDelay(_a: PeerRef, _b: PeerRef, ctx: EventContext): VTime {
		// Box–Muller: two uniforms → one standard normal. `1 - u1` keeps the log argument in (0, 1].
		const u1 = ctx.rng.nextFloat();
		const u2 = ctx.rng.nextFloat();
		const z = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
		const sample = Math.exp(this.logRtt + this.sigma * z);
		const rounded = Math.round(sample);
		return rounded < this.minMs ? this.minMs : rounded;
	}
}

/** A per-scenario worst-case strategy. May inspect `a`/`b` for targeted stress. */
export type LatencyStrategy = (a: PeerRef, b: PeerRef, ctx: EventContext) => VTime;

/**
 * Decision 2 — engine-chosen worst case to stress a specific claim. Either a fixed `worstMs`
 * or a custom strategy fn (which may inspect `a`/`b`). Defaults to returning `worstMs`.
 */
export class AdversarialLatency implements LatencyModel {
	private readonly strategy: LatencyStrategy;

	constructor(options: { worstMs: number } | LatencyStrategy) {
		if (typeof options === 'function') {
			this.strategy = options;
			return;
		}
		const { worstMs } = options;
		if (!Number.isInteger(worstMs) || worstMs < 0) {
			throw new RangeError(`worstMs must be a non-negative integer, got ${worstMs}`);
		}
		this.strategy = () => worstMs;
	}

	hopDelay(a: PeerRef, b: PeerRef, ctx: EventContext): VTime {
		return this.strategy(a, b, ctx);
	}
}
