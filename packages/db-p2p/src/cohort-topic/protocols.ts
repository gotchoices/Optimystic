/**
 * Cohort-topic libp2p protocol IDs (`docs/cohort-topic.md` §FRET integration L432-460).
 *
 * Four protocols ride the same FRET/libp2p node:
 *
 * - `register`      — Register, renew, re-attach (`RegisterV1` / `RenewV1`, routed via `RouteAndMaybeAct`).
 * - `cohort-gossip` — record replication, willingness, load barometers (`CohortGossipV1`).
 * - `promote`       — threshold-signed promotion / demotion notices.
 * - `membership`    — membership certificates (`MembershipCertV1`).
 *
 * The default (network-agnostic) IDs match the doc verbatim; {@link makeCohortTopicProtocols}
 * mirrors FRET's `makeProtocols(networkName)` so a named network namespaces its cohort-topic
 * protocols the same way FRET namespaces its routing protocols.
 */

/** Base path for the cohort-topic protocol family. */
export const COHORT_TOPIC_BASE = "/optimystic/cohort-topic/1.0.0" as const;

/** `RegisterV1` / `RenewV1` — register, renew, re-attach. */
export const PROTOCOL_COHORT_REGISTER = `${COHORT_TOPIC_BASE}/register` as const;
/** `CohortGossipV1` — record replication, willingness, load barometers. */
export const PROTOCOL_COHORT_GOSSIP = `${COHORT_TOPIC_BASE}/cohort-gossip` as const;
/** Threshold-signed promotion / demotion notices. */
export const PROTOCOL_COHORT_PROMOTE = `${COHORT_TOPIC_BASE}/promote` as const;
/** `MembershipCertV1` — membership certificates. */
export const PROTOCOL_COHORT_MEMBERSHIP = `${COHORT_TOPIC_BASE}/membership` as const;

/** The four cohort-topic protocol IDs in registration order. */
export interface CohortTopicProtocols {
	readonly register: string;
	readonly gossip: string;
	readonly promote: string;
	readonly membership: string;
}

/** Default (network-agnostic) protocol IDs, matching `docs/cohort-topic.md` §FRET integration. */
export const DEFAULT_COHORT_TOPIC_PROTOCOLS: CohortTopicProtocols = {
	register: PROTOCOL_COHORT_REGISTER,
	gossip: PROTOCOL_COHORT_GOSSIP,
	promote: PROTOCOL_COHORT_PROMOTE,
	membership: PROTOCOL_COHORT_MEMBERSHIP,
};

/**
 * Namespaced cohort-topic protocol IDs for `networkName` (mirrors FRET's `makeProtocols`). The
 * default network yields the canonical IDs in {@link DEFAULT_COHORT_TOPIC_PROTOCOLS}.
 */
export function makeCohortTopicProtocols(networkName = "default"): CohortTopicProtocols {
	const base = `/optimystic/${networkName}/cohort-topic/1.0.0`;
	return {
		register: `${base}/register`,
		gossip: `${base}/cohort-gossip`,
		promote: `${base}/promote`,
		membership: `${base}/membership`,
	};
}

/** All four protocol IDs as an array (for `node.handle` / `unhandle` over the set). */
export function cohortTopicProtocolList(p: CohortTopicProtocols): string[] {
	return [p.register, p.gossip, p.promote, p.membership];
}
