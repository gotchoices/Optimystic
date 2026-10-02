import type { IMembershipPublishSink, RingCoord } from "@optimystic/db-core";
import { bytesToB64url } from "@optimystic/db-core";

/**
 * FRET-backed {@link IMembershipPublishSink}: holds, per cohort coordinate, the threshold-signed
 * `MembershipCertV1` (already encoded) this node last published for it, which the host's
 * `/optimystic/cohort-topic/1.0.0/membership` responder serves to a request naming that coordinate.
 * A node is in one cohort per coordinate it serves and publishes one cert for each, so a single
 * node-wide slot would answer a request for one cohort with whichever cohort published last.
 *
 * Entries are written only by a live coord engine and dropped with it ({@link forget}, on engine
 * eviction), so the map is no larger than the host's engine registry.
 */
export class FretMembershipPublishSink implements IMembershipPublishSink {
	private readonly byCoord = new Map<string, Uint8Array>();

	publish(coord: RingCoord, encodedCert: Uint8Array): void {
		this.byCoord.set(bytesToB64url(coord), encodedCert);
	}

	/** The encoded cert this node published for `coord`, or `undefined` if it has published none. */
	certFor(coord: RingCoord): Uint8Array | undefined {
		return this.byCoord.get(bytesToB64url(coord));
	}

	/** Stop serving `coord`'s cert (its engine is gone). */
	forget(coord: RingCoord): void {
		this.byCoord.delete(bytesToB64url(coord));
	}
}
