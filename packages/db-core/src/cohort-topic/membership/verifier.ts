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
	 *
	 * `opts` bounds the network amplification a flood-exposed caller (the `promote` handler) can suffer:
	 * when **both** `minRefetchIntervalMs` and `now` are given, the stale-cert `source.fetch()` retry is
	 * **rate-limited per coord** — at most one refetch per coord per interval — so a stream of verify-misses
	 * (e.g. forged notices) drives a bounded membership-fetch rate rather than one dial per message.
	 * Eventual refetch is *preserved*: a cold cache or a membership rotation still re-fetches once the
	 * interval elapses (unlike outright suppression). Omit `opts` (the default, and every existing caller)
	 * for the unbounded exactly-one-refetch behavior.
	 */
	verifyMessage(signers: readonly Uint8Array[], expectedCoord: RingCoord, tier: number, payload: Uint8Array, sig: Uint8Array, opts?: RefetchBound): Promise<VerifyResult>;
}

/**
 * Caller-supplied bound on the membership-cert refetch rate (anti-amplification on a flood-exposed verify
 * path). Both fields are required to take effect; omit either for unbounded refetch.
 */
export interface RefetchBound {
	/** Minimum wall-clock gap (ms) between `source.fetch()` refetches for the same coord. */
	readonly minRefetchIntervalMs?: number;
	/** Current wall clock (ms) for the interval comparison. */
	readonly now?: number;
}

export interface MembershipVerifierDeps {
	signer: CohortSigner;
	router: IMembershipSourceRouter;
	minSigs?: number;
	maxMessageBytes?: number;
}

class CachingMembershipVerifier implements MembershipVerifier {
	private readonly byCoord = new Map<string, MembershipCertV1>();
	/** Per-coord timestamp of the last `source.fetch()` attempt (the rate-limit clock for {@link RefetchBound}). */
	private readonly lastFetchAt = new Map<string, number>();
	private readonly minSigs: number;

	constructor(private readonly deps: MembershipVerifierDeps) {
		this.minSigs = deps.minSigs ?? DEFAULT_MIN_SIGS;
	}

	cache(cert: MembershipCertV1): void {
		this.byCoord.set(cert.cohortCoord, cert);
	}

	async verifyMessage(signers: readonly Uint8Array[], expectedCoord: RingCoord, tier: number, payload: Uint8Array, sig: Uint8Array, opts?: RefetchBound): Promise<VerifyResult> {
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

		// Single fetch-and-retry: a stale or missing cert forces a network refresh. A flood-exposed caller
		// (the ungated `promote` handler) bounds the amplification via {@link RefetchBound}: the refetch is
		// then rate-limited to at most one per coord per interval, so a stream of verify-misses (forged
		// notices) cannot turn into a storm of membership dials. Eventual refetch survives — a cold cache or a
		// membership rotation still refreshes once the interval elapses.
		if (!this.refetchAllowed(coordKey, opts)) {
			return "untrusted";
		}
		const refreshed = await this.loadFrom(source.fetch(expectedCoord));
		if (refreshed !== undefined && this.messageVerifies(refreshed, signers, payload, sig)) {
			return "verified";
		}
		return "untrusted";
	}

	/**
	 * Whether a `source.fetch()` refetch is permitted for `coordKey` now. Unbounded (always `true`) unless
	 * the caller supplies both `minRefetchIntervalMs` and `now`, in which case at most one refetch per coord
	 * per interval is allowed — the per-coord fetch-rate bound that caps flood amplification. Records the
	 * attempt time when it returns `true` (the dial is about to happen).
	 */
	private refetchAllowed(coordKey: string, opts?: RefetchBound): boolean {
		const minInterval = opts?.minRefetchIntervalMs;
		const now = opts?.now;
		if (minInterval === undefined || now === undefined) {
			return true;
		}
		const last = this.lastFetchAt.get(coordKey);
		if (last !== undefined && now - last < minInterval) {
			return false;
		}
		this.lastFetchAt.set(coordKey, now);
		return true;
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
		// `signers` is validated only as a string array (not per-element base64url), so `b64urlToBytes`
		// below may throw `CohortWireError` on a malformed signer — `loadFrom`'s try/catch turns that
		// into "no cert" rather than letting it escape.
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
