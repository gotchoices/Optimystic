import type { IMembershipSource, RingCoord } from "@optimystic/db-core";
import { bytesToB64url } from "@optimystic/db-core";
import { peerIdFromString } from "@libp2p/peer-id";
import type { Libp2p } from "libp2p";
import type { CohortPeerResolver } from "./cohort-gossip-transport.js";
import { requestResponse, DEFAULT_STREAM_MAX_BYTES } from "./stream-util.js";
import { PROTOCOL_COHORT_MEMBERSHIP } from "./protocols.js";

export interface FretMembershipSourceOptions {
	readonly membershipProtocol?: string;
	/** Cohort fan-out probed on a `fetch`. Default 16. */
	readonly wants?: number;
	readonly maxBytes?: number;
}

/**
 * FRET-backed {@link IMembershipSource}: cohort membership snapshots over
 * `/optimystic/cohort-topic/1.0.0/membership`. `current` serves the locally-cached encoded
 * `MembershipCertV1`; `fetch` forces one refresh by requesting the cert from an assembled cohort
 * member (the stale-cache retry the participant-side verifier drives). The host feeds inbound certs
 * into the cache via {@link cache}.
 */
export class FretMembershipSource implements IMembershipSource {
	private readonly byCoord = new Map<string, Uint8Array>();
	private readonly membershipProtocol: string;
	private readonly wants: number;
	private readonly maxBytes: number;

	constructor(private readonly node: Libp2p, private readonly resolver: CohortPeerResolver, options: FretMembershipSourceOptions = {}) {
		this.membershipProtocol = options.membershipProtocol ?? PROTOCOL_COHORT_MEMBERSHIP;
		this.wants = options.wants ?? 16;
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	}

	current(coord: RingCoord): Promise<Uint8Array | undefined> {
		return Promise.resolve(this.byCoord.get(bytesToB64url(coord)));
	}

	/**
	 * Synchronous local existence read over the in-memory cache: true iff a `MembershipCertV1` is cached for
	 * `coord` (no network I/O). The parent-reference bootstrap-evidence verifier's existence view consults
	 * this — an admission gate must never dial — so it reads the same `byCoord` map `current()` resolves from.
	 */
	has(coord: RingCoord): boolean {
		return this.byCoord.has(bytesToB64url(coord));
	}

	async fetch(coord: RingCoord): Promise<Uint8Array | undefined> {
		const request = coord; // the membership request frame is the raw coord bytes
		for (const peerStr of this.resolver.cohortPeers(coord, this.wants)) {
			try {
				const reply = await requestResponse(this.node, peerIdFromString(peerStr), this.membershipProtocol, request, this.maxBytes);
				if (reply.length > 0) {
					this.cache(coord, reply);
					return reply;
				}
			} catch {
				// Try the next member; a stale-cache refetch tolerates an unreachable holder.
			}
		}
		return undefined;
	}

	/** Cache an encoded cert for its coord (host feeds inbound/served certs here). */
	cache(coord: RingCoord, encodedCert: Uint8Array): void {
		this.byCoord.set(bytesToB64url(coord), encodedCert);
	}
}
