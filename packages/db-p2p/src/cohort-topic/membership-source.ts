import type { IMembershipSource, RingCoord } from "@optimystic/db-core";
import { notWiredToFret } from "./not-implemented.js";

/**
 * FRET-backed {@link IMembershipSource}: serves cohort membership snapshots from FRET's
 * `MembershipCertV1` / stabilization machinery (`/optimystic/cohort-topic/1.0.0/membership`).
 * Stub for now — the FRET binding lands in `cohort-topic-core-module-fret-integration`.
 */
export class FretMembershipSource implements IMembershipSource {
	current(_coord: RingCoord): Promise<Uint8Array | undefined> {
		return notWiredToFret("FretMembershipSource", "current");
	}

	fetch(_coord: RingCoord): Promise<Uint8Array | undefined> {
		return notWiredToFret("FretMembershipSource", "fetch");
	}
}
