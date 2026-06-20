import { estimateSizeAndConfidence, type DigitreeStore, type SizeEstimate } from 'p2p-fret';

export type { SizeEstimate };

/**
 * Config for the maximum-useful-depth computation (cohort-topic.md §Maximum useful depth).
 * Defaults track the cohort-topic parameter table.
 */
export interface DMaxConfig {
	/** Fan-out per tier (default 16; log₂F = 4). */
	readonly F: number;
	/** Direct-participant cap before promotion (default 64) — used by the depth-law cross-check. */
	readonly capPromote: number;
	/** Hard cap on walk-toward-root start tier (default 60). */
	readonly dMaxCap: number;
	/** Below this n_est confidence, cap d_max at ⌊dMaxCap/2⌋ as an upper bound (default 0.3). */
	readonly confidenceMin: number;
}

/** cohort-topic.md parameter-table defaults. */
export const DEFAULT_DMAX_CONFIG: DMaxConfig = {
	F: 16,
	capPromote: 64,
	dMaxCap: 60,
	confidenceMin: 0.3
};

/**
 * `d_max = max(0, ⌊log_F(n_est)⌋ − 1)`, capped at `⌊dMaxCap/2⌋` as an upper bound when
 * `confidence < confidenceMin` — i.e. `min(formula, ⌊dMaxCap/2⌋)` — to avoid deep probes
 * from an over-estimated population. Small/low-confidence populations stay at their formula value.
 * Pure so the cap can be exercised directly with forced `(n_est, confidence)` pairs.
 */
export function computeDMax(nEst: number, confidence: number, cfg: DMaxConfig): number {
	if (nEst <= 0) {
		return 0;
	}
	const logF = Math.log(nEst) / Math.log(cfg.F);
	const formula = Math.max(0, Math.floor(logF) - 1);
	if (confidence < cfg.confidenceMin) {
		return Math.min(formula, Math.floor(cfg.dMaxCap / 2));
	}
	return formula;
}

/**
 * Network-size estimate (`n_est` + confidence) and maximum useful tree depth, delegated to
 * real FRET `estimateSizeAndConfidence` over a shared `DigitreeStore`. The simulator computes
 * `d_max` from FRET's own `(n, confidence)`, the same numbers production feeds the clamp.
 */
export class SizeModel {
	constructor(
		private readonly store: DigitreeStore,
		private readonly m: number
	) {}

	/** `n_est` + confidence for the modeled population, via FRET. */
	estimate(): SizeEstimate {
		return estimateSizeAndConfidence(this.store, this.m);
	}

	/** `d_max` with the confidence clamp applied, from the current estimate. */
	dMax(cfg: DMaxConfig): number {
		const { n, confidence } = this.estimate();
		return computeDMax(n, confidence, cfg);
	}
}
