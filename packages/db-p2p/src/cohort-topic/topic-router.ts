import type { ITopicRouter, PeerRef, RingCoord } from "@optimystic/db-core";
import { notWiredToFret } from "./not-implemented.js";

/**
 * FRET-backed {@link ITopicRouter}: maps `routeAndAct` onto FRET's `RouteAndMaybeAct`
 * (`registerMaybeAct` / `sendMaybeAct`) and `dialMember` onto a direct libp2p dial to a cached
 * primary. Stub for now — the FRET binding lands in `cohort-topic-core-module-fret-integration`.
 */
export class FretTopicRouter implements ITopicRouter {
	routeAndAct(_key: RingCoord, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }): Promise<Uint8Array> {
		return notWiredToFret("FretTopicRouter", "routeAndAct");
	}

	dialMember(_member: PeerRef, _activity: Uint8Array): Promise<Uint8Array> {
		return notWiredToFret("FretTopicRouter", "dialMember");
	}
}
