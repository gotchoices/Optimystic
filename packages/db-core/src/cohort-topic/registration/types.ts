/**
 * Cohort-topic substrate — registration record store, types and constants.
 *
 * Transcribed from `docs/cohort-topic.md` §Registration mechanics and §Primary and backup
 * sharding. This module owns the **local**, transport-agnostic shapes: the soft-state record a
 * cohort member holds per participant, the in-memory store interface over those records, and the
 * TTL constants. Cross-member replication (cohort gossip) is layered on top by db-p2p and the
 * bridge ticket; db-core never imports FRET or libp2p here.
 *
 * Peer ids are the opaque byte-array references the cohort-topic substrate uses throughout — the
 * same representation as {@link import("../ports.js").PeerRef}`.id` and
 * {@link import("../ports.js").RingCoord} (raw `Uint8Array`, not the structural
 * {@link import("../../network/types.js").PeerId}). The wire layer carries them as base64url
 * strings; this store works in raw bytes and the renewal/handoff bridges translate at the wire
 * boundary.
 */

/**
 * Soft-state registration a cohort member holds per participant. Replicated across the `~k`
 * members by cohort gossip; only {@link RegistrationRecord.primary} serves, with
 * {@link RegistrationRecord.backups} watching for warm failover.
 */
export interface RegistrationRecord {
	/** Topic id, 32 bytes. */
	topicId: Uint8Array;
	/** Registering participant. */
	participantId: Uint8Array;
	/** Tier this registration sits at (0..3). */
	tier: number;
	/** Cohort member assigned to serve this participant. */
	primary: Uint8Array;
	/** 1..2 warm-failover cohort members. */
	backups: Uint8Array[];
	/** Unix ms the registration first attached. */
	attachedAt: number;
	/** Unix ms of the most recent successful ping/touch. */
	lastPing: number;
	/** Lifetime in ms; record is stale once `now − lastPing > ttl`. */
	ttl: number;
	/** Opaque application-defined per-registration state; the layer never interprets it. */
	appState?: Uint8Array;
}

/**
 * In-memory registration store, indexed for both per-participant lookup and per-topic listing.
 * This ticket owns the **local** store and its indexes; the gossip layer and TTL loop call the
 * deterministic functions over it.
 */
export interface RegistrationStore {
	/** Insert or replace the record for `(topicId, participantId)`. */
	put(rec: RegistrationRecord): void;
	/** Record for `(topicId, participantId)`, or `undefined`. */
	getByParticipant(topicId: Uint8Array, participantId: Uint8Array): RegistrationRecord | undefined;
	/** All records held for `topicId` (empty if none). */
	listByTopic(topicId: Uint8Array): readonly RegistrationRecord[];
	/** Every record across all topics — used by the rotation handoff inventory pass. */
	listAll(): readonly RegistrationRecord[];
	/** Remove the record for `(topicId, participantId)`. */
	delete(topicId: Uint8Array, participantId: Uint8Array): void;
	/** Stock count of direct participants for `topicId` (drives promotion). */
	directParticipants(topicId: Uint8Array): number;
	/** Remove and return every record where `now − lastPing > ttl`. */
	evictStale(now: number): readonly RegistrationRecord[];
}

/** Core-tier default registration TTL (ms). */
export const DEFAULT_TTL_MS = 90_000;
/** Edge-tier default registration TTL (ms). */
export const EDGE_TTL_MS = 60_000;
/** Consecutive ping failures before a participant promotes `backups[0]`. */
export const MAX_PING_FAILURES = 3;

/** `ping_interval = ttl / 3` (default 30s Core, 20s Edge), floored to whole ms. */
export function pingIntervalMs(ttl: number): number {
	return Math.floor(ttl / 3);
}
