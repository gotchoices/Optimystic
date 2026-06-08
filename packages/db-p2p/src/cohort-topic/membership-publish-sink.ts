import type { IMembershipPublishSink } from "@optimystic/db-core";
import { notWiredToFret } from "./not-implemented.js";

/**
 * FRET-backed {@link IMembershipPublishSink}: serves/advertises the cohort's threshold-signed
 * `MembershipCertV1` over FRET's `/membership` protocol. Stub for now — the FRET binding lands in
 * `cohort-topic-core-module-fret-integration`.
 */
export class FretMembershipPublishSink implements IMembershipPublishSink {
	publish(_encodedCert: Uint8Array): void {
		notWiredToFret("FretMembershipPublishSink", "publish");
	}
}
