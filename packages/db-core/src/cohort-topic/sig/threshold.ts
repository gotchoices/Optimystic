/**
 * Cohort-topic substrate — `k − x` threshold signing and verification.
 *
 * Per `docs/cohort-topic.md` §FRET integration (L659) and §Membership snapshots: the cohort
 * threshold-signs `PromotionNoticeV1` / `DemotionNoticeV1` / `MembershipCertV1` with `minSigs`
 * (= `k − x`, default 14) signers. This module is db-core logic over the {@link ICohortThresholdCrypto}
 * port; db-p2p binds the port to FRET's `minSigs` cohort-signature assembly — db-core never imports
 * FRET, and the underlying scheme is reused unchanged.
 *
 * {@link CohortSigner.verifyThreshold} layers the membership check db-core owns on top of the raw
 * crypto: the `signers` must be a distinct `≥ minSigs` subset of the certificate's `members`, *and*
 * the signature must verify against the payload. Either failure → not verified.
 */

import type { ICohortThresholdCrypto } from "../ports.js";
import { bytesToB64url } from "../wire/codec.js";
import type { MembershipCertV1 } from "../wire/types.js";

/** Default cohort-signature threshold, `k − x` (see §Configuration). */
export const DEFAULT_MIN_SIGS = 14;

/** Threshold signer/verifier over the injected cohort crypto. Peer ids are raw bytes. */
export interface CohortSigner {
	/** Assemble a cohort threshold signature over `payload` (collects `minSigs` signers). */
	thresholdSign(payload: Uint8Array): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }>;
	/**
	 * Verify a threshold-signed message: `signers` are a distinct `≥ minSigs` subset of
	 * `cert.members` and `sig` is a valid cohort signature over `payload`.
	 */
	verifyThreshold(payload: Uint8Array, sig: Uint8Array, signers: readonly Uint8Array[], cert: MembershipCertV1, minSigs: number): boolean;
}

class CryptoCohortSigner implements CohortSigner {
	constructor(private readonly crypto: ICohortThresholdCrypto, private readonly minSigs: number) {}

	thresholdSign(payload: Uint8Array): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> {
		return this.crypto.assemble(payload, this.minSigs);
	}

	verifyThreshold(payload: Uint8Array, sig: Uint8Array, signers: readonly Uint8Array[], cert: MembershipCertV1, minSigs: number): boolean {
		if (signers.length < minSigs) {
			return false;
		}
		// Members are base64url on the wire; compare signers in that same canonical form.
		const memberSet = new Set(cert.members);
		const seen = new Set<string>();
		for (const signer of signers) {
			const key = bytesToB64url(signer);
			if (seen.has(key)) {
				return false; // a duplicated signer cannot pad the count toward minSigs
			}
			seen.add(key);
			if (!memberSet.has(key)) {
				return false; // signer is not a member of the attested cohort
			}
		}
		return this.crypto.verify(payload, sig, signers);
	}
}

/** Build a {@link CohortSigner} over the FRET-backed (in db-p2p) threshold crypto. */
export function createCohortSigner(crypto: ICohortThresholdCrypto, minSigs: number = DEFAULT_MIN_SIGS): CohortSigner {
	return new CryptoCohortSigner(crypto, minSigs);
}
