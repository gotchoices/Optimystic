/**
 * Matchmaking — pure `QueryV1` evaluation (db-core, transport-agnostic).
 *
 * The cohort-side query handler (`db-p2p/src/matchmaking/query-handler.ts`) decodes its local
 * registration records into the {@link LocalProviderRegistration} / {@link LocalSeekerRegistration}
 * shapes below and hands them here; this module performs the *advisory* selection that
 * `docs/matchmaking.md` §Seeker query / §Capability filter specify:
 *
 * - Providers are filtered through {@link matchesFilter} (when `includeProviders`).
 * - Each included set is truncated to `query.limit` (`<= query_limit_max`, enforced on decode in
 *   `wire.ts`); {@link QueryEvalResult.truncated} is set when *any* included set had more matches than
 *   `limit` allowed, so the seeker knows to re-query a sibling cohort.
 * - The forwarded entries carry the provider/seeker's own `registrationSig` verbatim, so the seeker
 *   re-validates each one (`verifyProviderEntry`) — the cohort vouches only for the *set it held*.
 *
 * Pure: no I/O, no clock, no crypto. The db-p2p handler attaches `topicTraffic` / `cohortEpoch` and
 * the primary's reply signature.
 */

import { matchesFilter } from "./capability-filter.js";
import type { ProviderAppPayloadV1, SeekerAppPayloadV1, ProviderEntryV1, SeekerEntryV1, QueryV1 } from "./wire.js";

/** A decoded local provider registration held by the cohort, ready for {@link evaluateQuery}. */
export interface LocalProviderRegistration {
	/** The provider's peer-id string — the entry's `participantId` AND the `registrationSig` signer. */
	readonly participantId: string;
	/** Unix ms the registration first attached (forwarded verbatim for seeker FCFS ordering). */
	readonly attachedAt: number;
	/** The decoded, validated provider app payload (capabilities, budget, contact, signature). */
	readonly payload: ProviderAppPayloadV1;
}

/** A decoded local seeker registration held by the cohort (collective-assembly discovery). */
export interface LocalSeekerRegistration {
	readonly participantId: string;
	readonly attachedAt: number;
	readonly payload: SeekerAppPayloadV1;
}

/** The selected entries for a {@link QueryReplyV1} body (the db-p2p handler signs + frames it). */
export interface QueryEvalResult {
	readonly providers?: ProviderEntryV1[];
	readonly seekers?: SeekerEntryV1[];
	/** `true` when an included set had more matches than `query.limit` allowed (re-query hint). */
	readonly truncated: boolean;
}

/** Build a forwarded {@link ProviderEntryV1} from a local registration (signature forwarded verbatim). */
export function providerEntryOf(reg: LocalProviderRegistration): ProviderEntryV1 {
	return {
		participantId: reg.participantId,
		capabilities: [...reg.payload.capabilities],
		capacityBudget: reg.payload.capacityBudget,
		contactHint: reg.payload.contactHint,
		attachedAt: reg.attachedAt,
		registrationSig: reg.payload.signature,
	};
}

/** Build a forwarded {@link SeekerEntryV1} from a local registration (signature forwarded verbatim). */
export function seekerEntryOf(reg: LocalSeekerRegistration): SeekerEntryV1 {
	return {
		participantId: reg.participantId,
		wantCount: reg.payload.wantCount,
		contactHint: reg.payload.contactHint,
		attachedAt: reg.attachedAt,
		registrationSig: reg.payload.signature,
	};
}

/**
 * Evaluate `query` against the cohort's locally-held registrations: filter providers, optionally include
 * seekers, truncate each included set to `query.limit`. Inputs are returned in `attachedAt` order
 * (oldest first) so truncation keeps the longest-waiting registrations — the FCFS bias the arrival-push
 * fairness rule also uses (`docs/matchmaking.md` §Fairness).
 */
export function evaluateQuery(
	query: QueryV1,
	providers: readonly LocalProviderRegistration[],
	seekers: readonly LocalSeekerRegistration[],
): QueryEvalResult {
	let truncated = false;
	const result: { providers?: ProviderEntryV1[]; seekers?: SeekerEntryV1[]; truncated: boolean } = { truncated: false };

	if (query.includeProviders) {
		const matched = providers
			.filter((reg) => matchesFilter(reg.payload, query.filter))
			.sort((a, b) => a.attachedAt - b.attachedAt);
		if (matched.length > query.limit) {
			truncated = true;
		}
		result.providers = matched.slice(0, query.limit).map(providerEntryOf);
	}

	if (query.includeSeekers) {
		const ordered = [...seekers].sort((a, b) => a.attachedAt - b.attachedAt);
		if (ordered.length > query.limit) {
			truncated = true;
		}
		result.seekers = ordered.slice(0, query.limit).map(seekerEntryOf);
	}

	result.truncated = truncated;
	return result;
}
