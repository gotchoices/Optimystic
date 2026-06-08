import type { ICohortThresholdCrypto } from "@optimystic/db-core";
import { notWiredToFret } from "./not-implemented.js";

/**
 * FRET-backed {@link ICohortThresholdCrypto}: assembles / verifies cohort threshold signatures via
 * FRET's `minSigs = k − x` cohort-signature machinery, without modifying FRET. Stub for now — the
 * FRET binding lands in `cohort-topic-core-module-fret-integration`.
 */
export class FretCohortThresholdCrypto implements ICohortThresholdCrypto {
	assemble(_payload: Uint8Array, _minSigs: number): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> {
		return notWiredToFret("FretCohortThresholdCrypto", "assemble");
	}

	verify(_payload: Uint8Array, _thresholdSig: Uint8Array, _signers: readonly Uint8Array[]): boolean {
		return notWiredToFret("FretCohortThresholdCrypto", "verify");
	}
}
