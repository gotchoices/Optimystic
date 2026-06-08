/**
 * Cohort-topic substrate — membership-source dispatch.
 *
 * Resolved open question (per `docs/cohort-topic.md` §Membership source): how *committed*
 * membership is obtained differs by tier.
 *
 * - **T0/T1** cohorts serve committed work (transaction commits, chain serving); their membership is
 *   anchored in the transaction log's commit certificate. The verifier reads it from there (it never
 *   writes the log).
 * - **T2/T3** cohorts (matchmaking, push forwarding) derive membership from current FRET state and
 *   verify against FRET's signed `MembershipCertV1` advertisements.
 *
 * Both back-ends present the same {@link IMembershipSource} surface; this router picks between them by
 * tier. db-p2p supplies the two concrete sources (tx-log reader and FRET cert source).
 */

import type { IMembershipSource } from "../ports.js";

/** Picks the authoritative membership source for a cohort by its tier. */
export interface IMembershipSourceRouter {
	/** Source for a cohort at `tier`: T0/T1 → committed tx-log, T2/T3 → FRET certs. */
	for(tier: number): IMembershipSource;
}

/** Tiers whose committed membership is anchored in the transaction log. */
function isCommittedTier(tier: number): boolean {
	return tier === 0 || tier === 1;
}

/**
 * Build a router over the two membership back-ends.
 * @param deps.committed source backed by the transaction-log commit certificate (T0/T1).
 * @param deps.fret source backed by FRET's signed `MembershipCertV1` advertisements (T2/T3).
 */
export function createMembershipSourceRouter(deps: { committed: IMembershipSource; fret: IMembershipSource }): IMembershipSourceRouter {
	return {
		for(tier: number): IMembershipSource {
			return isCommittedTier(tier) ? deps.committed : deps.fret;
		},
	};
}
