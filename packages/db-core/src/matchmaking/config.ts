/**
 * Matchmaking — configuration defaults.
 *
 * Transcribed from `docs/matchmaking.md` §Configuration. This module owns the matchmaking config
 * surface: the **wire/TTL** constants (provider/seeker TTLs, the query limit, the seeker renew grace,
 * the aggregate-count minimum tier) AND the seeker **hang-out tuning** rows (`patience_*`,
 * `filter_accept_ratio_initial`, `contention_factor_cap`, `requery_interval_ms`, `mean_want_count`)
 * consumed by the {@link import("./seeker-walk.js").decide} engine and the db-p2p seeker-walk client.
 *
 * The TTL/limit constants are wire-stable and do **not** depend on simulator findings; the hang-out
 * rows DO (folded via `fold-simulator-findings-into-design-docs`) — they carry the simulator-validated
 * defaults (`contention_factor_cap = 4.0`, `mean_want_count = 3`, …; see `docs/matchmaking.md`
 * §Configuration "Defaults validated by simulator"). The `push_*` rows belong to the arrival-push
 * path (a separate slice) and are intentionally not modeled here.
 */

import type { NodeProfile } from "../cohort-topic/tiers.js";

/** Provider registration TTL on a Core node (ms). */
export const PROVIDER_TTL_CORE_MS = 90_000;
/** Provider registration TTL on an Edge node (ms). */
export const PROVIDER_TTL_EDGE_MS = 60_000;
/** Seeker registration TTL (ms) — short, since seekers normally don't wait long. */
export const SEEKER_TTL_MS = 10_000;
/** Documented seeker-TTL range (ms); `SEEKER_TTL_MS` sits inside it. */
export const SEEKER_TTL_MIN_MS = 5_000;
export const SEEKER_TTL_MAX_MS = 15_000;
/** Max entries returned in a single `QueryV1` reply. */
export const QUERY_LIMIT_MAX = 256;
/** Grace window a seeker may keep querying after its TTL expires (ms). */
export const SEEKER_RENEW_GRACE_MS = 5_000;
/** Root cohorts produce aggregate counts only when tree depth ≥ this. */
export const AGGREGATE_COUNT_MINIMUM_TIER = 1;

// --- Seeker hang-out tuning (simulator-folded; consumed by seeker-walk.ts + the walk client) ---

/** Fallback `patienceMs` when a caller does not specify it per-task (ms). */
export const PATIENCE_DEFAULT_MS = 10_000;
/** Fraction of remaining patience spent at one tier before considering escalation (1.0 = spend it all here). */
export const PATIENCE_PER_TIER_FRACTION = 1.0;
/** Starting estimate for `filterAcceptRatio`, refined per walk from observed query yields. */
export const FILTER_ACCEPT_RATIO_INITIAL = 1.0;
/** Upper bound on the contention multiplier in the hang-out decision (simulator-validated global scalar). */
export const CONTENTION_FACTOR_CAP = 4.0;
/** Mean `wantCount` assumed for competing seekers in the contention estimate (small constant; simulator value). */
export const MEAN_WANT_COUNT_DEFAULT = 3;
/** How often a hanging-out seeker re-issues `QueryV1` on the non-push (poll) path (ms). */
export const REQUERY_INTERVAL_MS = 1_000;
/** Window the seeker's primary batches fresh matchable arrivals before flushing one push (ms; arrival-push path). */
export const PUSH_COALESCE_MS = 250;
/** Sparse fallback `QueryV1` cadence for a push-aware hanging-out seeker (ms; arrival-push path). */
export const PUSH_SAFETY_POLL_MS = 5_000;

/**
 * The seeker hang-out decision tuning (`docs/matchmaking.md` §Hang-out vs. continue / §Configuration).
 * `meanWantCount` lives here because {@link import("./seeker-walk.js").SeekerDecisionInputs} carries it
 * per-call (it may be learned), but the default is this constant.
 */
export interface HangOutConfig {
	/** Clamp on the contention multiplier; protects against pathological `queriesPerMin / arrivalsPerMin`. */
	readonly contentionFactorCap: number;
	/** Hang-out poll cadence on the non-push path. */
	readonly requeryIntervalMs: number;
}

/** The default hang-out decision config (simulator-validated). */
export const DEFAULT_HANG_OUT_CONFIG: HangOutConfig = {
	contentionFactorCap: CONTENTION_FACTOR_CAP,
	requeryIntervalMs: REQUERY_INTERVAL_MS,
};

/** The full matchmaking config, with the documented defaults. */
export interface MatchmakingConfig {
	readonly providerTtlCoreMs: number;
	readonly providerTtlEdgeMs: number;
	readonly seekerTtlMs: number;
	readonly queryLimitMax: number;
	readonly seekerRenewGraceMs: number;
	readonly aggregateCountMinimumTier: number;
}

/** The default matchmaking config (this ticket's slice). */
export const DEFAULT_MATCHMAKING_CONFIG: MatchmakingConfig = {
	providerTtlCoreMs: PROVIDER_TTL_CORE_MS,
	providerTtlEdgeMs: PROVIDER_TTL_EDGE_MS,
	seekerTtlMs: SEEKER_TTL_MS,
	queryLimitMax: QUERY_LIMIT_MAX,
	seekerRenewGraceMs: SEEKER_RENEW_GRACE_MS,
	aggregateCountMinimumTier: AGGREGATE_COUNT_MINIMUM_TIER,
};

/**
 * Provider TTL for a node profile: Core nodes hold registrations for `PROVIDER_TTL_CORE_MS`, Edge
 * nodes for the shorter `PROVIDER_TTL_EDGE_MS` (`docs/matchmaking.md` §Provider registration).
 */
export function providerTtlForProfile(profile: NodeProfile, config: MatchmakingConfig = DEFAULT_MATCHMAKING_CONFIG): number {
	return profile.kind === "edge" ? config.providerTtlEdgeMs : config.providerTtlCoreMs;
}
