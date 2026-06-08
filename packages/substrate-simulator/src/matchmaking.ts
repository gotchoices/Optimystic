import type { VTime } from './types.js';
import type { TopicTrafficV1 } from './topic-events.js';

/**
 * The matchmaking seeker's hang-out-vs-continue decision engine — the modeled mirror of
 * `docs/matchmaking.md` §Hang-out vs. continue. A seeker that has just received `Accepted` with a
 * `topicTraffic` snapshot estimates whether *this tier* can satisfy `wantCount` within its
 * remaining patience budget (hang out) or whether it should walk one tier toward the root
 * (continue). The math is pure and synchronous; the event-driven seeker walk that consumes it
 * lives in `seeker-walk.ts`.
 *
 * Two terms drive the decision (matchmaking.md §Decision rule):
 *
 *   expectedNewMatches = arrivalsPerMin × filterAcceptRatio × (patienceMs / 60000)
 *   contentionFactor   = min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1),
 *                            contention_factor_cap)
 *   hangOut  ⟺  currentMatches + expectedNewMatches ≥ wantCount × contentionFactor
 *
 * `contention_factor_cap` (4.0) protects the threshold from a pathological `queriesPerMin /
 * arrivalsPerMin` ratio pinning every seeker to the root (matchmaking.md §Edge cases item 5 /
 * §Configuration). `filterAcceptRatio` starts at `filter_accept_ratio_initial` (1.0) and decays
 * toward the observed accept rate across the walk (see `FilterAcceptEstimator`).
 */

/** Capability filter (matchmaking.md §Capability filter). Advisory; evaluated locally at the cohort. */
export interface CapabilityFilter {
	readonly must?: readonly string[];
	readonly mustNot?: readonly string[];
	readonly minBudget?: number;
}

/** A modeled provider registration (matchmaking.md §Wire formats `ProviderEntryV1`). */
export interface SimProvider {
	readonly id: string;
	readonly capabilities: readonly string[];
	readonly capacityBudget: number;
	readonly attachedAt: VTime;
}

/** Seeker-tunable knobs (matchmaking.md §Configuration; all seeker-side, no wire impact). */
export interface MatchmakingConfig {
	readonly patienceDefaultMs: VTime; // patience_default_ms = 10_000
	readonly patiencePerTierFraction: number; // patience_per_tier_fraction = 1.0
	readonly filterAcceptRatioInitial: number; // filter_accept_ratio_initial = 1.0
	readonly contentionFactorCap: number; // contention_factor_cap = 4.0
	readonly requeryIntervalMs: VTime; // requery_interval_ms = 1_000
	readonly pushSafetyPollMs: VTime; // push_safety_poll_ms = 5_000
	readonly seekerTtlMs: VTime; // seeker_ttl = 10_000
	readonly meanWantCount: number; // small constant; default 3 (matchmaking.md worked example)
}

export const DEFAULT_MATCHMAKING_CONFIG: MatchmakingConfig = {
	patienceDefaultMs: 10_000,
	patiencePerTierFraction: 1.0,
	filterAcceptRatioInitial: 1.0,
	contentionFactorCap: 4.0,
	requeryIntervalMs: 1_000,
	pushSafetyPollMs: 5_000,
	seekerTtlMs: 10_000,
	meanWantCount: 3
};

/** Does a provider satisfy a capability filter? (matchmaking.md §Capability filter.) */
export function matchesFilter(provider: SimProvider, filter?: CapabilityFilter): boolean {
	if (!filter) {
		return true;
	}
	const caps = new Set(provider.capabilities);
	if (filter.must && !filter.must.every((tag) => caps.has(tag))) {
		return false;
	}
	if (filter.mustNot && filter.mustNot.some((tag) => caps.has(tag))) {
		return false;
	}
	if (filter.minBudget !== undefined && provider.capacityBudget < filter.minBudget) {
		return false;
	}
	return true;
}

/** Count the filter-matching providers in a returned set. */
export function countMatchable(providers: readonly SimProvider[], filter?: CapabilityFilter): number {
	return providers.reduce((n, p) => (matchesFilter(p, filter) ? n + 1 : n), 0);
}

/**
 * `expectedNewMatches ≈ arrivalsPerMin × filterAcceptRatio × (patienceMs / 60000)`
 * (matchmaking.md §Decision rule). The matchable arrivals a seeker can expect over the patience
 * budget it would spend hanging out at this tier.
 */
export function expectedNewMatches(arrivalsPerMin: number, filterAcceptRatio: number, patienceMs: VTime): number {
	return arrivalsPerMin * filterAcceptRatio * (patienceMs / 60_000);
}

/**
 * `contentionFactor ≈ min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1), cap)`
 * (matchmaking.md §Decision rule). Competing seekers inflate the effective demand on the same
 * provider pool; the `max(arrivalsPerMin, 1)` guard avoids a divide-by-zero on a silent cohort and
 * the cap bounds a runaway query rate (matchmaking.md §Edge cases item 5).
 */
export function contentionFactor(arrivalsPerMin: number, queriesPerMin: number, meanWantCount: number, cap: number): number {
	const raw = 1 + (queriesPerMin * meanWantCount) / Math.max(arrivalsPerMin, 1);
	return Math.min(raw, cap);
}

/** The seeker's per-task inputs to the hang-out decision (matchmaking.md §Decision inputs). */
export interface SeekerDemand {
	readonly wantCount: number;
	/** Remaining patience the seeker would spend hanging out at this tier. */
	readonly patienceMs: VTime;
	readonly filter?: CapabilityFilter;
	/** Current observed accept ratio (1.0 until the first query yields are folded in). */
	readonly filterAcceptRatio: number;
}

export type HangOutAction = 'matched' | 'hang-out' | 'escalate';

/** The decision outcome plus the terms that produced it, for assertions and the trace. */
export interface HangOutDecision {
	readonly action: HangOutAction;
	readonly currentMatches: number;
	readonly expectedNewMatches: number;
	readonly contentionFactor: number;
	readonly threshold: number;
	/** Why an `escalate` was chosen: a missing traffic signal vs. a met-but-below-threshold estimate. */
	readonly reason: 'matched' | 'feasible' | 'no-traffic' | 'below-threshold';
}

/**
 * Decide hang-out vs. continue for one `Accepted` reply (matchmaking.md §Decision rule):
 *  1. **Immediate-match check.** `currentMatches ≥ wantCount` → done (`matched`).
 *  2. **Hang-out feasibility.** `currentMatches + expectedNewMatches ≥ wantCount × contentionFactor`
 *     → `hang-out`.
 *  3. **Otherwise** → `escalate` (walk one tier toward the root).
 *
 * Edge cases (matchmaking.md §Edge cases):
 *  - **Missing `topicTraffic`** (`traffic === undefined`) → conservative `escalate` with reason
 *    `no-traffic`; no estimation is attempted against absent inputs. The immediate-match check is
 *    *not* skipped — a cohort that already holds `≥ wantCount` providers still resolves, even with
 *    no rate signal (covers the §`arrivalsPerMin = 0` post-rotation case: query first, do not
 *    over-react to a single zero).
 *  - **`arrivalsPerMin = 0`** (a single stale-zero reading) collapses `expectedNewMatches` to 0, so
 *    a cohort with too few current providers escalates — but only *after* the immediate-match check
 *    has had its say, which is the doc's "issue one QueryV1 first" tolerance.
 *  - **Pathological filter** drives `filterAcceptRatio → 0`, collapsing `expectedNewMatches`; the
 *    threshold fails at every tier and the seeker walks to the root.
 */
export function decideHangOut(
	traffic: TopicTrafficV1 | undefined,
	currentMatches: number,
	demand: SeekerDemand,
	config: MatchmakingConfig = DEFAULT_MATCHMAKING_CONFIG
): HangOutDecision {
	// 1. Immediate-match check — runs even without a traffic signal.
	if (currentMatches >= demand.wantCount) {
		return { action: 'matched', currentMatches, expectedNewMatches: 0, contentionFactor: 1, threshold: demand.wantCount, reason: 'matched' };
	}
	// Edge case: no traffic signal → conservative continue, no estimation against absent inputs.
	if (!traffic) {
		return { action: 'escalate', currentMatches, expectedNewMatches: 0, contentionFactor: 1, threshold: demand.wantCount, reason: 'no-traffic' };
	}
	const newMatches = expectedNewMatches(traffic.arrivalsPerMin, demand.filterAcceptRatio, demand.patienceMs);
	const contention = contentionFactor(traffic.arrivalsPerMin, traffic.queriesPerMin, config.meanWantCount, config.contentionFactorCap);
	const threshold = demand.wantCount * contention;
	if (currentMatches + newMatches >= threshold) {
		return { action: 'hang-out', currentMatches, expectedNewMatches: newMatches, contentionFactor: contention, threshold, reason: 'feasible' };
	}
	return { action: 'escalate', currentMatches, expectedNewMatches: newMatches, contentionFactor: contention, threshold, reason: 'below-threshold' };
}

/**
 * Running estimate of `filterAcceptRatio` — starts at `filter_accept_ratio_initial` (1.0) and
 * decays toward the observed matchable-fraction across the walk (matchmaking.md §Edge cases item 4:
 * "after two cohorts each return only ~10% matchable providers, `filterAcceptRatio` settles near
 * 0.1"). Models the cumulative observed accept rate: `Σ matchable / Σ returned`, falling back to
 * the initial estimate until the first non-empty query.
 */
export class FilterAcceptEstimator {
	private totalReturned = 0;
	private totalMatchable = 0;

	constructor(private readonly initial: number) {}

	/** Fold one query's yield (matchable out of returned) into the running estimate. */
	observe(matchable: number, returned: number): void {
		if (returned < 0 || matchable < 0 || matchable > returned) {
			throw new RangeError(`invalid query yield: ${matchable}/${returned}`);
		}
		this.totalReturned += returned;
		this.totalMatchable += matchable;
	}

	/** The current accept-ratio estimate; the seed value until the first non-empty observation. */
	get ratio(): number {
		return this.totalReturned > 0 ? this.totalMatchable / this.totalReturned : this.initial;
	}
}
