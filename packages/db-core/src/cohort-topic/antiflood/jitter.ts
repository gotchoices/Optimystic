/**
 * Cohort-topic substrate — re-registration jitter (anti-flood claim 2).
 *
 * Transcribed from `docs/cohort-topic.md` §Anti-flood properties (claim 2: "Re-registration storm
 * after cohort failure") and folded back from the simulator-validated
 * `packages/substrate-simulator/src/walk.ts` (`rejoinStagger` / `rateLimitedStagger`). When a cohort
 * fails, every participant it served re-registers at once; without staggering, the recovering or
 * replacement cohort takes the whole wave in a single instant and is shoved straight past
 * `cap_promote`. Spreading the wave over `T_rejoin_jitter` (default 30 s, widened with the observed
 * FRET cohort-failure rate) bounds the recovering cohort's inbound rate to
 * `cap_promote / T_rejoin_jitter`.
 *
 * Two staggering forms, both exposed here:
 * - {@link RejoinJitter.scheduleRejoin} — a single participant draws a uniform offset over the
 *   jitter window. Decorrelates one participant's retry from its peers (the production API: a
 *   participant that loses its cohort calls this once). Random, so the bound holds *in expectation*.
 * - {@link RejoinJitter.scheduleWave} — a whole wave of `count` rejoiners is placed at a fixed
 *   interval `windowMs / cap_promote`, so **any** `windowMs`-long window contains at most
 *   `cap_promote` arrivals *by construction*. This is the hard-bound form the e2e suite asserts
 *   against; it widens the span past one window when `count > cap_promote` so the rate ceiling
 *   `cap_promote / T_rejoin_jitter` is never exceeded.
 *
 * This module is FRET-free and side-effect-free apart from the injected RNG: the caller schedules a
 * timer at the returned timestamp.
 */

import { createLogger } from "../../logger.js";

const log = createLogger("cohort-topic:antiflood");

/** Default jitter window `T_rejoin_jitter` (ms) — `docs/cohort-topic.md` §Configuration. */
export const DEFAULT_T_REJOIN_JITTER_MS = 30_000;
/** Default `cap_promote` — sets the inbound-rate ceiling `cap_promote / T_rejoin_jitter`. */
export const DEFAULT_REJOIN_CAP_PROMOTE = 64;

export interface RejoinJitterConfig {
	/** Base jitter window `T_rejoin_jitter` (ms). Default {@link DEFAULT_T_REJOIN_JITTER_MS}. */
	tRejoinJitterMs?: number;
	/** Acceptance ceiling per window; the rate bound is `capPromote / T_rejoin_jitter`. Default 64. */
	capPromote?: number;
	/**
	 * Multiplier applied to the base window to track the observed FRET cohort-failure rate (claim 2:
	 * "scaled with cohort failure rate observed from FRET"). A higher failure rate → a wider window so
	 * the larger expected re-registration wave still respects the rate ceiling. Default 1 (steady FRET).
	 */
	failureRateScale?: number;
	/** Uniform RNG in `[0, 1)`. Injected for determinism in tests; defaults to `Math.random`. */
	random?: () => number;
}

/** Staggers post-cohort-failure re-registration so the recovering cohort isn't stormed. */
export interface RejoinJitter {
	/**
	 * Jittered re-registration timestamp for **one** participant: `now + ⌊U[0, windowMs)⌋`. Random,
	 * so a wave of independent callers spreads roughly uniformly over the window.
	 */
	scheduleRejoin(now: number): number;
	/**
	 * Rate-bounded timestamps for a whole re-registration wave of `count` participants. Arrivals are
	 * evenly spaced at `windowMs / capPromote`, so any `windowMs`-long sliding window holds at most
	 * `capPromote` of them — the `cap_promote / T_rejoin_jitter` ceiling, exactly rather than in
	 * expectation. Returns one timestamp per participant, ascending.
	 */
	scheduleWave(count: number, now: number): number[];
	/** Effective jitter window (ms) = base `T_rejoin_jitter` × `failureRateScale`. */
	readonly windowMs: number;
	/** Per-window acceptance ceiling (`capPromote`); the inbound-rate bound's numerator. */
	readonly capPromote: number;
}

class StaggeredRejoinJitter implements RejoinJitter {
	readonly windowMs: number;
	readonly capPromote: number;
	private readonly random: () => number;

	constructor(config: RejoinJitterConfig = {}) {
		const base = config.tRejoinJitterMs ?? DEFAULT_T_REJOIN_JITTER_MS;
		if (!(base > 0)) {
			throw new RangeError(`tRejoinJitterMs must be > 0, got ${base}`);
		}
		const scale = config.failureRateScale ?? 1;
		if (!(scale >= 1)) {
			throw new RangeError(`failureRateScale must be >= 1, got ${scale}`);
		}
		this.capPromote = config.capPromote ?? DEFAULT_REJOIN_CAP_PROMOTE;
		if (!Number.isInteger(this.capPromote) || this.capPromote <= 0) {
			throw new RangeError(`capPromote must be a positive integer, got ${this.capPromote}`);
		}
		this.windowMs = base * scale;
		this.random = config.random ?? ((): number => Math.random());
	}

	scheduleRejoin(now: number): number {
		const offset = Math.floor(this.random() * this.windowMs);
		return now + offset;
	}

	scheduleWave(count: number, now: number): number[] {
		if (!Number.isInteger(count) || count < 0) {
			throw new RangeError(`count must be a non-negative integer, got ${count}`);
		}
		// Even spacing at windowMs/capPromote guarantees ≤ capPromote arrivals in any windowMs window;
		// for count > capPromote the wave necessarily spans more than one window, holding the rate.
		const interval = this.windowMs / this.capPromote;
		const out = new Array<number>(count);
		for (let i = 0; i < count; i++) {
			out[i] = now + Math.floor(i * interval);
		}
		log("scheduleWave count=%d window=%d cap=%d span=%d", count, this.windowMs, this.capPromote, count > 0 ? out[count - 1]! - now : 0);
		return out;
	}
}

/** Build a {@link RejoinJitter} over the configured window, rate ceiling, and (test-injectable) RNG. */
export function createRejoinJitter(config: RejoinJitterConfig = {}): RejoinJitter {
	return new StaggeredRejoinJitter(config);
}
