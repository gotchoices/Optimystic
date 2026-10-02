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

import type { ICohortThresholdCrypto, RootPlacement } from "../ports.js";
import { bytesToB64url } from "../wire/codec.js";
import type { MembershipCertV1 } from "../wire/types.js";

/** Default cohort-signature threshold, `k − x` (see §Configuration). The rule for every coord that is not root-placed. */
export const DEFAULT_MIN_SIGS = 14;

/**
 * Build the {@link RootPlacement} for a root-placed cohort from this node's own quorum ratio. A ratio
 * outside `(0, 1]` (or not a number) is a configuration error and throws here, at construction, so
 * verification never has to judge a malformed rule.
 */
export function createRootPlacement(quorumRatio: number): RootPlacement {
	if (!(quorumRatio > 0 && quorumRatio <= 1)) {
		throw new RangeError(`root placement quorumRatio must be in (0, 1], got ${quorumRatio}`);
	}
	return { quorumRatio };
}

/**
 * Signature threshold of a root-placed cohort of `memberCount` members: `ceil(memberCount × quorumRatio)`.
 *
 * This is the formula `captureCommitCert` (`packages/db-p2p/src/cluster/cluster-repo.ts`) applies to a
 * storage group's commit certificate — `ceil(|group| × superMajorityThreshold)` — written the same way on
 * purpose (same multiplication, same rounding), so a commit certificate and a verifier given the same ratio
 * agree on the threshold by construction. One member needs 1; four members at `0.75` need 3.
 *
 * The floor of 1 only matters for an empty member list, where the formula would yield 0 and "no signers"
 * would count as a quorum; with it, a cert naming no members can never verify.
 */
export function rootPlacedMinSigs(memberCount: number, placement: RootPlacement): number {
	return Math.max(1, Math.ceil(memberCount * placement.quorumRatio));
}

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
	constructor(private readonly crypto: ICohortThresholdCrypto, private readonly minSigsNow: () => number) {}

	thresholdSign(payload: Uint8Array): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> {
		return this.crypto.assemble(payload, this.minSigsNow());
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

/**
 * Build a {@link CohortSigner} over the FRET-backed (in db-p2p) threshold crypto. `minSigs` is the assembly
 * threshold: a number for a cohort whose threshold is fixed (the node-wide `k − x`), or a function read at
 * each signing for one whose threshold follows its member count (a root-placed cohort under
 * {@link rootPlacedMinSigs}). Verification takes its threshold as an argument either way.
 */
export function createCohortSigner(crypto: ICohortThresholdCrypto, minSigs: number | (() => number) = DEFAULT_MIN_SIGS): CohortSigner {
	return new CryptoCohortSigner(crypto, typeof minSigs === "number" ? (): number => minSigs : minSigs);
}
