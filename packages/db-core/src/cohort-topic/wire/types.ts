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
	/**
	 * Cold-start bootstrap-evidence envelope, base64url (a `BootstrapEvidenceEnvelopeV1` — see
	 * `../antidos/bootstrap-evidence-envelope.js`). Present only on a `bootstrap: true` root register;
	 * carries the tier-dependent proof a cold root demands (proof-of-work / reputation endorsement /
	 * signed parent reference — §Anti-DoS). This is a **dedicated** field, NOT `appPayload`: the cohort
	 * copies `appPayload` verbatim into the registration's `appState` and replicates it cluster-wide,
	 * whereas the bootstrap evidence is parsed-and-checked by the substrate, **covered by `signature`**
	 * (so a MITM cannot strip or swap it), and never stored as appState. Empty string is treated as
	 * absent (it normalizes to the same signed-image placeholder as an absent field).
	 */
	bootstrapEvidence?: string;
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
	/**
	 * The cohort coord this gossip is for, 32 bytes, base64url — the inbound routing key. A node serving
	 * many cohorts fans a delivered frame to every coord engine's bus; each bus merges only the gossip
	 * naming its own coord, so a gossip for one cohort never pollutes a sibling cohort's store/view.
	 */
	coord: string;
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

/** What a {@link SignRequestV1} asks a cohort member to endorse — drives the signer's endorsement policy. */
export type SignKind = "membership" | "promotion" | "demotion";

/**
 * Intra-cohort sign request (`/optimystic/cohort-topic/1.0.0/sign`). A member assembling a `k − x`
 * threshold signature dials each cohort member with this; the member endorses by Ed25519-signing the
 * **exact** `payload` bytes (already canonicalized by the requester via `sig/payloads.ts`), so signer
 * and verifier never re-canonicalize independently. `coord`/`cohortEpoch` scope the endorsement
 * (the member checks it shares that cohort/epoch); `kind` selects the endorsement policy.
 */
export interface SignRequestV1 {
	v: 1;
	kind: SignKind;
	/** Cohort coord the signature is for, 32 bytes, base64url. */
	coord: string;
	/** Cohort epoch the requester is collecting under, 32 bytes, base64url. */
	cohortEpoch: string;
	/** The already-canonical signing bytes (the requester's `sig/payloads.ts` image), base64url. */
	payload: string;
}

/** A member's endorsement of a {@link SignRequestV1}: its peer-key signature over the request payload. */
export interface SignReplyOkV1 {
	v: 1;
	/** The endorsing member's dialable id (UTF-8 peer-id string), base64url. */
	signer: string;
	/** Ed25519 signature over the request `payload`, base64url (64 bytes decoded). */
	signature: string;
}

/** A member's refusal to endorse a {@link SignRequestV1} (not a cohort member, epoch mismatch, …). */
export interface SignReplyRefusedV1 {
	v: 1;
	refused: true;
	reason: string;
}

/** Reply to a {@link SignRequestV1}: an endorsement ({@link SignReplyOkV1}) or a refusal ({@link SignReplyRefusedV1}). */
export type SignReplyV1 = SignReplyOkV1 | SignReplyRefusedV1;

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
	/**
	 * Rotation attestation (epoch rotation). The three fields below are an all-or-nothing group: a cert
	 * either carries a full attestation (all three present) or none (all absent). They let a successor
	 * cohort inherit trust from its predecessor: the predecessor cohort threshold-signs **this** cert's
	 * `membershipCertSigningPayload`, so a verifier holding a trusted predecessor at {@link prevEpoch} can
	 * confirm the rotation is legitimate (the prior cohort signed off) rather than a forgery. The
	 * attestation is **not** part of `membershipCertSigningPayload` (it signs *over* that payload), so the
	 * signed image is unchanged and legacy certs (no rotation fields) still decode.
	 */
	/** Predecessor cohort epoch this cert rotates from (32 bytes, base64url). Present only on a rotation. */
	prevEpoch?: string;
	/** Predecessor cohort's threshold signature over THIS cert's `membershipCertSigningPayload`, base64url. */
	rotationSig?: string;
	/** Predecessor cohort signers (PeerIds, base64url) that produced {@link rotationSig}; `>= minSigs`. */
	rotationSigners?: string[];
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
	| MembershipCertV1
	| SignRequestV1
	| SignReplyOkV1
	| SignReplyRefusedV1;
