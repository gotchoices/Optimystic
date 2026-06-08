import type { ICohortThresholdCrypto } from "@optimystic/db-core";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * **Interim** {@link ICohortThresholdCrypto}.
 *
 * The real binding assembles a `minSigs = k − x` cohort threshold signature over FRET's two-sided
 * cohort-signature machinery — collecting signatures from a quorum of the assembled cohort. That is a
 * multi-round cohort operation and is the documented remaining gap for live-tier e2e
 * (`docs/architecture.md` Doc Sync Status: *cohort-topic substrate = implemented, mock-tier e2e
 * pending*). Until it lands, this adapter produces a single-signer, content-addressed digest so the
 * host composes and the mock-tier flow runs; it is **not** a quorum signature and must not be relied
 * on for trust.
 *
 * `assemble` returns `{ thresholdSig: sha256(payload), signers: [self] }`; `verify` recomputes the
 * digest. The db-core `CohortSigner.verifyThreshold` layer additionally enforces the `≥ minSigs`
 * distinct-member rule on top of this — which a single signer cannot satisfy at the production
 * `minSigs = 14`, exactly why this is interim-only.
 */
export class FretCohortThresholdCrypto implements ICohortThresholdCrypto {
	constructor(private readonly self: Uint8Array) {}

	assemble(payload: Uint8Array, _minSigs: number): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> {
		return Promise.resolve({ thresholdSig: sha256(payload), signers: [this.self] });
	}

	verify(payload: Uint8Array, thresholdSig: Uint8Array, _signers: readonly Uint8Array[]): boolean {
		const expected = sha256(payload);
		if (expected.length !== thresholdSig.length) {
			return false;
		}
		for (let i = 0; i < expected.length; i++) {
			if (expected[i] !== thresholdSig[i]) {
				return false;
			}
		}
		return true;
	}
}
