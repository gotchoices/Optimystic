import type { TopicTrafficV1 } from './topic-events.js';
import {
	type SeekerDemand,
	type MatchmakingConfig,
	DEFAULT_MATCHMAKING_CONFIG,
	expectedNewMatches,
	contentionFactor
} from './matchmaking.js';
import type { SeekerTrace } from './seeker-walk.js';

/**
 * Measures whether the two deferred matchmaking refinements would *materially* improve
 * borderline-regime behaviour — recorded for `fold-simulator-findings-into-design-docs`, **not**
 * implemented here (the backlog tickets `matchmaking-per-tier-patience-splitting` and
 * `matchmaking-contention-from-seeker-pool` own the actual changes). This module only answers
 * "would they have mattered on this run?" so the fold-back ticket has a data-driven signal.
 */

/** Verdict for one borderline run (recorded, not acted on). */
export interface RefinementSignal {
	readonly patienceSplittingWouldHelp: boolean;
	readonly seekerPoolContentionWouldHelp: boolean;
	readonly note: string;
}

/**
 * `matchmaking-per-tier-patience-splitting`: with `patience_per_tier_fraction = 1.0` a seeker spends
 * its whole budget at the first accepting tier. Splitting would help **iff** the seeker drained its
 * patience to a partial result at a deeper tier while the root already held `≥ wantCount` providers
 * — i.e. checking the upper tier sooner would have matched (matchmaking.md §Decision rule worked
 * example: "Withdraw, walk to d=0. Root … Query returns 8 immediately").
 */
export function patienceSplittingWouldHelp(trace: SeekerTrace, rootMatchableCount: number, wantCount: number): boolean {
	return trace.outcome === 'partial' && trace.finalTier > 0 && rootMatchableCount >= wantCount;
}

/**
 * `matchmaking-contention-from-seeker-pool`: the decision rule approximates competition as
 * `queriesPerMin × meanWantCount`; the refinement uses the exact `Σ wantCount` over registered
 * seekers. This returns true **iff** swapping the approximation for the exact sum *flips* the
 * hang-out decision for the given reply — the only case where the richer reply changes the outcome.
 */
export function seekerPoolContentionWouldFlip(
	traffic: TopicTrafficV1,
	currentMatches: number,
	demand: SeekerDemand,
	seekerWantSum: number,
	config: MatchmakingConfig = DEFAULT_MATCHMAKING_CONFIG
): boolean {
	if (currentMatches >= demand.wantCount) {
		return false; // immediate match — neither term is consulted.
	}
	const newMatches = expectedNewMatches(traffic.arrivalsPerMin, demand.filterAcceptRatio, demand.patienceMs);
	const approxContention = contentionFactor(traffic.arrivalsPerMin, traffic.queriesPerMin, config.meanWantCount, config.contentionFactorCap);
	const exactContention = Math.min(1 + seekerWantSum / Math.max(traffic.arrivalsPerMin, 1), config.contentionFactorCap);
	const approxHangOut = currentMatches + newMatches >= demand.wantCount * approxContention;
	const exactHangOut = currentMatches + newMatches >= demand.wantCount * exactContention;
	return approxHangOut !== exactHangOut;
}

/** Bundle both measurements into one recorded verdict for the fold-back ticket. */
export function measureRefinementSignal(args: {
	readonly trace: SeekerTrace;
	readonly rootMatchableCount: number;
	readonly wantCount: number;
	readonly borderlineTraffic: TopicTrafficV1;
	readonly borderlineMatches: number;
	readonly borderlineDemand: SeekerDemand;
	readonly seekerWantSum: number;
	readonly config?: MatchmakingConfig;
}): RefinementSignal {
	const splitting = patienceSplittingWouldHelp(args.trace, args.rootMatchableCount, args.wantCount);
	const seekerPool = seekerPoolContentionWouldFlip(
		args.borderlineTraffic,
		args.borderlineMatches,
		args.borderlineDemand,
		args.seekerWantSum,
		args.config
	);
	return {
		patienceSplittingWouldHelp: splitting,
		seekerPoolContentionWouldHelp: seekerPool,
		note:
			`patience-splitting ${splitting ? 'WOULD' : 'would not'} help; ` +
			`seeker-pool contention ${seekerPool ? 'WOULD' : 'would not'} flip the borderline decision`
	};
}
