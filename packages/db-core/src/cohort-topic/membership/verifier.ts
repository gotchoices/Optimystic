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
	/**
	 * Number of **consecutive** gap-signalled refetches after which a **trust-locked** coord whose direct
	 * anchor has gone `"unknown"` re-enters the interim TOFU regime — the exit from a stale trust-lock a
	 * former cohort member would otherwise be stranded in until the host process restarts.
	 *
	 * The lock (a coord holding a *trusted* cached cert refuses any un-anchored refetch — no TOFU downgrade)
	 * has no other exit: a node that served coord `C`, self-published its cert (locking `C`), then left `C`'s
	 * cohort keeps distrusting every later-epoch message from `C` if it missed an intermediate rotation, since
	 * the refetched cert's `prevEpoch` no longer matches the stale cached epoch and the anchor no longer
	 * vouches for `C`. Recovery counts **only** refetched certs presenting an *explicit chain gap* — a full
	 * rotation attestation whose `prevEpoch ≠` the cached trusted epoch (the network provably rotated past the
	 * cached epoch through an epoch this node never witnessed). A forged rotation off the *current* cached
	 * predecessor (`prevEpoch == cachedEpoch`) never counts as a strike, so the lock's headline invariant
	 * (un-anchored successor of a matching predecessor stays rejected) is preserved.
	 *
	 * Defaults to `3`. Setting it to `0` (or a negative) **disables** recovery — which re-opens the stale-lock
	 * liveness bug, so leave it on unless a caller has an independent lock-drop mechanism (see the
	 * drop-the-lock-on-demotion tripwire in the ticket).
	 */
	staleGapRecoveryStrikes?: number;
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
	/**
	 * Per-coord count of *consecutive* gap-signalled refetches against a trust-locked coord (base64url key).
	 * Reset to zero whenever a message verifies for the coord (see {@link verifyMessage}); at
	 * {@link staleGapRecoveryStrikes} the lock is released back to TOFU (see {@link staleGapRecovery}).
	 */
	private readonly staleGapStrikes = new Map<string, number>();
	private readonly minSigs: number;
	private readonly anchor: IMembershipTrustAnchor;
	private readonly trustRoots: readonly NormalizedTrustRoot[];
	private readonly staleGapRecoveryStrikes: number;

	constructor(private readonly deps: MembershipVerifierDeps) {
		this.minSigs = deps.minSigs ?? DEFAULT_MIN_SIGS;
		this.anchor = deps.anchor ?? noAuthorityTrustAnchor;
		this.trustRoots = (deps.trustRoots ?? []).map(normalizeTrustRoot);
		this.staleGapRecoveryStrikes = deps.staleGapRecoveryStrikes ?? 3;
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
			this.staleGapStrikes.delete(coordKey); // a verify resets the consecutive stale-gap strike count
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
			this.staleGapStrikes.delete(coordKey); // a verify resets the consecutive stale-gap strike count
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
		const fallback = this.fallbackTrust(cert);
		if (fallback !== "reject") {
			return fallback; // first-use TOFU (coord not locked): no stale lock to recover from
		}
		// fallback === "reject" ⟺ the coord is trust-locked (holds a *trusted* cert) and this un-anchored cert
		// did not chain-verify — the state that strands a former cohort member forever. Consult the stale-gap
		// recovery counter, which releases the lock only on a demonstrated chain gap (never a forged rotation
		// off the current predecessor). See {@link staleGapRecovery}.
		return this.staleGapRecovery(cert);
	}

	/**
	 * Bounded re-TOFU recovery for a coord that is **trust-locked at a stale epoch it can no longer anchor**.
	 * Reached from {@link certIsTrusted} only when the coord already holds a *trusted* cached cert (locked),
	 * the direct anchor said `"unknown"`, and `cert` did not chain-verify — i.e. {@link fallbackTrust} would
	 * otherwise reject it forever. Runs on the *refetch* load only: a locked coord always holds a cached cert,
	 * so `verifyMessage` never routes it through the `source.current()` seed path, and the strike logic keys on
	 * "coord is locked", so `current()` never accrues a strike.
	 *
	 * NOTE: recovery fires **only** on a demonstrated chain gap — a full rotation attestation whose
	 * `prevEpoch ≠` the cached trusted epoch (proof the network rotated past the cached epoch through at least
	 * one epoch this node never witnessed). A forged rotation off the *current* cached predecessor
	 * (`prevEpoch == cachedEpoch`) is NOT a gap, never counts as a strike, and stays rejected no matter how
	 * often it is presented — that is the lock's headline invariant. After
	 * {@link staleGapRecoveryStrikes} *consecutive* gap-signalled strikes the lock is released back to TOFU
	 * (returns `"tofu"`, so {@link loadFrom} re-caches the cert as **untrusted** — a re-TOFU'd cert must never
	 * launder trust into a rotation), which is no weaker than the documented TOFU baseline: a former member
	 * returns to the same regime a never-member is already in. Strikes accrue only on refetches that actually
	 * reach the source, so a {@link RefetchBound}-suppressed refetch observes no cert and recovery paces itself
	 * with the (bounded) refetch rate — intended, do not "fix" that pacing.
	 */
	private staleGapRecovery(cert: MembershipCertV1): CertTrust {
		const coordKey = cert.cohortCoord;
		const locked = this.byCoord.get(coordKey);
		// Recovery-eligible only on an explicit rotation gap: a full attestation whose prevEpoch is neither the
		// cert's own epoch (a self-referential rotation) nor the cached trusted epoch (a forgery off the current
		// predecessor — the case the lock exists to reject).
		const isGap =
			this.staleGapRecoveryStrikes > 0 &&
			locked !== undefined &&
			this.hasRotationAttestation(cert) &&
			cert.prevEpoch !== cert.cohortEpoch &&
			cert.prevEpoch !== locked.cert.cohortEpoch;
		if (!isGap) {
			return "reject"; // not a recovery-eligible gap → stay locked, exactly as before
		}
		const strikes = (this.staleGapStrikes.get(coordKey) ?? 0) + 1;
		if (strikes < this.staleGapRecoveryStrikes) {
			this.staleGapStrikes.set(coordKey, strikes);
			return "reject"; // below threshold: keep rejecting; the inbound message stays untrusted
		}
		// Threshold reached: release the lock. `loadFrom` re-caches this cert as untrusted (`trusted: false`),
		// and the message-verify retry runs against it, so the inbound later-epoch message finally verifies.
		this.staleGapStrikes.delete(coordKey);
		return "tofu";
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
