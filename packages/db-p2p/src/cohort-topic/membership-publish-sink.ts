import type { IMembershipPublishSink } from "@optimystic/db-core";

/**
 * FRET-backed {@link IMembershipPublishSink}: holds the cohort's latest threshold-signed
 * `MembershipCertV1` (already encoded) and serves it over `/optimystic/cohort-topic/1.0.0/membership`.
 * A node publishes only its own cohort's cert, so the most-recent encoded cert is all the host's
 * membership protocol handler needs to answer inbound requests.
 */
export class FretMembershipPublishSink implements IMembershipPublishSink {
	private latestCert: Uint8Array | undefined;

	publish(encodedCert: Uint8Array): void {
		this.latestCert = encodedCert;
	}

	/** The most recently published encoded cert, or `undefined` if none yet (host serves this). */
	latest(): Uint8Array | undefined {
		return this.latestCert;
	}
}
