/**
 * Cohort-topic substrate — transport ports.
 *
 * These are the seams that keep the cohort-topic substrate split cleanly across packages:
 * db-core defines the interfaces here (pure logic depends only on a hash function and
 * byte-array peer IDs), and db-p2p supplies the concrete FRET + libp2p implementations.
 *
 * **db-core never imports FRET or libp2p.** Every db-core substrate module takes these ports
 * by injection (constructor / factory args); db-p2p constructs the FRET-backed versions and
 * composes them with the db-core logic in `CohortTopicService`'s transport host.
 *
 * See `docs/cohort-topic.md` §FRET integration and `tickets` slug
 * `cohort-topic-package-layering` for the authoritative layering rule.
 */

/**
 * Ring coordinate — SHA-256 truncated to the ring width `B` (see {@link IRingHash}). db-core
 * owns this type; db-p2p maps it onto FRET's coordinate type, ensuring the byte representation
 * matches FRET's ring width so routing keys line up on the wire.
 */
export type RingCoord = Uint8Array;

/** A peer, referenced only by its opaque byte-array id. No multiaddr, no libp2p PeerId here. */
export interface PeerRef {
	readonly id: Uint8Array;
}

/**
 * Wraps FRET's `RouteAndMaybeAct` so the walk / registration decision logic in db-core stays
 * transport-agnostic.
 */
export interface ITopicRouter {
	/**
	 * Route `activity` to the cohort owning `key` and run the cohort's activity callback,
	 * collecting up to `wantK` participants and at least `minSigs` signatures.
	 * @returns the encoded cohort reply.
	 */
	routeAndAct(key: RingCoord, activity: Uint8Array, opts: { wantK: number; minSigs: number }): Promise<Uint8Array>;
	/** Direct dial to a cached primary; falls back to {@link routeAndAct} on failure (caller decides). */
	dialMember(member: PeerRef, activity: Uint8Array): Promise<Uint8Array>;
}

/** Intra-cohort gossip transport (FRET cohort gossip underneath). */
export interface ICohortGossipTransport {
	/** Fire-and-forget broadcast of `msg` to the cohort at `coord`. */
	broadcast(coord: RingCoord, msg: Uint8Array): void;
	/** Subscribe to inbound cohort gossip; returns an unsubscribe handle. */
	onMessage(handler: (from: PeerRef, msg: Uint8Array) => void): () => void;
}

/** Authoritative cohort membership snapshots (FRET `MembershipCertV1` / stabilization underneath). */
export interface IMembershipSource {
	/** Current cached membership cert for `coord`, encoded; `undefined` if none is cached. */
	current(coord: RingCoord): Promise<Uint8Array | undefined>;
	/** Force one refresh of `coord`'s membership cert (stale-cache retry); encoded, or `undefined`. */
	fetch(coord: RingCoord): Promise<Uint8Array | undefined>;
}

/** Network-size estimate feeding `d_max`. */
export interface ISizeEstimator {
	estimate(): { nEst: number; confidence: number };
}

/**
 * Hash + ring math. db-core supplies its OWN SHA-256 (it already hashes logs and block ids);
 * the ring width is configuration. db-p2p, when mapping {@link RingCoord} onto FRET's coordinate
 * type, ensures `ringBits` matches FRET's ring width so coords are byte-compatible.
 */
export interface IRingHash {
	/** SHA-256 of `bytes`, truncated to the ring width `B` ({@link ringBits}). */
	H(bytes: Uint8Array): RingCoord;
	/** Ring width in bits. */
	readonly ringBits: number;
}
