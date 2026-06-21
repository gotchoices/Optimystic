/**
 * Cohort-topic substrate — participant-side membership verification with a trust-anchor gate.
 *
 * Per `docs/cohort-topic.md` §Membership snapshots and §Bootstrapping trust. A participant verifying
 * a threshold-signed message:
 *
 * 1. takes the message's `signers`, the cohort `coord` the signers should belong to, and the tier;
 * 2. looks up the cached `MembershipCertV1` for that coord (or pulls the source's `current`);
 * 3. checks the signers are a `≥ minSigs` subset of the cert's members and the signature verifies;
 * 4. **on failure against a cached/stale cert, re-fetches the cert from any cohort member exactly
 *    once and retries**; still failing → the message is untrusted.
 *
 * **Trust anchoring (the gate this module adds).** Self-consistency (a cert's own threshold signature
 * is a `≥ minSigs` quorum over its own `members`) proves only internal well-formedness — *not* that the
 * attesting key set is the legitimate cohort for the coord. An adversary controlling `k − x` keys could
 * mint a self-consistent cert over a coord it does not own. So before a (re)fetched cert is believed,
 * {@link CachingMembershipVerifier.certIsTrusted} requires it to be self-consistent **AND** anchored by
 * at least one of:
 *
 * - **Trust root** — `(coord, epoch, member-set)` is in the out-of-band-seeded {@link TrustRoot} set
 *   (the genesis-block cohorts). Base case of every chain; checked before the direct anchor, so a
 *   configured root is authoritative.
 * - **Direct anchor** — the injected {@link IMembershipTrustAnchor} vouches for the binding from a
 *   source the node directly trusts (FRET ring agreement / tx-log commit cert, bound in db-p2p). A
 *   `"rejected"` verdict is **fatal** (a forgery, even if self-consistent) and overrides the fallback.
 * - **Attestation chain** — a cert carrying a rotation attestation (`prevEpoch`/`rotationSig`/
 *   `rotationSigners`) inherits trust when the node already holds a **trusted** predecessor for the same
 *   coord at `prevEpoch` whose members form a `≥ minSigs` quorum over this cert's signing payload.
 *
 * **Interim TOFU fallback (documented limit).** For a coord the node cannot anchor (the direct anchor
 * returns `"unknown"` and there is no trust root / chain) and that has **no trusted cert yet**, the
 * verifier falls back to trust-on-first-use of any self-consistent cert — identical to the pre-anchor
 * behavior, so there is strictly no regression on coords no node can verify today (distant T2/T3, and
 * T0/T1 until the committed-index binding lands). Once a coord *does* hold a trusted cert, the chain
 * governs successors: an un-anchored cert for an already-trusted coord is rejected (no TOFU downgrade),
 * which is what gives the rotation chain its teeth. The FRET / tx-log direct-anchor bindings that close
 * the remaining TOFU gap are tracked in `cohort-topic-trust-anchor-fret-binding` and the backlog
 * `...-fret-stabilization-proof` / `...-txlog-committed-binding` tickets.
 *
 * **Deviation from the ticket sketch (documented):** `verifyMessage` takes the cohort `tier`. A coord
 * is an opaque hash, so the T0/T1-vs-T2/T3 source dispatch the same ticket mandates cannot be derived
 * from the coord alone; the caller already knows the tier (it computed the coord from the message's
 * claimed tier/topic). The `tier` is threaded into the gate so the direct anchor is consulted with the
 * same tier the router used (the binding is tier-scoped).
 */

import type { IMembershipTrustAnchor, RingCoord, TrustRoot } from "../ports.js";
import { noAuthorityTrustAnchor } from "../ports.js";
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
	/**
	 * Direct (base-case) trust anchor for a cert's `coord → keyset` binding. Defaults to
	 * {@link noAuthorityTrustAnchor} (every coord `"unknown"`), which preserves the interim TOFU behavior.
	 * db-p2p injects the FRET-ring-backed anchor.
	 */
	anchor?: IMembershipTrustAnchor;
	/** Out-of-band-seeded genesis trust roots (the base case of every attestation chain). Defaults to `[]`. */
	trustRoots?: readonly TrustRoot[];
}

/** Result of the trust gate: accept as a trusted anchor, accept as interim TOFU, or reject outright. */
type CertTrust = "trusted" | "tofu" | "reject";

/** A cached cert and whether it is *trusted* (may serve as an attestation-chain predecessor). */
interface CachedCert {
	cert: MembershipCertV1;
	/** True only when the cert passed via trust-root / direct-anchor / chain, or was self-published (`cache`). */
	trusted: boolean;
}

/** A {@link TrustRoot} pre-normalized to the cert's base64url form for cheap matching. */
interface NormalizedTrustRoot {
	coord: string;
	epoch: string;
	members: ReadonlySet<string>;
}

class CachingMembershipVerifier implements MembershipVerifier {
	private readonly byCoord = new Map<string, CachedCert>();
	/** Per-coord timestamp of the last `source.fetch()` attempt (the rate-limit clock for {@link RefetchBound}). */
	private readonly lastFetchAt = new Map<string, number>();
	private readonly minSigs: number;
	private readonly anchor: IMembershipTrustAnchor;
	private readonly trustRoots: readonly NormalizedTrustRoot[];

	constructor(private readonly deps: MembershipVerifierDeps) {
		this.minSigs = deps.minSigs ?? DEFAULT_MIN_SIGS;
		this.anchor = deps.anchor ?? noAuthorityTrustAnchor;
		this.trustRoots = (deps.trustRoots ?? []).map(normalizeTrustRoot);
	}

	cache(cert: MembershipCertV1): void {
		// The public cache feeds this node its OWN freshly-published cert — a node trusts a cert it itself
		// published, so it is marked trusted and may anchor the next rotation in the attestation chain.
		this.byCoord.set(cert.cohortCoord, { cert, trusted: true });
	}

	async verifyMessage(signers: readonly Uint8Array[], expectedCoord: RingCoord, tier: number, payload: Uint8Array, sig: Uint8Array, opts?: RefetchBound): Promise<VerifyResult> {
		const coordKey = bytesToB64url(expectedCoord);
		const source = this.deps.router.for(tier);

		// Seed from the cheap cached view if we hold nothing yet. A cached cert already passed the gate when
		// it was loaded (or was self-published via `cache`), so it is used directly for message verification.
		let cert = this.byCoord.get(coordKey)?.cert;
		if (cert === undefined) {
			cert = await this.loadFrom(source.current(expectedCoord), tier);
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
		const refreshed = await this.loadFrom(source.fetch(expectedCoord), tier);
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

	/**
	 * Decode an encoded cert, run it through the trust gate, cache it (with its trusted status), and return
	 * it for message verification; `undefined` if absent, malformed, or rejected by the gate. A rejected
	 * cert (failed self-consistency, a `"rejected"` direct anchor, or an un-anchored cert for an
	 * already-trusted coord) is treated exactly like an absent cert, so the single refetch still fires.
	 */
	private async loadFrom(pending: Promise<Uint8Array | undefined>, tier: number): Promise<MembershipCertV1 | undefined> {
		const encoded = await pending;
		if (encoded === undefined) {
			return undefined;
		}
		let cert: MembershipCertV1;
		let trust: CertTrust;
		try {
			cert = decodeMembershipCertV1(encoded, this.deps.maxMessageBytes);
			trust = this.certIsTrusted(cert, tier);
		} catch (err) {
			if (err instanceof CohortWireError) {
				return undefined; // a malformed cert (or non-base64url signer) is treated as no cert
			}
			throw err;
		}
		if (trust === "reject") {
			return undefined;
		}
		// Only a `"trusted"` cert may anchor a successor in the attestation chain; a `"tofu"` cert is cached
		// for message verification but must never launder trust into a rotation.
		this.byCoord.set(cert.cohortCoord, { cert, trusted: trust === "trusted" });
		return cert;
	}

	/**
	 * The trust gate (see the module header). A cert is accepted iff it is self-consistent **and** anchored
	 * by a trust root, the direct anchor, or the attestation chain; otherwise it falls to the interim TOFU
	 * fallback (first-use only). Returns whether the cert is a trusted anchor (`"trusted"`), an interim
	 * TOFU acceptance (`"tofu"`), or rejected (`"reject"`).
	 */
	private certIsTrusted(cert: MembershipCertV1, tier: number): CertTrust {
		if (!this.certIsSelfConsistent(cert)) {
			return "reject"; // internal well-formedness is the precondition for any trust path
		}
		if (this.matchesTrustRoot(cert)) {
			return "trusted"; // a configured genesis root is authoritative, checked before the direct anchor
		}
		const verdict = this.anchor.directAnchor(cert, tier);
		if (verdict === "anchored") {
			return "trusted";
		}
		if (verdict === "rejected") {
			return "reject"; // a contradicted binding is a forgery — fatal, overrides the TOFU fallback
		}
		// verdict === "unknown": no local authority for this coord. Try the attestation chain, else fall back.
		if (this.hasRotationAttestation(cert) && this.chainGrantsTrust(cert)) {
			return "trusted";
		}
		return this.fallbackTrust(cert);
	}

	/**
	 * The interim fallback for a coord with no trust-root / anchor / chain coverage. Trust-on-first-use:
	 * accept a self-consistent cert when the coord holds **no trusted cert yet**, preserving the pre-anchor
	 * behavior on coords no node can verify today. But once a coord *is* trust-established, an un-anchored
	 * cert (a failed/absent rotation, including a forged rotation off a trusted predecessor) is **rejected**
	 * — no silent TOFU downgrade — which is what gives the attestation chain its teeth.
	 */
	private fallbackTrust(cert: MembershipCertV1): CertTrust {
		return this.byCoord.get(cert.cohortCoord)?.trusted ? "reject" : "tofu";
	}

	/** Whether a cert carries a full rotation attestation (all three fields; validated all-or-nothing on the wire). */
	private hasRotationAttestation(cert: MembershipCertV1): boolean {
		return cert.prevEpoch !== undefined && cert.rotationSig !== undefined && cert.rotationSigners !== undefined;
	}

	/**
	 * Whether `cert`'s rotation attestation is valid: a **trusted** predecessor for the same coord is cached
	 * at `prevEpoch`, the rotation is not self-referential, and the predecessor's members form a `≥ minSigs`
	 * quorum over this cert's signing payload via `rotationSig`. A predecessor that only reached the cache via
	 * TOFU (not trusted) must not anchor the successor — the trusted-cache invariant.
	 */
	private chainGrantsTrust(cert: MembershipCertV1): boolean {
		const prevEpoch = cert.prevEpoch!;
		if (prevEpoch === cert.cohortEpoch) {
			return false; // a cert cannot rotate from itself
		}
		const predecessor = this.byCoord.get(cert.cohortCoord);
		if (predecessor === undefined || !predecessor.trusted || predecessor.cert.cohortEpoch !== prevEpoch) {
			return false;
		}
		// `rotationSigners` is validated only as a string array, so `b64urlToBytes` may throw `CohortWireError`
		// on a malformed signer — `loadFrom`'s try/catch turns that into "no cert", as for `certIsSelfConsistent`.
		return this.deps.signer.verifyThreshold(
			membershipCertSigningPayload(cert),
			b64urlToBytes(cert.rotationSig!),
			cert.rotationSigners!.map((s) => b64urlToBytes(s)),
			predecessor.cert,
			this.minSigs,
		);
	}

	/** Whether `cert` matches a configured trust root by `(coord, epoch)` and an order-independent member set. */
	private matchesTrustRoot(cert: MembershipCertV1): boolean {
		for (const root of this.trustRoots) {
			if (root.coord === cert.cohortCoord && root.epoch === cert.cohortEpoch && setEqualsArray(root.members, cert.members)) {
				return true;
			}
		}
		return false;
	}

	/** A cert is self-consistent only if its own threshold signature is a valid quorum of its members. */
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

/** Pre-normalize a {@link TrustRoot} (raw bytes) to the cert's base64url form for cheap matching. */
function normalizeTrustRoot(root: TrustRoot): NormalizedTrustRoot {
	return {
		coord: bytesToB64url(root.coord),
		epoch: bytesToB64url(root.epoch),
		members: new Set(root.members.map(bytesToB64url)),
	};
}

/** Order-independent set equality between a trust-root member set and a cert's member array (duplicate-safe). */
function setEqualsArray(set: ReadonlySet<string>, members: readonly string[]): boolean {
	const seen = new Set<string>();
	for (const m of members) {
		if (!set.has(m)) {
			return false; // a member not in the root → not a root match
		}
		seen.add(m);
	}
	// Cover both directions: every distinct cert member is in the root AND every root member is covered,
	// so a duplicate-inflated member list cannot masquerade as a full-set match.
	return seen.size === set.size;
}

/** Build a participant-side {@link MembershipVerifier}. */
export function createMembershipVerifier(deps: MembershipVerifierDeps): MembershipVerifier {
	return new CachingMembershipVerifier(deps);
}
