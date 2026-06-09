/**
 * Matchmaking — seeker hang-out-vs-continue decision engine (db-core, pure).
 *
 * Per `docs/matchmaking.md` §Hang-out vs. continue. After a seeker registers at a cohort and receives
 * `Accepted` with `topicTraffic` at tree tier `d`, it must decide: is *this* tier the right place to
 * wait, or should it walk one tier toward the root? This module is the pure arithmetic of that choice
 * — no I/O, no clock — so it is unit-testable directly against the doc's worked examples. The db-p2p
 * `seeker-walk-client` drives the walk (register / query / renew / withdraw) and calls {@link decide}.
 *
 * Decision rule (`docs/matchmaking.md` §Decision rule):
 *
 * 1. **Immediate-match.** If `currentMatches >= wantCount` → `done`. (The caller has already issued the
 *    `QueryV1`; `currentMatches` is its filter-matched, re-validated yield. This also covers edge case 2
 *    — a stale `arrivalsPerMin = 0` after an epoch rotation still gets a real query first, so a quiet
 *    cohort that actually holds enough providers resolves to `done` rather than a spurious escalate.)
 * 2. **Hang-out feasibility.**
 *    ```
 *    expectedNewMatches ≈ arrivalsPerMin × filterAcceptRatio × (patienceMsRemaining / 60000)
 *    contentionFactor   ≈ min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1), cap)
 *    hang out  iff  currentMatches + expectedNewMatches ≥ wantCount × contentionFactor
 *    ```
 * 3. **Otherwise escalate** (walk one tier toward the root).
 *
 * Edge cases the engine encodes (the rest live in the walk client, which owns the walk topology):
 * - **Filter matches almost nothing (case 4):** a `filterAcceptRatio` decayed toward 0 collapses
 *   `expectedNewMatches`, so the feasibility test fails at every tier and the seeker walks to the root.
 * - **Many seekers competing (case 5):** a high `queriesPerMin` inflates `contentionFactor` up to
 *   `cap`, raising the threshold so more seekers escalate toward aggregation — self-balancing, bounded.
 */

import type { HangOutConfig } from "./config.js";
import { FILTER_ACCEPT_RATIO_INITIAL, MEAN_WANT_COUNT_DEFAULT } from "./config.js";

/** Inputs to {@link decide}: the cohort's `topicTraffic` plus the seeker's running state. */
export interface SeekerDecisionInputs {
	/** Filter-matched, re-validated providers from the immediate `QueryV1` at this tier. */
	readonly currentMatches: number;
	/** `topicTraffic.directParticipants` — informational (providers known here right now). */
	readonly directParticipants: number;
	/** `topicTraffic.arrivalsPerMin` — provider registration + renewal rate. */
	readonly arrivalsPerMin: number;
	/** `topicTraffic.queriesPerMin` — competing seeker activity over the same pool. */
	readonly queriesPerMin: number;
	/** `topicTraffic.childCohortCount` — `> 0` means this tier has promoted (descend territory). */
	readonly childCohortCount: number;
	/** Providers the seeker needs. */
	readonly wantCount: number;
	/** Patience budget left at this tier (drains across walked tiers — the client tracks it). */
	readonly patienceMsRemaining: number;
	/** Running estimate of the fraction of returned providers that pass the seeker's filter (decays from 1.0). */
	readonly filterAcceptRatio: number;
	/** Assumed mean `wantCount` of competing seekers (small constant or learned). */
	readonly meanWantCount: number;
}

/** The outcome of {@link decide}. `hangOut` carries the poll cadence for the requery loop. */
export type SeekerDecision =
	| { readonly action: "done" }
	| { readonly action: "hangOut"; readonly requeryIntervalMs: number }
	| { readonly action: "escalate" };

/** `expectedNewMatches ≈ arrivalsPerMin × filterAcceptRatio × (patienceMsRemaining / 60000)`. */
export function expectedNewMatches(inputs: SeekerDecisionInputs): number {
	return inputs.arrivalsPerMin * inputs.filterAcceptRatio * (inputs.patienceMsRemaining / 60_000);
}

/** `contentionFactor ≈ min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1), cap)`. */
export function contentionFactor(inputs: SeekerDecisionInputs, cfg: HangOutConfig): number {
	const raw = 1 + (inputs.queriesPerMin * inputs.meanWantCount) / Math.max(inputs.arrivalsPerMin, 1);
	return Math.min(raw, cfg.contentionFactorCap);
}

/** The hang-out feasibility threshold `wantCount × contentionFactor`. */
export function hangOutThreshold(inputs: SeekerDecisionInputs, cfg: HangOutConfig): number {
	return inputs.wantCount * contentionFactor(inputs, cfg);
}

/**
 * Decide whether the seeker is `done` (immediate match), should `hangOut` (feasible to wait here), or
 * should `escalate` (walk one tier toward the root). Pure — see the module header for the rule.
 */
export function decide(inputs: SeekerDecisionInputs, cfg: HangOutConfig): SeekerDecision {
	if (inputs.currentMatches >= inputs.wantCount) {
		return { action: "done" };
	}
	const projected = inputs.currentMatches + expectedNewMatches(inputs);
	if (projected >= hangOutThreshold(inputs, cfg)) {
		return { action: "hangOut", requeryIntervalMs: cfg.requeryIntervalMs };
	}
	return { action: "escalate" };
}

// --- filterAcceptRatio running refinement (`docs/matchmaking.md` §Decision rule / §Edge cases 4) ---

/**
 * Running yield accumulator for `filterAcceptRatio`. The ratio starts at `filter_accept_ratio_initial`
 * (1.0, used before any observation) and is refined to the cumulative `matched / returned` over the
 * walk: after two cohorts that each return ~10% matchable providers it settles near 0.1, collapsing
 * `expectedNewMatches` for a pathological filter (edge case 4).
 */
export interface FilterAcceptRatioState {
	/** Total filter-matched providers observed across queries so far. */
	readonly matched: number;
	/** Total providers returned across queries so far. */
	readonly returned: number;
}

/** A fresh (zero-observation) {@link FilterAcceptRatioState}. */
export function newFilterAcceptRatioState(): FilterAcceptRatioState {
	return { matched: 0, returned: 0 };
}

/** Fold one query's yield (`matched` of `returned`) into the running state. */
export function observeYield(state: FilterAcceptRatioState, matched: number, returned: number): FilterAcceptRatioState {
	return { matched: state.matched + matched, returned: state.returned + returned };
}

/**
 * The current `filterAcceptRatio`: cumulative `matched / returned`, or `initial` (1.0) before any
 * providers have been returned (so the first hang-out estimate is optimistic, then refines).
 */
export function filterAcceptRatio(state: FilterAcceptRatioState, initial: number = FILTER_ACCEPT_RATIO_INITIAL): number {
	return state.returned > 0 ? state.matched / state.returned : initial;
}

/** The default assumed competing-seeker `meanWantCount` (re-exported for the walk client). */
export const DEFAULT_MEAN_WANT_COUNT = MEAN_WANT_COUNT_DEFAULT;
