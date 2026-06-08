/**
 * Cohort-topic substrate — network-size-driven `d_max`.
 *
 * Transcribed from `docs/cohort-topic.md` §Maximum useful depth:
 *
 * ```
 * d_max = max(0, ⌊log_F(n_est)⌋ − 1)
 * ```
 *
 * If `n_est` confidence falls below `confidence_min` (default 0.3) the computation clamps to
 * `d_max = ⌊d_max_cap / 2⌋` (`d_max_cap` default 60) to avoid pathological deep probes.
 *
 * `d_max` is the start tier of the walk-toward-root and is recomputed **lazily** — participants
 * don't need it precise. The size estimate is read through the injected {@link ISizeEstimator}
 * (db-p2p wraps FRET's `estimateSizeAndConfidence`; db-core never imports FRET).
 */

import type { ISizeEstimator } from "./ports.js";

/** Lazily computes the walk start tier `d_max` from the current network-size estimate. */
export interface DMaxComputer {
	/** Reads the size estimate, applies the low-confidence clamp, returns `d_max`. */
	dMax(): number;
}

/** Default below which `n_est` confidence triggers the `d_max` clamp. */
export const DEFAULT_CONFIDENCE_MIN = 0.3;
/** Default hard cap on the walk-toward-root start tier. */
export const DEFAULT_D_MAX_CAP = 60;

export interface DMaxConfig {
	/** Network-size estimate source (db-p2p wraps FRET `estimateSizeAndConfidence`). */
	estimator: ISizeEstimator;
	/** Fan-out per tier (the `F` in `log_F`). */
	F: number;
	/** Confidence floor; below it `d_max` clamps to `⌊d_max_cap / 2⌋`. Default 0.3. */
	confidenceMin?: number;
	/** Hard cap on `d_max`; also drives the low-confidence clamp value. Default 60. */
	dMaxCap?: number;
}

/**
 * `⌊log_F(n)⌋` computed without floating-point drift near exact powers of `F`. Multiplies back up to
 * confirm the floor (`Math.log` can return e.g. `2.9999999` for `log_16(4096)`), so the result is
 * exact for all `n` representable as a JS integer.
 */
function floorLogF(n: number, F: number): number {
	if (n < 1) return 0;
	let d = Math.floor(Math.log(n) / Math.log(F));
	if (d < 0) d = 0;
	// Correct floating-point error at the boundary in both directions.
	while (Math.pow(F, d + 1) <= n) d++;
	while (d > 0 && Math.pow(F, d) > n) d--;
	return d;
}

/**
 * Build a {@link DMaxComputer}. The estimate is read on every {@link DMaxComputer.dMax} call so the
 * value tracks the latest FRET sample; callers cache it themselves if they want stability.
 */
export function makeDMaxComputer(config: DMaxConfig): DMaxComputer {
	const { estimator, F } = config;
	if (!Number.isInteger(F) || F < 2) {
		throw new RangeError(`fan-out F must be an integer ≥ 2, got ${F}`);
	}
	const confidenceMin = config.confidenceMin ?? DEFAULT_CONFIDENCE_MIN;
	const dMaxCap = config.dMaxCap ?? DEFAULT_D_MAX_CAP;
	if (!Number.isInteger(dMaxCap) || dMaxCap < 0) {
		throw new RangeError(`d_max_cap must be a non-negative integer, got ${dMaxCap}`);
	}
	const clampValue = Math.floor(dMaxCap / 2);

	return {
		dMax(): number {
			const { nEst, confidence } = estimator.estimate();
			if (confidence < confidenceMin) {
				return Math.min(clampValue, dMaxCap);
			}
			const d = Math.max(0, floorLogF(nEst, F) - 1);
			return Math.min(d, dMaxCap);
		},
	};
}
