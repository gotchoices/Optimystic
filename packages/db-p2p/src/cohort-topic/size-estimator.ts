import type { ISizeEstimator } from "@optimystic/db-core";
import type { FretService } from "p2p-fret";

/**
 * FRET-backed {@link ISizeEstimator}: feeds `d_max` from FRET's network-size estimate
 * (`FretService.getNetworkSizeEstimate`). A clean, total binding — db-core's `d_max` computer applies
 * the low-confidence clamp itself, so this adapter only forwards FRET's `(size_estimate, confidence)`.
 */
export class FretSizeEstimator implements ISizeEstimator {
	constructor(private readonly fret: FretService) {}

	estimate(): { nEst: number; confidence: number } {
		const { size_estimate, confidence } = this.fret.getNetworkSizeEstimate();
		return { nEst: size_estimate, confidence };
	}
}
