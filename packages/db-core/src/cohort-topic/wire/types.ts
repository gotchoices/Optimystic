/**
 * Cohort-topic substrate — V1 wire message types.
 *
 * Transcribed from `docs/cohort-topic.md` §Wire formats. These interfaces are the canonical
 * on-the-wire shapes for the cohort-topic RPC surface; the codec in `./codec.ts` serializes
 * them as length-prefixed UTF-8 JSON.
 *
 * Conventions (mandated by §Wire formats):
 * - Every byte-typed field is carried as a base64url string (no padding) — never raw bytes.
 * - Every timestamp is unix milliseconds.
 * - `appPayload` is an opaque base64url string carrying application-defined bytes. The wire layer
 *   never interprets it; reactivity / matchmaking define their own structures and serialize them
 *   into this slot.
 */

/** Registration request. Walks toward the root via FRET `RouteAndMaybeAct`. */
export interface RegisterV1 {
	v: 1;
	/** Topic id, 32 bytes, base64url. */
	topicId: string;
	/** Tier, 0..3. */
	tier: number;
	/** Current walk position `d`. */
	treeTier: number;
	/** Participant's ring coord, 32 bytes, base64url. */
	participantCoord: string;
	/** Registration TTL in ms (default 90000; Edge 60000). */
	ttl: number;
	/** True on a root cold-start request. */
	bootstrap?: boolean;
	/** Opaque application-defined bytes, base64url. */
	appPayload?: string;
	/** Unix ms. */
	timestamp: number;
	/** 16 random bytes, base64url. */
	correlationId: string;
	/** Participant peer-key signature, base64url. */
	signature: string;
}

export type RegisterResult =
	| "accepted"
	| "no_state"
	| "promoted"
	| "unwilling_member"
	| "unwilling_cohort";

/** Registration reply. Field presence is keyed by {@link RegisterResult}. */
export interface RegisterReplyV1 {
	v: 1;
	result: RegisterResult;
	// accepted:
	/** PeerId. */
	primary?: string;
	/** PeerIds, 1-2. */
	backups?: string[];
	/** 32 bytes, base64url. */
	cohortEpoch?: string;
	/** Full cohort PeerIds, for client cache. */
	cohortMembers?: string[];
	/** Present on `accepted` and `promoted` only. */
	topicTraffic?: TopicTrafficV1;
	// promoted:
	/** `d+1` typically; may leap. */
	targetTier?: number;
	// unwilling_member:
	/** PeerIds within the same cohort to try. */
	candidateMembers?: string[];
	// unwilling_cohort:
	retryAfterMs?: number;
	/** Human-readable, optional. */
	reason?: string;
}

/** Coarse traffic barometer attached to accepted/promoted replies. */
export interface TopicTrafficV1 {
	windowSeconds: number;
	arrivalsPerMin: number;
	queriesPerMin: number;
	directParticipants: number;
	childCohortCount: number;
}

/** Registration renewal (ping). */
export interface RenewV1 {
	v: 1;
	topicId: string;
	/** PeerId. */
	participantId: string;
	/** Matches the original {@link RegisterV1}. */
	correlationId: string;
	timestamp: number;
	/**
	 * True on a crash-failover re-attach — the participant attests it could not reach its primary and
	 * asks the contacted backup to promote itself. Absent/false on a normal ping. Signed (part of the
	 * renew body) so a member can trust the attestation and a MITM cannot flip a ping into a promotion.
	 */
	reattach?: boolean;
	signature: string;
}

/** Renewal reply. */
export interface RenewReplyV1 {
	v: 1;
	result: "ok" | "unknown_registration" | "primary_moved";
	// primary_moved:
	newPrimary?: string;
	newBackups?: string[];
	cohortEpoch?: string;
}

/** Threshold-signed promotion notice. */
export interface PromotionNoticeV1 {
	v: 1;
	topicId: string;
	fromTier: number;
	/** Typically `fromTier + 1`. */
	toTier: number;
	/** Unix ms. */
	effectiveAt: number;
	/** Cohort threshold signature, base64url. */
	thresholdSig: string;
	/** PeerIds, `>= minSigs`. */
	signers: string[];
	cohortEpoch: string;
}

/** Threshold-signed demotion notice. */
export interface DemotionNoticeV1 {
	v: 1;
	topicId: string;
	tier: number;
	/** 32 bytes, base64url. */
	parentCohortCoord: string;
	effectiveAt: number;
	thresholdSig: string;
	signers: string[];
	cohortEpoch: string;
}

/**
 * A registration record carried in cohort gossip for cross-member replication (so any member can
 * fail over to serving it). Byte fields are base64url; mirrors the local `RegistrationRecord`.
 */
export interface GossipRecordV1 {
	/** Topic id, 32 bytes, base64url. */
	topicId: string;
	/** Registering participant peer id, base64url. */
	participantId: string;
	/** Tier 0..3. */
	tier: number;
	/** Assigned primary peer id, base64url. */
	primary: string;
	/** 1..2 warm-failover peer ids, base64url. */
	backups: string[];
	/** Unix ms the registration first attached. */
	attachedAt: number;
	/** Unix ms of the most recent ping/touch (the convergence key — newest wins). */
	lastPing: number;
	/** Registration TTL in ms. */
	ttl: number;
	/** Opaque application-defined per-registration state, base64url. */
	appState?: string;
}

/** Reference to a single registration in an eviction delta. */
export interface GossipRecordRefV1 {
	/** Topic id, 32 bytes, base64url. */
	topicId: string;
	/** Participant peer id, base64url. */
	participantId: string;
}

/** Intra-cohort gossip: willingness vector, load barometer, exact per-topic summaries, record deltas. */
export interface CohortGossipV1 {
	v: 1;
	/** PeerId. */
	fromMember: string;
	cohortEpoch: string;
	/** 4 bits T0..T3, hex. */
	willingnessBits: string;
	/** 4 entries, 0..7 per tier. */
	loadBuckets: number[];
	/** Cohort-wide observation window for the rate fields in `topicSummaries`. */
	windowSeconds: number;
	topicSummaries: CohortTopicSummary[];
	/**
	 * Registration records this member is advertising (fresh or touched), for cross-member
	 * replication. Absent when this gossip carries no record changes. Merge is last-writer-wins by
	 * {@link GossipRecordV1.lastPing}.
	 */
	records?: GossipRecordV1[];
	/** Registrations this member evicted (stale), so all members converge on the active set. */
	evicted?: GossipRecordRefV1[];
	timestamp: number;
	signature: string;
}

/** Per-topic summary inside {@link CohortGossipV1}; counts are exact, intra-cohort only. */
export interface CohortTopicSummary {
	topicId: string;
	tier: number;
	/** Exact, intra-cohort only. */
	directParticipants: number;
	/** Exact, fresh + renewals over the gossip window. */
	arrivalsPerMin: number;
	queriesPerMin: number;
	promoted: boolean;
	childCohortCount: number;
}

/** Membership certificate for a cohort. */
export interface MembershipCertV1 {
	v: 1;
	/** 32 bytes, base64url. */
	cohortCoord: string;
	cohortEpoch: string;
	/** PeerIds, sorted ascending, length `k`. */
	members: string[];
	/** Unix ms. */
	stabilizedAt: number;
	thresholdSig: string;
	signers: string[];
	/** Optional FRET stabilization proof, base64url. */
	fretAttestation?: string;
}

/** Discriminated union over every V1 message carried by the cohort-topic protocols. */
export type CohortMessageV1 =
	| RegisterV1
	| RegisterReplyV1
	| RenewV1
	| RenewReplyV1
	| PromotionNoticeV1
	| DemotionNoticeV1
	| CohortGossipV1
	| MembershipCertV1;
