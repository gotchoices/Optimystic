/**
 * Cohort-topic libp2p protocol IDs (`docs/cohort-topic.md` §FRET integration L432-460).
 *
 * Five protocols ride the same FRET/libp2p node:
 *
 * - `register`      — Register, renew, re-attach (`RegisterV1` / `RenewV1`, routed via `RouteAndMaybeAct`).
 * - `cohort-gossip` — record replication, willingness, load barometers (`CohortGossipV1`).
 * - `promote`       — threshold-signed promotion / demotion notices.
 * - `membership`    — membership certificates (`MembershipCertV1`).
 * - `sign`          — intra-cohort per-member endorsement for `k − x` threshold-signature assembly
 *                     (`SignRequestV1` / `SignReplyV1`); a member collecting a threshold signature dials
 *                     each cohort member here and concatenates the returned per-member Ed25519 sigs.
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
/** `SignRequestV1` / `SignReplyV1` — intra-cohort per-member endorsement for threshold-signature assembly. */
export const PROTOCOL_COHORT_SIGN = `${COHORT_TOPIC_BASE}/sign` as const;

/** The five cohort-topic protocol IDs in registration order. */
export interface CohortTopicProtocols {
	readonly register: string;
	readonly gossip: string;
	readonly promote: string;
	readonly membership: string;
	readonly sign: string;
}

/** Default (network-agnostic) protocol IDs, matching `docs/cohort-topic.md` §FRET integration. */
export const DEFAULT_COHORT_TOPIC_PROTOCOLS: CohortTopicProtocols = {
	register: PROTOCOL_COHORT_REGISTER,
	gossip: PROTOCOL_COHORT_GOSSIP,
	promote: PROTOCOL_COHORT_PROMOTE,
	membership: PROTOCOL_COHORT_MEMBERSHIP,
	sign: PROTOCOL_COHORT_SIGN,
};

/**
 * Namespaced cohort-topic protocol IDs for `networkName` (mirrors FRET's `makeProtocols`, which
 * inserts the network segment even for `"default"` → `/optimystic/default/...`). Note this does NOT
 * equal {@link DEFAULT_COHORT_TOPIC_PROTOCOLS}: the canonical, network-agnostic IDs omit the segment
 * entirely (`/optimystic/cohort-topic/1.0.0/...`); use those unless you need per-network namespacing.
 */
export function makeCohortTopicProtocols(networkName = "default"): CohortTopicProtocols {
	const base = `/optimystic/${networkName}/cohort-topic/1.0.0`;
	return {
		register: `${base}/register`,
		gossip: `${base}/cohort-gossip`,
		promote: `${base}/promote`,
		membership: `${base}/membership`,
		sign: `${base}/sign`,
	};
}

/** All five protocol IDs as an array (for `node.handle` / `unhandle` over the set). */
export function cohortTopicProtocolList(p: CohortTopicProtocols): string[] {
	return [p.register, p.gossip, p.promote, p.membership, p.sign];
}
