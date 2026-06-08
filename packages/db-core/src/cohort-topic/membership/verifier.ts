/**
 * Cohort-topic substrate — participant-side membership verification.
 *
 * Per `docs/cohort-topic.md` §Membership snapshots and §Failure modes (L427). A participant
 * verifying a threshold-signed message:
 *
 * 1. takes the message's `signers`, the cohort `coord` the signers should belong to, and the tier;
 * 2. looks up the cached `MembershipCertV1` for that coord (or pulls the source's `current`);
 * 3. checks the signers are a `≥ minSigs` subset of the cert's members and the signature verifies;
 * 4. **on failure against a cached/stale cert, re-fetches the cert from any cohort member exactly
 *    once and retries**; still failing → the message is untrusted.
 *
 * A freshly fetched cert is itself validated (self-consistent quorum signature over its own members)
 * before it is trusted and cached. Chain-to-genesis validation is bootstrapping-trust territory
 * (§Bootstrapping trust) and is out of scope here.
 *
 * **Deviation from the ticket sketch (documented):** `verifyMessage` takes the cohort `tier`. A coord
 * is an opaque hash, so the T0/T1-vs-T2/T3 source dispatch the same ticket mandates cannot be derived
 * from the coord alone; the caller already knows the tier (it computed the coord from the message's
 * claimed tier/topic).
 */

import type { RingCoord } from "../ports.js";
import { b64urlToBytes, bytesToB64url, decodeMembershipCertV1 } from "../wire/codec.js";
import { CohortWireError } from "../wire/validate.js";
import type { MembershipCertV1 } from "../wire/types.js";
import { DEFAULT_MIN_SIGS, type CohortSigner } from "../sig/threshold.js";
import { membershipCertSigningPayload } from "../sig/payloads.js";
import type { IMembershipSourceRouter } from "./source.js";

/** Outcome of verifying a threshold-signed message against cohort membership. */
export type VerifyResult = "verified" | "untrusted";

/** Caches certs per coord and verifies threshold-signed messages with one stale-cert refetch. */
export interface MembershipVerifier {
	/** Cache `cert` as the latest known membership for its coord. */
	cache(cert: MembershipCertV1): void;
	/**
	 * Verify a threshold-signed message. `expectedCoord` is the cohort the `signers` should belong to;
	 * `tier` selects the membership source. Performs the single refetch+retry internally.
	 */
	verifyMessage(signers: readonly Uint8Array[], expectedCoord: RingCoord, tier: number, payload: Uint8Array, sig: Uint8Array): Promise<VerifyResult>;
}

export interface MembershipVerifierDeps {
	signer: CohortSigner;
	router: IMembershipSourceRouter;
	minSigs?: number;
	maxMessageBytes?: number;
}

class CachingMembershipVerifier implements MembershipVerifier {
	private readonly byCoord = new Map<string, MembershipCertV1>();
	private readonly minSigs: number;

	constructor(private readonly deps: MembershipVerifierDeps) {
		this.minSigs = deps.minSigs ?? DEFAULT_MIN_SIGS;
	}

	cache(cert: MembershipCertV1): void {
		this.byCoord.set(cert.cohortCoord, cert);
	}

	async verifyMessage(signers: readonly Uint8Array[], expectedCoord: RingCoord, tier: number, payload: Uint8Array, sig: Uint8Array): Promise<VerifyResult> {
		const coordKey = bytesToB64url(expectedCoord);
		const source = this.deps.router.for(tier);

		// Seed from the cheap cached view if we hold nothing yet.
		let cert = this.byCoord.get(coordKey);
		if (cert === undefined) {
			cert = await this.loadFrom(source.current(expectedCoord));
		}
		if (cert !== undefined && this.messageVerifies(cert, signers, payload, sig)) {
			return "verified";
		}

		// Single fetch-and-retry: a stale or missing cert forces exactly one network refresh.
		const refreshed = await this.loadFrom(source.fetch(expectedCoord));
		if (refreshed !== undefined && this.messageVerifies(refreshed, signers, payload, sig)) {
			return "verified";
		}
		return "untrusted";
	}

	/** Decode + self-validate an encoded cert, caching and returning it; `undefined` if absent/invalid. */
	private async loadFrom(pending: Promise<Uint8Array | undefined>): Promise<MembershipCertV1 | undefined> {
		const encoded = await pending;
		if (encoded === undefined) {
			return undefined;
		}
		let cert: MembershipCertV1;
		let selfConsistent: boolean;
		try {
			cert = decodeMembershipCertV1(encoded, this.deps.maxMessageBytes);
			selfConsistent = this.certIsSelfConsistent(cert);
		} catch (err) {
			if (err instanceof CohortWireError) {
				return undefined; // a malformed cert (or non-base64url signer) is treated as no cert
			}
			throw err;
		}
		if (!selfConsistent) {
			return undefined;
		}
		this.cache(cert);
		return cert;
	}

	/** A cert is trustworthy only if its own threshold signature is a valid quorum of its members. */
	private certIsSelfConsistent(cert: MembershipCertV1): boolean {
		// Decode succeeds here: the cert came through the validating codec, so its byte fields are base64url.
		return this.deps.signer.verifyThreshold(
			membershipCertSigningPayload(cert),
			b64urlToBytes(cert.thresholdSig),
			cert.signers.map((s) => b64urlToBytes(s)),
			cert,
			this.minSigs,
		);
	}

	private messageVerifies(cert: MembershipCertV1, signers: readonly Uint8Array[], payload: Uint8Array, sig: Uint8Array): boolean {
		return this.deps.signer.verifyThreshold(payload, sig, signers, cert, this.minSigs);
	}
}

/** Build a participant-side {@link MembershipVerifier}. */
export function createMembershipVerifier(deps: MembershipVerifierDeps): MembershipVerifier {
	return new CachingMembershipVerifier(deps);
}
