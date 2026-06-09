/**
 * Matchmaking — configuration defaults.
 *
 * Transcribed from `docs/matchmaking.md` §Configuration. This module owns only the **wire/TTL**
 * constants this ticket consumes (provider/seeker TTLs, the query limit, the seeker renew grace,
 * the aggregate-count minimum tier). The seeker hang-out tuning rows (`patience_*`,
 * `filter_accept_ratio_initial`, `contention_factor_cap`, `requery_interval_ms`,
 * `push_coalesce_ms`, `push_safety_poll_ms`) are owned by the next ticket
 * (`matchmaking-query-filter-hangout`); they are stubbed here with the documented defaults so the
 * matchmaking subsystem has a single config surface, but nothing in this ticket reads them.
 *
 * The TTL/limit constants are wire-stable and do **not** depend on simulator findings; the hang-out
 * rows DO (folded via `fold-simulator-findings-into-design-docs`) and may move — they live here only
 * as placeholders, marked below.
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

// --- Seeker hang-out tuning (owned by matchmaking-query-filter-hangout; stubbed here) ---
// These are simulator-folded values; the next ticket consumes them. Listed so the config surface is
// singular. Do not read these in this ticket's code paths.

/** Fallback `patienceMs` when a caller does not specify it per-task (ms). */
export const PATIENCE_DEFAULT_MS = 10_000;
/** Fraction of remaining patience spent at one tier before considering escalation. */
export const PATIENCE_PER_TIER_FRACTION = 1.0;
/** Starting estimate for `filterAcceptRatio`, refined per walk from observed query yields. */
export const FILTER_ACCEPT_RATIO_INITIAL = 1.0;
/** Upper bound on the contention multiplier in the hang-out decision. */
export const CONTENTION_FACTOR_CAP = 4.0;
/** How often a hanging-out seeker re-issues `QueryV1` on the non-push path (ms). */
export const REQUERY_INTERVAL_MS = 1_000;
/** Window the seeker's primary batches fresh matchable arrivals before flushing one push (ms). */
export const PUSH_COALESCE_MS = 250;
/** Sparse fallback `QueryV1` cadence for a push-aware hanging-out seeker (ms). */
export const PUSH_SAFETY_POLL_MS = 5_000;

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
