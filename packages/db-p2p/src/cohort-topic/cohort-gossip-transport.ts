import type { ICohortGossipTransport, PeerRef, RingCoord } from "@optimystic/db-core";
import { notWiredToFret } from "./not-implemented.js";

/**
 * FRET-backed {@link ICohortGossipTransport}: broadcasts and receives intra-cohort gossip over
 * FRET's cohort-gossip channel (`/optimystic/cohort-topic/1.0.0/cohort-gossip`). Stub for now —
 * the FRET binding lands in `cohort-topic-core-module-fret-integration`.
 */
export class FretCohortGossipTransport implements ICohortGossipTransport {
	broadcast(_coord: RingCoord, _msg: Uint8Array): void {
		notWiredToFret("FretCohortGossipTransport", "broadcast");
	}

	onMessage(_handler: (from: PeerRef, msg: Uint8Array) => void): () => void {
		return notWiredToFret("FretCohortGossipTransport", "onMessage");
	}
}
