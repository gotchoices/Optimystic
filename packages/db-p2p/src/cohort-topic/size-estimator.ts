import type { ISizeEstimator } from "@optimystic/db-core";
import { notWiredToFret } from "./not-implemented.js";

/**
 * FRET-backed {@link ISizeEstimator}: feeds `d_max` from FRET's network-size estimate. Stub for
 * now — the FRET binding lands in `cohort-topic-core-module-fret-integration`.
 */
export class FretSizeEstimator implements ISizeEstimator {
	estimate(): { nEst: number; confidence: number } {
		return notWiredToFret("FretSizeEstimator", "estimate");
	}
}
